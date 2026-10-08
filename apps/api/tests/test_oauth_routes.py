"""The four JWT-only consent/connected-app routes (mcp-remote §Contract).

What this file owns is the part of the feature a BROWSER touches, and the two
properties that are easy to break while editing either side of it:

* the no-oracle 404s — ``OAUTH_REQUEST_NOT_FOUND`` and ``OAUTH_APP_NOT_FOUND``
  each have ONE code path, and the body of a foreign id must be byte-identical to
  the body of a missing one;
* DISJOINTNESS from ``/tokens``. The grant and the personal access token are rows
  of the same table (architecture §D3), so one forgotten predicate would let the
  PAT list display a grant, or let ``DELETE /tokens/{id}`` disconnect an AI app.
  Four predicates make that impossible and all four are asserted here.

The flow itself (DCR → consent → token), and everything the AS answers, is
``test_oauth_server.py``. The allowlist membership of these routes is pinned in
``test_pat_auth.py`` (``NEVER_PAT``); what is proven here is the runtime half —
that a token presenting itself is refused.
"""

import uuid
from typing import Any

from helpers import connect_oauth_app
from httpx import AsyncClient

PASSWORD = "password123"
PUBLIC_BASE_URL = "http://localhost"


async def _register_and_login(client: AsyncClient, email: str) -> dict[str, str]:
    reg = await client.post(
        "/auth/register", json={"email": email, "password": PASSWORD}
    )
    assert reg.status_code == 201, reg.text
    login = await client.post(
        "/auth/login", data={"username": email, "password": PASSWORD}
    )
    assert login.status_code == 200, login.text
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


class TestNoOracle:
    async def test_every_404_has_one_body_whatever_the_reason(
        self, make_client: Any
    ) -> None:
        """Unknown, foreign, already-revoked and "that is a PAT" are one answer.

        Compared as whole responses (body AND the code), because an oracle built
        from a difference in wording is still an oracle: the holder of a uuid must
        not be able to learn that it exists but belongs to somebody else.
        """
        client = await make_client(public_base_url=PUBLIC_BASE_URL)
        owner = await _register_and_login(client, "owner@example.com")
        stranger = await _register_and_login(client, "stranger@example.com")
        app = await connect_oauth_app(client, owner)
        unknown = uuid.uuid4()

        missing_request = await client.get(f"/oauth/requests/{unknown}", headers=owner)
        assert missing_request.status_code == 404
        assert missing_request.json() == {"detail": "OAUTH_REQUEST_NOT_FOUND"}
        missing_decision = await client.post(
            f"/oauth/requests/{unknown}/decision",
            json={"decision": "allow", "scope": "read"},
            headers=owner,
        )
        assert missing_decision.status_code == 404
        assert missing_decision.json() == {"detail": "OAUTH_REQUEST_NOT_FOUND"}

        # The grant exists and is live, but not for the stranger.
        foreign = await client.delete(f"/oauth/apps/{app.grant_id}", headers=stranger)
        missing = await client.delete(f"/oauth/apps/{unknown}", headers=owner)
        assert foreign.status_code == missing.status_code == 404
        assert foreign.content == missing.content
        assert missing.json() == {"detail": "OAUTH_APP_NOT_FOUND"}

        assert (
            await client.delete(f"/oauth/apps/{app.grant_id}", headers=owner)
        ).status_code == 204
        revoked_again = await client.delete(
            f"/oauth/apps/{app.grant_id}", headers=owner
        )
        assert revoked_again.status_code == 404
        assert revoked_again.content == missing.content


class TestDisjointFromTokens:
    async def test_grants_and_personal_tokens_never_cross_lists(
        self, make_client: Any, pat_factory: Any
    ) -> None:
        """Two kinds of row in one table, four predicates, all of them load-bearing."""
        client = await make_client(public_base_url=PUBLIC_BASE_URL)
        headers = await _register_and_login(client, "both@example.com")
        pat = await pat_factory(client, headers)
        app = await connect_oauth_app(client, headers, scope="full")

        listed_tokens = await client.get("/tokens", headers=headers)
        assert [row["id"] for row in listed_tokens.json()["items"]] == [pat["id"]]
        listed_apps = await client.get("/oauth/apps", headers=headers)
        assert [row["id"] for row in listed_apps.json()["items"]] == [app.grant_id]

        # Each route refuses the other's id with its own 404, so neither can be
        # used to revoke — or to confirm the existence of — the other's row.
        crossed_delete = await client.delete(f"/tokens/{app.grant_id}", headers=headers)
        assert crossed_delete.status_code == 404
        assert crossed_delete.json() == {"detail": "TOKEN_NOT_FOUND"}
        crossed_revoke = await client.delete(
            f"/oauth/apps/{pat['id']}", headers=headers
        )
        assert crossed_revoke.status_code == 404
        assert crossed_revoke.json() == {"detail": "OAUTH_APP_NOT_FOUND"}

        # And both are still there: a refused cross-delete must not half-apply.
        assert (await client.get("/tokens", headers=headers)).json()["items"][0][
            "revoked_at"
        ] is None
        assert (await client.get("/oauth/apps", headers=headers)).json()["items"][0][
            "revoked_at"
        ] is None


class TestAntiEscalation:
    async def test_no_bearer_token_reaches_the_consent_or_app_routes(
        self, make_client: Any, pat_factory: Any
    ) -> None:
        """An AI app must not be able to approve its own consent or lift its limits.

        Both token kinds are tried: the plain PAT and the OAuth access token of a
        LIVE full-scope grant — the one credential that would turn a leaked token
        into permanent full access if any of these four routes accepted it.
        """
        client = await make_client(public_base_url=PUBLIC_BASE_URL)
        headers = await _register_and_login(client, "escalate@example.com")
        pat = await pat_factory(client, headers, scope="full")
        app = await connect_oauth_app(client, headers, scope="full")
        unknown = uuid.uuid4()

        for token in (pat["token"], app.access_token):
            bearer = {"Authorization": f"Bearer {token}"}
            calls = [
                await client.get(f"/oauth/requests/{unknown}", headers=bearer),
                await client.post(
                    f"/oauth/requests/{unknown}/decision",
                    json={"decision": "allow", "scope": "full"},
                    headers=bearer,
                ),
                await client.get("/oauth/apps", headers=bearer),
                await client.delete(f"/oauth/apps/{app.grant_id}", headers=bearer),
            ]
            assert [call.status_code for call in calls] == [401, 401, 401, 401]
