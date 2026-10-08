"""PAT authentication, the fail-closed allowlist, scope, rate limit and audit (5.6 S1).

Real Postgres, no mocks except the one documented storage-failure simulation in
``TestAudit`` (there is no other way to make an insert fail on demand).

Deliberately NOT here: a 401 test per migrated router (one dependency, one code
path — ``TestPatAuthentication`` covers it), Pydantic validation of the token
schemas, and the existence of the new columns (migration + ``alembic check`` own
that). ``/tokens`` management semantics live in ``test_tokens.py``.
"""

import uuid
from typing import Any
from unittest.mock import patch

from helpers import account_for_currency, create_account
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.enums import ReceiptStatus
from budget_api.models import Receipt
from budget_api.openapi_export import build_export_app
from budget_api.pat_auth import PAT_PREFIX

#: The PAT surface as it stood on 2026-09-20, when it stopped being a literal in
#: ``pat_auth.py`` and became a derivation from the markers on the handlers
#: (``mcp/decorator.py``). Kept here as a SNAPSHOT of a set that was reviewed pair
#: by pair: every reason a pair is (or is not) here now lives next to its route, so
#: this list carries no prose — only the promise that the derivation did not move a
#: single pair. A marker lost to a decorator order, a template missing its router
#: prefix, or one added in passing shows up as an inequality below.
EXPECTED_PAT_ALLOWLIST: frozenset[tuple[str, str]] = frozenset(
    {
        ("GET", "/accounts"),
        ("POST", "/accounts"),
        ("PATCH", "/accounts/{account_id}"),
        ("GET", "/categories"),
        ("POST", "/categories"),
        ("PATCH", "/categories/{category_id}"),
        ("GET", "/deposits"),
        ("GET", "/deposits/{deposit_id}"),
        ("GET", "/fx/convert"),
        ("GET", "/goals"),
        ("POST", "/goals"),
        ("GET", "/goals/upcoming"),
        ("GET", "/goals/{goal_id}"),
        ("PATCH", "/goals/{goal_id}"),
        ("GET", "/goals/{goal_id}/contributions"),
        ("POST", "/goals/{goal_id}/contributions"),
        ("GET", "/goals/{goal_id}/items"),
        ("POST", "/goals/{goal_id}/items"),
        ("PATCH", "/goals/{goal_id}/items/{item_id}"),
        ("GET", "/goals/{goal_id}/progress"),
        ("GET", "/limits"),
        ("PUT", "/limits/{category_id}"),
        ("GET", "/profile"),
        ("POST", "/receipts"),
        ("GET", "/receipts/{receipt_id}"),
        ("GET", "/recurring"),
        ("POST", "/recurring"),
        ("GET", "/recurring/upcoming"),
        ("PATCH", "/recurring/{template_id}"),
        ("GET", "/stats/monthly"),
        ("GET", "/stats/summary"),
        ("GET", "/stats/top-merchants"),
        ("GET", "/tokens/self"),
        ("GET", "/transactions"),
        ("POST", "/transactions"),
        ("GET", "/transactions/summary"),
        ("DELETE", "/transactions/{transaction_id}"),
        ("PATCH", "/transactions/{transaction_id}"),
    }
)

