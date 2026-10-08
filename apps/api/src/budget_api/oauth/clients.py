"""Who may register, and where an authorization response may be sent.

Registration here is OPEN (RFC 7591 dynamic client registration, no software
statement): claude.ai, Claude Desktop, Claude Code and the mobile app each
register themselves, and there is no out-of-band step a user could be asked to
perform. Everything in this module is therefore a cap on an ANONYMOUS registrant,
and the caps are pure functions so the policy is readable in one screen.

The redirect URI is the open-redirect surface, so it is pinned twice:

* at registration — each URI must be EXACTLY Claude's web callback, or a loopback
  URI (``http://localhost|127.0.0.1|[::1]``). A prefix match would accept
  ``https://claude.ai.evil.example/api/mcp/auth_callback``, which is why the
  comparison is string equality and not ``startswith``;
* at ``/authorize`` — :meth:`BudgetClient.validate_redirect_uri`, which the SDK's
  handler calls BEFORE ``provider.authorize`` (and again on its error path), so
  normalising inside ``authorize`` would be too late to matter.

**Loopback matching ignores the PORT and nothing else.** A CLI client gets a
fresh ephemeral port on every login and cannot register them all (Claude's own
documentation says so), while scheme, host and path staying exact is what keeps
``http://localhost:4242/evil`` out after ``http://localhost:4242/cb`` was
registered.

``validate_scope`` is overridden to accept anything: the wire ``scope`` is
advisory here, because the mode (``read``/``full``) is chosen by the USER on the
consent page and stored on the grant. Refusing an unknown scope string would only
break clients that send a conventional one.
"""

from urllib.parse import urlsplit

from mcp.server.auth.provider import RegistrationError
from mcp.shared.auth import (
    InvalidRedirectUriError,
    OAuthClientInformationFull,
)
from pydantic import AnyUrl, Field

from budget_api.enums import OAuthClientAuthMethod

#: Claude's web callback, byte for byte (Anthropic's connector documentation).
CLAUDE_REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback"

#: The only hosts a loopback redirect may name. ``[::1]`` arrives from the URL as
#: the bare ``::1`` host, which is what ``urlsplit().hostname`` returns.
_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})

#: DCR caps (architecture §D7). Ten URIs is more than any real client needs and
#: still bounds a JSONB column; 2 KB per URI and 100 characters of name are the
#: limits the storage columns and the consent page are built for.
MAX_REDIRECT_URIS = 10
MAX_REDIRECT_URI_LENGTH = 2048
MAX_CLIENT_NAME_LENGTH = 100

#: Methods we accept at ``/oauth/token`` (ruling R1). A secret is only ever stored
#: as its SHA-256, so "confidential" here is not a plaintext secret in our table.
ALLOWED_AUTH_METHODS = frozenset(m.value for m in OAuthClientAuthMethod)

#: Grants this server implements. ``authorization_code`` is mandatory; anything
#: outside the pair (notably the SEP-990 jwt-bearer grant, which the SDK's own
#: handler also refuses through DCR) is refused here.
_ALLOWED_GRANT_TYPES = frozenset({"authorization_code", "refresh_token"})


def is_loopback(uri: str) -> bool:
    """Is this a loopback redirect URI — ``http://`` plus a loopback host?"""
    parts = urlsplit(uri)
    return parts.scheme == "http" and (parts.hostname or "") in _LOOPBACK_HOSTS


def redirect_uri_allowed(uri: str) -> bool:
    """May this URI be REGISTERED? Claude's exact callback, or any loopback URI."""
    if len(uri) > MAX_REDIRECT_URI_LENGTH:
        return False
    parts = urlsplit(uri)
    # RFC 6749 §3.1.2: a redirect URI MUST NOT carry a fragment — and a fragment
    # is where an open redirect hides from a server that only compares prefixes.
    if parts.fragment:
        return False
    if uri == CLAUDE_REDIRECT_URI:
        return True
    return is_loopback(uri)


