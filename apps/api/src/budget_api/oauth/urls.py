"""Every public URL of the remote connector, composed once (architecture §D5).

A remote MCP client discovers this server from two well-known documents and then
talks to whatever absolute URLs they name. Those URLs cannot be derived from a
request: the API process sits behind nginx behind Caddy, so ``request.base_url``
is an internal address and the ``/api/`` prefix the browser and Claude use does
not exist inside this app at all. ONE setting — ``public_base_url`` — carries the
outside world's view of the deployment, and this module is the only place it is
turned into strings.

``from_settings`` returns ``None`` when the setting is empty, and that ``None`` is
the feature switch: dev, pytest and the hermetic contract export register no
OAuth/MCP route at all. A deployment that wants the connector sets the base URL
(``docker-compose.prod.yml`` derives it from ``SITE_DOMAIN``), and nothing else.

**The issuer has no path.** RFC 8414 lets endpoints live anywhere, while a
path-ful issuer (``{base}/api``) needs path-inserted discovery
(``/.well-known/oauth-authorization-server/api``) which Claude's documentation
promises only for the protected-resource document — more risk for nothing.

Two shapes are load-bearing and easy to break:

* no trailing slash anywhere. ``config.Settings`` strips it off the base, and
  ``routes.py`` hands these strings to the SDK's metadata models as STRINGS (not
  as pre-built ``AnyHttpUrl`` objects) because only then does their
  ``url_preserve_empty_path`` config keep ``https://host`` from rendering as
  ``https://host/`` — which the audience comparison and Claude's issuer check
  would both read as a different server;
* the three endpoint URLs carry the ``/api`` prefix nginx strips, while the
  consent URL does NOT: it is a page of the SPA, served by the web container.
"""

from dataclasses import dataclass
from urllib.parse import quote

from budget_api.config import Settings


@dataclass(frozen=True)
class PublicUrls:
    """The deployment's outside-world URLs. Built once per app, never per request."""

    #: ``https://budget.example`` — no trailing slash, no path.
    base: str
    #: RFC 8414 issuer == the base. Also what the PRM document advertises.
    issuer: str
    #: RFC 8707/9728 resource — the MCP endpoint. Tokens are audience-bound to it.
    resource: str
    authorize: str
    token: str
    register: str
    #: Path only, the SPA route under the auth guard. Use :meth:`consent_url`.
    consent: str
    #: The protected-resource metadata document, named in the 401 the transport
    #: answers with (``WWW-Authenticate: … resource_metadata="…"``).
    protected_resource_metadata: str

    @classmethod
    def from_settings(cls, settings: Settings) -> "PublicUrls | None":
        """The URLs, or ``None`` when this deployment has no public base URL."""
        base = settings.public_base_url
        if not base:
            return None
        return cls(
            base=base,
            issuer=base,
            resource=f"{base}/mcp",
            # /api/ exists only in front of this app (nginx ``location /api/``);
            # the route inside the app is plain /oauth/authorize.
            authorize=f"{base}/api/oauth/authorize",
            token=f"{base}/api/oauth/token",
            register=f"{base}/api/oauth/register",
            consent=f"{base}/oauth/consent",
            protected_resource_metadata=(
                f"{base}/.well-known/oauth-protected-resource/mcp"
            ),
        )

    def consent_url(self, request_id: str) -> str:
        """Where ``/oauth/authorize`` sends the browser. The id is the only param."""
        return f"{self.consent}?req={quote(request_id, safe='')}"
