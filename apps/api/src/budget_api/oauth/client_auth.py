"""Client authentication at ``/oauth/token`` — against a HASH, never a plaintext.

This REPLACES the SDK's ``ClientAuthenticator`` (ruling R1). It subclasses it only
to satisfy ``TokenHandler``'s type and never calls ``super()``: the SDK version
compares ``client.client_secret`` — a plaintext column it expects the provider to
have stored — and refuses outright a secret-method client whose stored secret is
missing. Both behaviours are incompatible with "every credential is stored
hashed", and neither can be fixed by a hook: the refusal happens before anything
of ours would run.

What stays identical to the SDK is the contract the handler depends on: one
``authenticate_request(request)``, returning the client on success and raising
``AuthenticationError`` otherwise (the handler answers 401 ``invalid_client``).
What differs is one line of substance — ``hmac.compare_digest`` over the SHA-256 of
the presented secret against the stored digest.

Three methods, per the DCR policy (``clients.py``):

* ``none`` — a public client. PKCE is the binding; nothing is compared, and a
  secret sent anyway is ignored rather than becoming an oracle.
* ``client_secret_post`` — the secret in the form body.
* ``client_secret_basic`` — the secret in ``Authorization: Basic``, with the
  RFC 6749 §2.3.1 percent-decoding and the client-id cross-check.

The message of every refusal is deliberately coarse ("Invalid client
credentials"): a distinction between "no secret sent" and "wrong secret" tells an
attacker which half of the guess was right. Nothing here logs the header, the form
or the secret.
"""

import hmac
import logging
from base64 import b64decode
from binascii import Error as BinasciiError
from typing import Any
from urllib.parse import unquote

from mcp.server.auth.middleware.client_auth import (
    AuthenticationError,
    ClientAuthenticator,
)
from mcp.server.auth.provider import OAuthAuthorizationServerProvider
from mcp.shared.auth import OAuthClientInformationFull
from starlette.requests import Request

from budget_api.enums import OAuthClientAuthMethod
from budget_api.oauth.clients import BudgetClient
from budget_api.oauth.tokens import hash_token

logger = logging.getLogger(__name__)

_INVALID = "Invalid client credentials"


class BudgetClientAuthenticator(ClientAuthenticator):
    """The SDK's authenticator contract, implemented against stored digests."""

    def __init__(
        self, provider: OAuthAuthorizationServerProvider[Any, Any, Any]
    ) -> None:
        self.provider = provider

    async def authenticate_request(
        self, request: Request
    ) -> OAuthClientInformationFull:
        form = await request.form()
        # RFC 6749 §2.3.1 puts the id in the Basic header, but a client_secret_basic
        # client must ALSO send ``client_id`` in the body here: the SDK's own request
        # models (``server/auth/handlers/token.py``) declare the field required, so
        # the body is parsed before anything of ours runs. Both sides change
        # together or neither — relaxing only this read changes nothing.
        raw_client_id = form.get("client_id")
        if not isinstance(raw_client_id, str) or not raw_client_id:
            raise AuthenticationError("Missing client_id")
        client = await self.provider.get_client(raw_client_id)
        # "Unknown client" and "wrong secret" share one message: a registered
        # client_id is not information this endpoint should confirm.
        if client is None:
            raise AuthenticationError(_INVALID)

        method = client.token_endpoint_auth_method
        if method == OAuthClientAuthMethod.none.value:
            return client

        stored_hash = (
            client.client_secret_hash if isinstance(client, BudgetClient) else None
        )
        if stored_hash is None:
            # A secret-method client with no stored digest authenticates NOTHING.
            # Unreachable through our own registration path (which always stores
            # one for these methods) and fail-closed if that ever changes.
            logger.warning(
                "oauth client %s uses %s but has no stored secret digest",
                raw_client_id,
                method,
            )
            raise AuthenticationError(_INVALID)

        presented = self._presented_secret(request, form, method, raw_client_id)
        if presented is None or not hmac.compare_digest(
            hash_token(presented), stored_hash
        ):
            raise AuthenticationError(_INVALID)
        return client

    @staticmethod
    def _presented_secret(
        request: Request, form: Any, method: str | None, client_id: str
    ) -> str | None:
        """The secret the request carries for ``method``, or None if it carries none."""
        if method == OAuthClientAuthMethod.client_secret_post.value:
            value = form.get("client_secret")
            return value if isinstance(value, str) and value else None
        if method == OAuthClientAuthMethod.client_secret_basic.value:
            header = request.headers.get("Authorization", "")
            if not header.startswith("Basic "):
                return None
            try:
                decoded = b64decode(header[6:], validate=True).decode("utf-8")
            except (ValueError, BinasciiError, UnicodeDecodeError):
                return None
            if ":" not in decoded:
                return None
            basic_id, _, secret = decoded.partition(":")
            # RFC 6749 §2.3.1: both halves are percent-encoded on the wire.
            if unquote(basic_id) != client_id:
                return None
            return unquote(secret) or None
        # Unreachable: the registration policy admits exactly three methods and
        # ``none`` returned earlier. Fail closed rather than trust a stored value
        # nobody validated.
        logger.warning("oauth client %s has unsupported auth method", client_id)
        return None
