"""The OAuth 2.1 authorization server this API is to a remote AI client.

Framework glue beside ``pat_auth.py``, not a ``services/`` integration: these
modules exist because the SDK's RFC handlers need storage, policy and a consent
screen, and because an OAuth-issued credential has to arrive at the SAME
``PatContext`` a personal access token does (architecture §D3).

Layout, in dependency order — nothing here imports a router:

* ``urls.py`` — pure. The ONE place a public URL string is composed.
* ``clients.py`` — pure. The DCR policy and the redirect-URI match.
* ``tokens.py`` — the token prefixes, ``mint``, the shared SHA-256 digest and the
  single resolver both ``pat_auth`` and (in B2) the ``/mcp`` verifier use.
* ``client_auth.py`` — our replacement for the SDK's plaintext-comparing
  ``ClientAuthenticator`` (ruling R1).
* ``consent.py`` — reading a parked request and deciding it.
* ``provider.py`` — the ``OAuthAuthorizationServerProvider`` over our tables.
* ``routes.py`` — the Starlette routes, assembled from the SDK's handlers.

**Logging rule for every module here** (architecture §D10): identifiers only —
a ``client_id``, a grant id, a request id. Never a token, a code, a verifier, a
challenge, a ``state``, an ``Authorization`` header or a form body; the errors
raised toward the client carry generic descriptions.
"""