#: Pairs that must NEVER be reachable by a token, each one a decision rather than
#: an omission: the four groups of the never-list (statement import, the deposit
#: writes, the plan-node DELETE, PATCH /profile) plus the historical exceptions
#: (the CSV export, receipt parsing, and /tokens management), the four web-push
#: routes (a token has no browser to bind) and the four OAuth consent /
#: connected-app routes — the ESCALATION surface: a token that could approve its
#: own consent, or revoke the grant that limits it, would be a ladder from one
#: leaked credential to permanent full access. Every pair here is
#: asserted to EXIST in the contract too — a typo in a negative list is otherwise
#: a test that passes by describing nothing.
NEVER_PAT: frozenset[tuple[str, str]] = frozenset(
    {
        ("POST", "/deposits"),
        ("GET", "/oauth/apps"),
        ("DELETE", "/oauth/apps/{grant_id}"),
        ("GET", "/oauth/requests/{request_id}"),
        ("POST", "/oauth/requests/{request_id}/decision"),
        ("PATCH", "/deposits/{deposit_id}"),
        ("DELETE", "/goals/{goal_id}/items/{item_id}"),
        ("PATCH", "/profile"),
        ("POST", "/statement-imports"),
        ("GET", "/statement-imports/formats"),
        ("GET", "/statement-imports/{import_id}"),
        ("DELETE", "/statement-imports/{import_id}"),
        ("GET", "/statement-imports/{import_id}/rows"),
        ("PATCH", "/statement-imports/{import_id}/rows/{row_id}"),
        ("POST", "/statement-imports/{import_id}/rows/bulk-decision"),
        ("POST", "/statement-imports/{import_id}/apply"),
        ("GET", "/statement-imports/{import_id}/replace-preview"),
        ("POST", "/statement-imports/{import_id}/replace"),
        ("GET", "/transactions/export"),
        ("POST", "/receipts/{receipt_id}/parse"),
        ("POST", "/tokens"),
        ("GET", "/tokens"),
        ("DELETE", "/tokens/{token_id}"),
        ("GET", "/push/config"),
        ("POST", "/push/subscriptions"),
        ("POST", "/push/unsubscribe"),
        ("POST", "/push/test"),
    }
)

PASSWORD = "password123"


async def _register_and_login(
    client: AsyncClient, email: str
) -> tuple[dict[str, str], uuid.UUID]:
    reg = await client.post(
        "/auth/register", json={"email": email, "password": PASSWORD}
    )
    assert reg.status_code == 201, reg.text
    user_id = uuid.UUID(reg.json()["id"])
    login = await client.post(
        "/auth/login", data={"username": email, "password": PASSWORD}
    )
    assert login.status_code == 200, login.text
    return {"Authorization": f"Bearer {login.json()['access_token']}"}, user_id