def same_target(registered: str, presented: str) -> bool:
    """Does ``presented`` address the same callback as ``registered``?

    Exact string equality, except that two LOOPBACK URIs may differ in their port
    (see the module docstring) — scheme, host, path and query must still match.
    """
    if registered == presented:
        return True
    if not (is_loopback(registered) and is_loopback(presented)):
        return False
    left, right = urlsplit(registered), urlsplit(presented)
    return (
        left.scheme == right.scheme
        and (left.hostname or "") == (right.hostname or "")
        and left.path == right.path
        and left.query == right.query
        and not right.fragment
    )


def validate_registration(client_info: OAuthClientInformationFull) -> str:
    """The DCR caps; returns the validated ``token_endpoint_auth_method``.

    Raises :class:`RegistrationError`, which the SDK's handler turns into a 400.

    Deliberately NOT a place that logs the body: a registration request is
    attacker-controlled text, and the ``client_id`` in the caller's one log line is
    the only identifier worth keeping (architecture §D10).
    """
    uris = [str(uri) for uri in client_info.redirect_uris or ()]
    if not uris or len(uris) > MAX_REDIRECT_URIS:
        raise RegistrationError(
            error="invalid_redirect_uri",
            error_description=(
                f"redirect_uris must hold between 1 and {MAX_REDIRECT_URIS} URIs"
            ),
        )
    for uri in uris:
        if not redirect_uri_allowed(uri):
            raise RegistrationError(
                error="invalid_redirect_uri",
                error_description=(
                    "each redirect_uri must be exactly "
                    f"'{CLAUDE_REDIRECT_URI}' or an http loopback URI"
                ),
            )
    if client_info.response_types != ["code"]:
        raise RegistrationError(
            error="invalid_client_metadata",
            error_description="response_types must be exactly ['code']",
        )
    if not set(client_info.grant_types) <= _ALLOWED_GRANT_TYPES:
        raise RegistrationError(
            error="invalid_client_metadata",
            error_description=(
                "grant_types must be a subset of "
                "['authorization_code', 'refresh_token']"
            ),
        )
    method = client_info.token_endpoint_auth_method
    if method is None or method not in ALLOWED_AUTH_METHODS:
        raise RegistrationError(
            error="invalid_client_metadata",
            error_description=(
                "token_endpoint_auth_method must be one of "
                f"{sorted(ALLOWED_AUTH_METHODS)}"
            ),
        )
    if client_info.client_name is not None and (
        len(client_info.client_name) > MAX_CLIENT_NAME_LENGTH
    ):
        raise RegistrationError(
            error="invalid_client_metadata",
            error_description=(
                f"client_name must be at most {MAX_CLIENT_NAME_LENGTH} characters"
            ),
        )
    return method


class BudgetClient(OAuthClientInformationFull):
    """A registered client as the SDK handlers see it, with OUR two rules.

    ``client_secret`` is deliberately left ``None`` on every instance: we store
    only a digest (``client_secret_hash``), and ``oauth/client_auth.py`` is what
    compares it. The hash field is ``exclude``d from serialisation so no future
    handler can echo it into a response body.
    """

    #: SHA-256 hex of the registered secret, or None for a public client.
    client_secret_hash: str | None = Field(default=None, exclude=True)

    def validate_redirect_uri(self, redirect_uri: AnyUrl | None) -> AnyUrl:
        if redirect_uri is None:
            # The "exactly one registered URI" case — the SDK's own rule, kept.
            return super().validate_redirect_uri(None)
        presented = str(redirect_uri)
        for registered in self.redirect_uris or ():
            if same_target(str(registered), presented):
                return redirect_uri
        # The SDK's own wording, so a client sees one message for both paths.
        raise InvalidRedirectUriError(
            f"Redirect URI '{redirect_uri}' not registered for client"
        )

    def validate_scope(self, requested_scope: str | None) -> list[str] | None:
        """Accept anything: the mode is decided at consent, not on the wire."""
        if requested_scope is None:
            return None
        return requested_scope.split(" ")