def _pat_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _create_tx(
    client: AsyncClient, headers: dict[str, str], **body: Any
) -> dict[str, Any]:
    body.setdefault("amount_minor", 1000)
    body.setdefault("kind", "expense")
    body.setdefault("occurred_at", "2026-03-15")
    if "account_id" not in body:
        # Every row needs an account, and the row's currency is stamped FROM it
        # (architecture §4) — so the account must match whatever currency the test
        # asked for.
        body["account_id"] = await account_for_currency(
            client, headers, body.get("currency")
        )
    resp = await client.post("/transactions", json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    payload: dict[str, Any] = resp.json()
    return payload


async def _create_category(client: AsyncClient, headers: dict[str, str]) -> str:
    resp = await client.post(
        "/categories", json={"name": "Еда", "kind": "expense"}, headers=headers
    )
    assert resp.status_code == 201, resp.text
    return str(resp.json()["id"])


async def _audit_rows(db_session: AsyncSession) -> list[Any]:
    rows = (
        await db_session.execute(
            text(
                "SELECT method, path, status_code, entity_id, token_id "
                "FROM pat_audit_log ORDER BY id"
            )
        )
    ).all()
    await db_session.rollback()  # end the read transaction: the next read re-snapshots
    return list(rows)


class TestPatAuthentication:
    async def test_valid_pat_reads_only_its_owner_rows(
        self, client: AsyncClient, pat_factory: Any
    ) -> None:
        alice, _ = await _register_and_login(client, "pat-alice@example.com")
        bob, _ = await _register_and_login(client, "pat-bob@example.com")
        mine = await _create_tx(client, alice, note="mine")
        await _create_tx(client, bob, note="theirs")
        token = (await pat_factory(client, alice, "read"))["token"]

        resp = await client.get("/transactions", headers=_pat_headers(token))

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert [item["id"] for item in body["items"]] == [mine["id"]]

    async def test_revoked_unknown_and_malformed_tokens_share_one_401(
        self, client: AsyncClient, pat_factory: Any
    ) -> None:
        """No oracle: "never existed", "revoked" and "garbage" are one answer."""
        headers, _ = await _register_and_login(client, "pat-401@example.com")
        revoked = await pat_factory(client, headers)
        assert (
            await client.delete(f"/tokens/{revoked['id']}", headers=headers)
        ).status_code == 204

        answers: list[tuple[int, str]] = []
        for token in (
            revoked["token"],
            PAT_PREFIX + "Zm9yZ2VkLWJ1dC13ZWxsLWZvcm1lZC10b2tlbi1zdHJpbmc",
            PAT_PREFIX + "!!!",
        ):
            resp = await client.get("/transactions", headers=_pat_headers(token))
            answers.append((resp.status_code, resp.text))

        assert answers[0] == (401, '{"detail":"TOKEN_INVALID"}')
        assert answers[1] == answers[0]
        assert answers[2] == answers[0]


class TestScopeGate:
    async def test_read_scope_cannot_write_but_full_scope_can(
        self, client: AsyncClient, pat_factory: Any
    ) -> None:
        headers, _ = await _register_and_login(client, "pat-scope@example.com")
        read_token = (await pat_factory(client, headers, "read", "read tok"))["token"]
        full_token = (await pat_factory(client, headers, "full", "full tok"))["token"]
        body = {
            "amount_minor": 500,
            "kind": "expense",
            "account_id": await account_for_currency(client, headers),
            "occurred_at": "2026-03-01",
        }

        denied = await client.post(
            "/transactions", json=body, headers=_pat_headers(read_token)
        )
        allowed = await client.post(
            "/transactions", json=body, headers=_pat_headers(full_token)
        )

        assert denied.status_code == 403
        assert denied.json() == {"detail": "TOKEN_SCOPE_READONLY"}
        assert allowed.status_code == 201, allowed.text

    async def test_read_scope_cannot_delete_a_transaction(
        self, client: AsyncClient, pat_factory: Any
    ) -> None:
        headers, _ = await _register_and_login(client, "pat-del-scope@example.com")
        tx = await _create_tx(client, headers)
        read_token = (await pat_factory(client, headers, "read"))["token"]

        resp = await client.delete(
            f"/transactions/{tx['id']}", headers=_pat_headers(read_token)
        )

        assert resp.status_code == 403
        assert resp.json() == {"detail": "TOKEN_SCOPE_READONLY"}
        # The row is still there — a denied write must not half-happen.
        listed = await client.get("/transactions", headers=headers)
        assert listed.json()["total"] == 1


class TestAllowlistGate:
    async def test_routes_outside_the_allowlist_are_forbidden_to_a_full_token(
        self, client: AsyncClient, pat_factory: Any
    ) -> None:
        """Fail-closed: ``full`` is not a master key, it is a scope inside a surface."""
        headers, _ = await _register_and_login(client, "pat-allow@example.com")
        category_id = await _create_category(client, headers)
        assert (
            await client.put(
                f"/limits/{category_id}", json={"amount_minor": 50_000}, headers=headers
            )
        ).status_code in (200, 201)
        token = (await pat_factory(client, headers))["token"]

        export = await client.get("/transactions/export", headers=_pat_headers(token))
        delete_limit = await client.delete(
            f"/limits/{category_id}", headers=_pat_headers(token)
        )

        assert export.status_code == 403
        assert export.json() == {"detail": "TOKEN_ENDPOINT_FORBIDDEN"}
        assert delete_limit.status_code == 403
        assert delete_limit.json() == {"detail": "TOKEN_ENDPOINT_FORBIDDEN"}

    async def test_jwt_traffic_is_untouched_by_the_allowlist(
        self, client: AsyncClient
    ) -> None:
        """The same pair the token above was refused works over a browser session."""
        headers, _ = await _register_and_login(client, "pat-jwt-ok@example.com")
        category_id = await _create_category(client, headers)
        assert (
            await client.put(
                f"/limits/{category_id}", json={"amount_minor": 50_000}, headers=headers
            )
        ).status_code in (200, 201)

        resp = await client.delete(f"/limits/{category_id}", headers=headers)

        assert resp.status_code == 204, resp.text


class TestAccountsSurface:
    """The three ``/accounts`` pairs the accounts-and-transfers scope opened (M1).

    Worth its own class rather than a line in ``TestAllowlistContract``: that test
    only proves the pairs still EXIST in the contract, not that the router accepts a
    PAT at all — ``/accounts`` would answer a bare 401 if it had been wired to
    ``current_active_user`` instead of ``current_user_jwt_or_pat``.
    """

    async def test_a_full_token_lists_creates_and_updates_accounts(
        self, client: AsyncClient, pat_factory: Any
    ) -> None:
        headers, _ = await _register_and_login(client, "pat-accounts@example.com")
        pat_headers = _pat_headers((await pat_factory(client, headers))["token"])

        created = await client.post(
            "/accounts",
            json={"name": "Карта", "currency": "RUB", "type": "card"},
            headers=pat_headers,
        )
        assert created.status_code == 201, created.text
        renamed = await client.patch(
            f"/accounts/{created.json()['id']}",
            json={"name": "Карта Тинькофф"},
            headers=pat_headers,
        )
        listed = await client.get("/accounts", headers=pat_headers)

        assert renamed.status_code == 200, renamed.text
        assert listed.status_code == 200, listed.text
        assert [(item["id"], item["name"]) for item in listed.json()] == [
            (created.json()["id"], "Карта Тинькофф")
        ]

    async def test_a_read_token_lists_accounts_but_cannot_create_one(
        self, client: AsyncClient, pat_factory: Any
    ) -> None:
        """TOKEN_SCOPE_READONLY, not TOKEN_ENDPOINT_FORBIDDEN: the write pair IS
        allowlisted (the allowlist gate runs first), it is the scope that refuses."""
        headers, _ = await _register_and_login(client, "pat-accounts-ro@example.com")
        await create_account(client, headers)
        token = (await pat_factory(client, headers, "read"))["token"]
        pat_headers = _pat_headers(token)

        listed = await client.get("/accounts", headers=pat_headers)
        denied = await client.post(
            "/accounts",
            json={"name": "Наличные", "currency": "RUB", "type": "cash"},
            headers=pat_headers,
        )

        assert listed.status_code == 200, listed.text
        assert len(listed.json()) == 1
        assert denied.status_code == 403
        assert denied.json() == {"detail": "TOKEN_SCOPE_READONLY"}


def _derived_allowlist() -> frozenset[tuple[str, str]]:
    """What ``create_app`` put on ``app.state`` — the set the gate actually reads."""
    allowlist: frozenset[tuple[str, str]] = build_export_app().state.pat_allowlist
    return allowlist


class TestAllowlistContract:
    def test_every_allowlisted_pair_exists_in_the_exported_openapi(self) -> None:
        """A renamed or removed route must break the suite, not an MCP tool silently."""
        paths: dict[str, Any] = build_export_app().openapi()["paths"]

        missing = [
            (method, path)
            for method, path in sorted(_derived_allowlist())
            if method.lower() not in paths.get(path, {})
        ]

        assert missing == []

    def test_the_derived_surface_is_the_surface_that_was_reviewed(self) -> None:
        """The markers on the handlers still describe exactly yesterday's 38 pairs."""
        derived = _derived_allowlist()

        assert sorted(derived) == sorted(EXPECTED_PAT_ALLOWLIST)

    def test_never_pat_pairs_exist_and_stay_unreachable(self) -> None:
        """Each refusal is a real route that was left unmarked on purpose."""
        paths: dict[str, Any] = build_export_app().openapi()["paths"]
        derived = _derived_allowlist()

        absent_from_contract = [
            (method, path)
            for method, path in sorted(NEVER_PAT)
            if method.lower() not in paths.get(path, {})
        ]
        leaked = sorted(NEVER_PAT & derived)

        assert absent_from_contract == []
        assert leaked == []


class TestLastUsedDebounce:
    async def test_second_call_inside_the_window_does_not_rewrite_last_used_at(
        self, client: AsyncClient, db_session: AsyncSession, pat_factory: Any
    ) -> None:
        headers, _ = await _register_and_login(client, "pat-debounce@example.com")
        pat = await pat_factory(client, headers, "read")
        pat_headers = _pat_headers(pat["token"])

        async def _last_used() -> Any:
            value = await db_session.scalar(
                text("SELECT last_used_at FROM personal_access_tokens WHERE id = :id"),
                {"id": uuid.UUID(pat["id"])},
            )
            await db_session.rollback()
            return value

        assert await _last_used() is None
        assert (
            await client.get("/transactions", headers=pat_headers)
        ).status_code == 200
        first = await _last_used()
        assert (
            await client.get("/transactions", headers=pat_headers)
        ).status_code == 200
        second = await _last_used()

        assert first is not None
        assert second == first  # inside the 60s window: one write, not two


class TestPatRateLimit:
    async def test_the_limit_is_keyed_on_the_token_not_the_user(
        self, make_client: Any, pat_factory: Any
    ) -> None:
        client: AsyncClient = await make_client(
            rate_limit_enabled=True, pat_read_rate_limit="2/minute"
        )
        headers, _ = await _register_and_login(client, "pat-rl@example.com")
        token = (await pat_factory(client, headers, "read"))["token"]
        pat_headers = _pat_headers(token)

        first = await client.get("/transactions", headers=pat_headers)
        second = await client.get("/transactions", headers=pat_headers)
        third = await client.get("/transactions", headers=pat_headers)
        jwt_after = await client.get("/transactions", headers=headers)

        assert (first.status_code, second.status_code) == (200, 200)
        assert third.status_code == 429
        assert third.json() == {"detail": "RATE_LIMITED"}
        # Same user, same route, no token: the budget that ran out was the token's.
        assert jwt_after.status_code == 200, jwt_after.text


class TestAudit:
    async def test_pat_writes_are_logged_with_status_and_entity_but_jwt_writes_are_not(
        self, client: AsyncClient, db_session: AsyncSession, pat_factory: Any
    ) -> None:
        headers, _ = await _register_and_login(client, "pat-audit@example.com")
        await _create_tx(client, headers)  # JWT write — must leave no trace
        pat = await pat_factory(client, headers)
        pat_headers = _pat_headers(pat["token"])

        created = await client.post(
            "/transactions",
            json={
                "amount_minor": 700,
                "kind": "expense",
                "account_id": await account_for_currency(client, headers),
                "occurred_at": "2026-03-02",
            },
            headers=pat_headers,
        )
        assert created.status_code == 201, created.text
        patched = await client.patch(
            f"/transactions/{created.json()['id']}",
            json={"amount_minor": 800},
            headers=pat_headers,
        )
        assert patched.status_code == 200, patched.text

        rows = await _audit_rows(db_session)
        assert [(r.method, r.path, r.status_code) for r in rows] == [
            ("POST", "/transactions", 201),
            ("PATCH", "/transactions/{transaction_id}", 200),
        ]
        # POST takes the id from its own response body, PATCH from the path — the
        # two sources must agree on the same entity.
        assert str(rows[0].entity_id) == created.json()["id"]
        assert str(rows[1].entity_id) == created.json()["id"]
        assert {r.token_id for r in rows} == {uuid.UUID(pat["id"])}

    async def test_pat_may_edit_receipt_id_but_not_reach_a_strangers_receipt(
        self, client: AsyncClient, db_session: AsyncSession, pat_factory: Any
    ) -> None:
        """S3 plan §7.4: ``receipt_id`` became PATCHable and the allowlist did NOT
        change, so a token reaches it. That is safe only because ownership is
        enforced by the same ``_validate_receipt`` the JWT path uses — a stranger's
        receipt has to be indistinguishable from a typo, over a token too. The
        audit row is asserted alongside: a new body field must not change the
        trail's shape (route TEMPLATE + path-derived entity_id)."""
        headers, user_id = await _register_and_login(client, "pat-rcpt@example.com")
        _, stranger_id = await _register_and_login(client, "pat-rcpt-other@example.com")
        for owner in (user_id, stranger_id):
            db_session.add(
                Receipt(
                    id=uuid.uuid5(uuid.NAMESPACE_OID, str(owner)),
                    user_id=owner,
                    storage_path=f"{owner}/r.jpg",
                    status=ReceiptStatus.pending.value,
                )
            )
        await db_session.commit()
        mine = uuid.uuid5(uuid.NAMESPACE_OID, str(user_id))
        theirs = uuid.uuid5(uuid.NAMESPACE_OID, str(stranger_id))
        tx = await _create_tx(client, headers)
        pat = await pat_factory(client, headers)
        pat_headers = _pat_headers(pat["token"])
        url = f"/transactions/{tx['id']}"

        attached = await client.patch(
            url, json={"receipt_id": str(mine)}, headers=pat_headers
        )
        stolen = await client.patch(
            url, json={"receipt_id": str(theirs)}, headers=pat_headers
        )

        assert attached.status_code == 200, attached.text
        assert attached.json()["receipt_id"] == str(mine)
        assert (stolen.status_code, stolen.text) == (
            422,
            '{"detail":"RECEIPT_NOT_FOUND"}',
        )
        rows = await _audit_rows(db_session)
        assert [(r.method, r.path, r.status_code) for r in rows] == [
            ("PATCH", "/transactions/{transaction_id}", 200),
            ("PATCH", "/transactions/{transaction_id}", 422),
        ]
        assert {str(r.entity_id) for r in rows} == {tx["id"]}

    async def test_calls_refused_by_a_403_gate_are_audited_with_that_403(
        self, client: AsyncClient, db_session: AsyncSession, pat_factory: Any
    ) -> None:
        """The rejected attempts are the whole point (amendment MAJOR-1).

        Both 403 flavours: an allowlist miss and a scope denial. A leaked token
        probing endpoints must be visible in the trail, not invisible in it.
        """
        headers, _ = await _register_and_login(client, "pat-audit-403@example.com")
        full = (await pat_factory(client, headers, "full", "full tok"))["token"]
        read = (await pat_factory(client, headers, "read", "read tok"))["token"]

        forbidden_route = await client.get(
            "/transactions/export", headers=_pat_headers(full)
        )
        forbidden_scope = await client.post(
            "/transactions",
            json={"amount_minor": 100, "kind": "expense", "occurred_at": "2026-03-04"},
            headers=_pat_headers(read),
        )

        assert forbidden_route.json() == {"detail": "TOKEN_ENDPOINT_FORBIDDEN"}
        assert forbidden_scope.json() == {"detail": "TOKEN_SCOPE_READONLY"}
        rows = await _audit_rows(db_session)
        assert [(r.method, r.path, r.status_code) for r in rows] == [
            ("GET", "/transactions/export", 403),
            ("POST", "/transactions", 403),
        ]

    async def test_a_call_refused_by_the_rate_limit_is_audited_with_its_429(
        self, make_client: Any, db_session: AsyncSession, pat_factory: Any
    ) -> None:
        """A token being hammered leaves a trail of 429s, not silence."""
        client: AsyncClient = await make_client(
            rate_limit_enabled=True, pat_read_rate_limit="1/minute"
        )
        headers, _ = await _register_and_login(client, "pat-audit-429@example.com")
        token = (await pat_factory(client, headers, "read"))["token"]
        pat_headers = _pat_headers(token)

        served = await client.get("/transactions", headers=pat_headers)
        throttled = await client.get("/transactions", headers=pat_headers)

        assert served.status_code == 200, served.text
        assert throttled.json() == {"detail": "RATE_LIMITED"}
        rows = await _audit_rows(db_session)
        assert [(r.method, r.path, r.status_code) for r in rows] == [
            ("GET", "/transactions", 200),
            ("GET", "/transactions", 429),
        ]

    @patch("budget_api.pat_audit._insert_audit_row")
    async def test_a_failing_audit_insert_never_fails_the_request(
        self,
        mock_insert: Any,
        client: AsyncClient,
        db_session: AsyncSession,
        pat_factory: Any,
    ) -> None:
        # Mocking an internal on purpose: a storage failure cannot be provoked from
        # the outside, and "the audit trail must never become the user's error" is
        # precisely the behaviour under test.
        mock_insert.side_effect = SQLAlchemyError("audit storage is down")
        headers, _ = await _register_and_login(client, "pat-audit-fail@example.com")
        token = (await pat_factory(client, headers))["token"]

        resp = await client.post(
            "/transactions",
            json={
                "amount_minor": 900,
                "kind": "expense",
                "account_id": await account_for_currency(client, headers),
                "occurred_at": "2026-03-03",
            },
            headers=_pat_headers(token),
        )

        assert resp.status_code == 201, resp.text
        assert mock_insert.await_count == 1
        assert await _audit_rows(db_session) == []


class TestDeleteTransactionTool:
    async def test_full_token_deletes_once_and_the_repeat_is_the_foreign_404(
        self, client: AsyncClient, db_session: AsyncSession, pat_factory: Any
    ) -> None:
        headers, _ = await _register_and_login(client, "pat-delete@example.com")
        stranger, _ = await _register_and_login(client, "pat-delete-other@example.com")
        theirs = await _create_tx(client, stranger)
        mine = await _create_tx(client, headers)
        token = (await pat_factory(client, headers))["token"]
        pat_headers = _pat_headers(token)

        deleted = await client.delete(
            f"/transactions/{mine['id']}", headers=pat_headers
        )
        repeated = await client.delete(
            f"/transactions/{mine['id']}", headers=pat_headers
        )
        foreign = await client.delete(
            f"/transactions/{theirs['id']}", headers=pat_headers
        )

        assert deleted.status_code == 204
        assert repeated.status_code == 404
        # Byte-identical: "gone" and "someone else's" must not be distinguishable.
        assert repeated.text == foreign.text == '{"detail":"TRANSACTION_NOT_FOUND"}'
        assert foreign.status_code == 404
        # A 204 carries no body, so the audit's entity_id can only come from the path.
        rows = await _audit_rows(db_session)
        assert [(r.method, r.status_code, str(r.entity_id)) for r in rows] == [
            ("DELETE", 204, mine["id"]),
            ("DELETE", 404, mine["id"]),
            ("DELETE", 404, theirs["id"]),
        ]


class TestReceiptUpload:
    """The two receipt routes an MCP token may reach — and the one it may not.

    The upload tool creates a receipt, PUTs the bytes to storage itself and reads
    the row back, so exactly those two routes take a token. ``/parse`` stays
    session-only because it spends the user's AI budget, and that is an app
    decision rather than something a chat reply may trigger.
    """

    async def test_token_can_create_and_read_a_receipt(
        self, client: AsyncClient, pat_factory: Any
    ) -> None:
        headers, _ = await _register_and_login(client, "pat-receipt@example.com")
        token = (await pat_factory(client, headers, "full", "upload tok"))["token"]
        pat_headers = _pat_headers(token)

        created = await client.post("/receipts", headers=pat_headers)

        assert created.status_code == 201, created.text
        receipt_id = created.json()["id"]

        read = await client.get(f"/receipts/{receipt_id}", headers=pat_headers)

        assert read.status_code == 200, read.text
        assert read.json()["id"] == receipt_id

    async def test_parse_stays_off_the_token_surface(
        self, client: AsyncClient, pat_factory: Any
    ) -> None:
        headers, _ = await _register_and_login(client, "pat-parse@example.com")
        token = (await pat_factory(client, headers, "full", "parse tok"))["token"]
        pat_headers = _pat_headers(token)

        created = await client.post("/receipts", headers=pat_headers)
        receipt_id = created.json()["id"]

        parsed = await client.post(f"/receipts/{receipt_id}/parse", headers=pat_headers)

        # 401, not the allowlist's 403: this route still resolves its user through
        # the JWT-only dependency, so a ``bgt_pat_`` bearer dies at the decode and
        # never reaches the allowlist at all. That is the STRONGER refusal of the
        # two — the same shape ``PATCH /profile`` uses — and it holds even if a
        # future edit accidentally marks the route as PAT-reachable.
        assert parsed.status_code == 401
