"""The two reconcile routes: the claim, the stored report, the two reads.

Real Postgres, real router, real ``services/reconcile`` — the ONLY thing swapped
is the provider (``FakeProvider``, whose scripted loop reports every open item,
with no network at all). What only this layer can prove: that a run is CLAIMED so
a double click cannot burn two loops, that a crashed claim is re-takeable, that a
provider outage is stored as ``failed`` and answered as a 503, and that the
report's embedded mini views survive a transaction being deleted under them.

The agent's own arms (the pre-match, the key mapping, the terminal validation,
the three budgets) are in ``test_reconcile.py`` without a database, and the
fake's script in ``test_llm_providers.py``. Neither is re-asserted here.
"""

import uuid
from datetime import datetime
from typing import Any

from helpers import create_account
from httpx import AsyncClient, Response
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.llm import LLMRequest, LLMResponse
from budget_api.llm.fake import FAIL_MARKER, FakeProvider
from budget_api.services.reconcile import PROMPT_VERSION

PASSWORD = "password123"
FORMAT = "priorbank_csv_v1"

_HEADER = (
    "Выписка по контракту;;;;;;;;",
    "Клиент;QA USER;;;;;;;",
    "......5817 Валюта контракта BYN;;;;;;;;",
    "Период выписки: с 01.06.2026 по 30.06.2026;;;;;;;;",  # noqa: RUF001
    ";;;;;;;;",
    "Операции по ......5817;;;;;;;;",
    "Дата транзакции;Операция;Сумма;Валюта;Дата операции по счету;"
    "Комиссия/Money-back;Обороты по счету;Цифровая карта;Категория операции",
)


def _operation(description: str, turnover: str, *, day: int) -> str:
    return (
        f"{day:02d}.06.2026 10:15:00;{description};;;{day:02d}.06.2026;;"
        f"{turnover};;Прочие расходы"
    )


def _csv(*operations: str) -> bytes:
    # The bank's own Cyrillic landmarks; RUF001 reads them as Latin homoglyphs.
    lines = [*_HEADER, *operations, "Всего по контракту;;;;;;0,00;;"]  # noqa: RUF001
    return "\r\n".join(lines).encode("cp1251")


#: Two ordinary rows nothing in the app answers, and one that makes the fake
#: fail the call it first appears in — which, in a tool loop, is the step that
#: carries the ROWS tool's result (``llm/fake.py``'s one scan).
FIRST_ROW = _operation("SHOP ONE", "-25,40", day=2)
SECOND_ROW = _operation("SHOP TWO", "-31,00", day=3)
FAILING_ROW = _operation(f"TERMINAL {FAIL_MARKER}", "-9,99", day=4)


class CountingProvider:
    """``FakeProvider("fake")`` plus how many calls it was asked to make.

    The only way to prove a refusal happened BEFORE the model: a 422 and a 422
    after three model calls look identical on the wire, and the whole point of
    ``RECONCILIATION_TOO_LARGE`` is that it costs nothing.
    """

    def __init__(self) -> None:
        self._inner = FakeProvider("fake")
        self.name = self._inner.name
        self.model = self._inner.model
        self.calls = 0

    async def complete(self, request: LLMRequest) -> LLMResponse:
        self.calls += 1
        return await self._inner.complete(request)


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


async def _byn_account(client: AsyncClient, headers: dict[str, str]) -> str:
    account = await create_account(client, headers, currency="BYN", name="Card BYN")
    return str(account["id"])


async def _upload(
    client: AsyncClient, headers: dict[str, str], account_id: str, data: bytes
) -> dict[str, Any]:
    created = await client.post(
        "/statement-imports",
        files={"file": ("Vpsk_71466782.csv", data, "text/csv")},
        data={"account_id": account_id, "format": FORMAT},
        headers=headers,
    )
    assert created.status_code == 201, created.text
    session: dict[str, Any] = created.json()
    return session


async def _post_tx(
    client: AsyncClient, headers: dict[str, str], **body: Any
) -> dict[str, Any]:
    body.setdefault("kind", "expense")
    resp = await client.post("/transactions", json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    created: dict[str, Any] = resp.json()
    return created


async def _reconcile(
    client: AsyncClient, headers: dict[str, str], import_id: str
) -> Response:
    return await client.post(
        f"/statement-imports/{import_id}/reconcile", headers=headers
    )


async def _report(
    client: AsyncClient, headers: dict[str, str], import_id: str
) -> dict[str, Any]:
    resp = await client.get(
        f"/statement-imports/{import_id}/reconciliation", headers=headers
    )
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] = resp.json()
    return body


async def _session_of(
    client: AsyncClient, headers: dict[str, str], import_id: str
) -> dict[str, Any]:
    resp = await client.get(f"/statement-imports/{import_id}", headers=headers)
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] = resp.json()
    return body


def _of_kind(items: list[dict[str, Any]], kind: str) -> list[dict[str, Any]]:
    return [item for item in items if item["kind"] == kind]


class TestReconcileRun:
    async def test_a_parsed_session_reports_both_sides_with_their_mini_views(
        self, make_llm_client: Any
    ) -> None:
        """The whole happy path: POST answers the report, and both reads agree.

        The session is ``parsed``, so every row is open and the one app
        transaction the file does not mention is open too — the fake then names
        all three. What is asserted is the SERVER's half of that: the counts and
        the open/settled numbers, the uuids behind the opaque keys, and the
        embedded views (the whole reason the report screen needs no second
        request per item). Which kinds the fake chose is the fake's business.
        """
        client = await make_llm_client(llm=FakeProvider("fake"))
        headers = await _register_and_login(client, "reconcile-ok@example.com")
        account_id = await _byn_account(client, headers)
        mine = await _post_tx(
            client,
            headers,
            account_id=account_id,
            amount_minor=5_000,
            currency="BYN",
            occurred_at="2026-06-05",
            merchant="MY OWN NOTE",
        )
        session = await _upload(
            client, headers, account_id, _csv(FIRST_ROW, SECOND_ROW)
        )

        answered = await _reconcile(client, headers, session["id"])

        assert answered.status_code == 200, answered.text
        body: dict[str, Any] = answered.json()
        assert body["status"] == "ok"
        assert (body["provider"], body["model"]) == ("fake", "fake")
        assert body["prompt_version"] == PROMPT_VERSION
        assert (
            body["settled_exact"],
            body["open_rows"],
            body["open_transactions"],
        ) == (
            0,
            2,
            1,
        )
        assert body["counts"] == {
            "missing_in_app": 2,
            "extra_in_app": 1,
            "amount_differs": 0,
            "date_differs": 0,
            "fx_difference": 0,
        }
        assert (body["unmentioned_rows"], body["unmentioned_transactions"]) == (0, 0)
        assert body["summary"]
        missing = _of_kind(body["items"], "missing_in_app")
        extra = _of_kind(body["items"], "extra_in_app")
        # The ONE-SIDED kinds carry exactly one view each — that is the contract
        # the report screen renders, not an accident of this run.
        assert {item["row"]["amount_minor"] for item in missing} == {2_540, 3_100}
        assert all(item["row"]["currency"] == "BYN" for item in missing)
        assert all(item["transaction"] is None for item in missing)
        assert extra[0]["transaction"]["id"] == mine["id"]
        assert extra[0]["transaction"]["merchant"] == "MY OWN NOTE"
        assert extra[0]["row"] is None
        assert extra[0]["explanation"]

        # The session read carries the headline so the import screen needs no
        # second request (amendment A4).
        session_read = await _session_of(client, headers, session["id"])
        assert session_read["reconciliation_status"] == "ok"
        assert session_read["reconciliation_counts"] == body["counts"]
        assert session_read["reconciliation_summary"] == body["summary"]
        assert session_read["reconciled_at"] == body["reconciled_at"]

        # …and the GET answers the same document, views joined at read.
        stored = await _report(client, headers, session["id"])
        assert stored == body

        # A transaction deleted after the report was taken: the item stays, its
        # view goes. The stored document keeps ids only, so this is the arm that
        # would otherwise be a 500 on an ordinary read.
        deleted = await client.delete(f"/transactions/{mine['id']}", headers=headers)
        assert deleted.status_code == 204, deleted.text
        after = await _report(client, headers, session["id"])
        assert _of_kind(after["items"], "extra_in_app")[0]["transaction"] is None
        assert after["counts"] == body["counts"]

    async def test_an_applied_session_reconciles_against_its_own_transactions(
        self, make_llm_client: Any
    ) -> None:
        """After the apply the rows are SETTLED by fingerprint, not by the model.

        This is the question the route exists to answer on an ``applied``
        session: "did the import land the way I expected". The two rows the apply
        created are proven matches of themselves, so the model is only asked
        about what it could not — which is why ``settled_exact`` is the number
        under test here and no lifecycle gate refuses the run.
        """
        client = await make_llm_client(llm=FakeProvider("fake"))
        headers = await _register_and_login(client, "reconcile-applied@example.com")
        account_id = await _byn_account(client, headers)
        session = await _upload(
            client, headers, account_id, _csv(FIRST_ROW, SECOND_ROW)
        )
        applied = await client.post(
            f"/statement-imports/{session['id']}/apply", headers=headers
        )
        assert applied.status_code == 200, applied.text
        assert applied.json()["created"] == 2

        answered = await _reconcile(client, headers, session["id"])

        assert answered.status_code == 200, answered.text
        body: dict[str, Any] = answered.json()
        assert (
            body["settled_exact"],
            body["open_rows"],
            body["open_transactions"],
        ) == (
            2,
            0,
            0,
        )
        assert body["items"] == []
        assert body["counts"]["missing_in_app"] == 0

    async def test_a_second_run_overwrites_the_report_the_first_one_stored(
        self, make_llm_client: Any
    ) -> None:
        """A re-run is a documented flow (D-R5), and it must survive the CHECK.

        ``reconciliation_present`` makes ``ok`` mean "there is a document", so the
        second run's CLAIM has to clear the first one's report in the same UPDATE
        that writes ``running`` — else the claim is itself an IntegrityError and a
        session that once succeeded could never be reconciled again (the web's
        re-run button, the only way to refresh a report).

        The overwrite is proven by a CHANGED document rather than by the
        timestamp alone: a transaction seeded between the two runs is open on the
        second one only.
        """
        client = await make_llm_client(llm=FakeProvider("fake"))
        headers = await _register_and_login(client, "reconcile-rerun@example.com")
        account_id = await _byn_account(client, headers)
        session = await _upload(client, headers, account_id, _csv(FIRST_ROW))

        first = await _reconcile(client, headers, session["id"])
        assert first.status_code == 200, first.text
        assert first.json()["counts"]["extra_in_app"] == 0

        await _post_tx(
            client,
            headers,
            account_id=account_id,
            amount_minor=5_000,
            currency="BYN",
            occurred_at="2026-06-05",
            merchant="SEEDED AFTER THE FIRST RUN",
        )

        second = await _reconcile(client, headers, session["id"])

        assert second.status_code == 200, second.text
        body: dict[str, Any] = second.json()
        assert body["status"] == "ok"
        assert body["counts"]["extra_in_app"] == 1
        assert datetime.fromisoformat(body["reconciled_at"]) > datetime.fromisoformat(
            first.json()["reconciled_at"]
        )
        # And the STORED document is the second one, not the first kept behind it.
        assert await _report(client, headers, session["id"]) == body


class TestReconcileClaim:
    async def test_a_running_claim_refuses_the_second_run_until_it_goes_stale(
        self, make_llm_client: Any, db_session: AsyncSession
    ) -> None:
        """One loop per session — and a crashed loop does not lock it forever.

        The claim is the whole concurrency design: a double click must burn one
        model budget, not two. Its price is that a crash leaves ``running``
        behind, which is why the second half of this test matters more than the
        first — a session nobody can reconcile again would be a dead screen.

        The ``running`` state is set by SQL rather than by racing two POSTs: the
        fake answers in microseconds, so a real race here would be a flake.
        """
        client = await make_llm_client(llm=FakeProvider("fake"))
        headers = await _register_and_login(client, "reconcile-claim@example.com")
        account_id = await _byn_account(client, headers)
        session = await _upload(client, headers, account_id, _csv(FIRST_ROW))

        await db_session.execute(
            text(
                "UPDATE statement_imports SET reconciliation_status = 'running', "
                "reconciliation_started_at = now() WHERE id = :id"
            ),
            {"id": uuid.UUID(session["id"])},
        )
        await db_session.commit()

        refused = await _reconcile(client, headers, session["id"])

        assert refused.status_code == 409, refused.text
        assert refused.json()["detail"] == "RECONCILIATION_RUNNING"
        # The session is readable while it runs: the web renders the running arm
        # and polls this field.
        running = await _session_of(client, headers, session["id"])
        assert running["reconciliation_status"] == "running"

        # Back-dated past twice the time budget = the crashed run.
        await db_session.execute(
            text(
                "UPDATE statement_imports SET reconciliation_started_at = "
                "now() - interval '10 minutes' WHERE id = :id"
            ),
            {"id": uuid.UUID(session["id"])},
        )
        await db_session.commit()

        reclaimed = await _reconcile(client, headers, session["id"])

        assert reclaimed.status_code == 200, reclaimed.text
        assert reclaimed.json()["status"] == "ok"


class TestReconcileFailure:
    async def test_a_provider_outage_is_stored_as_failed_and_answered_503(
        self, make_llm_client: Any
    ) -> None:
        """The import's "never fail because of AI" rule does NOT apply here.

        A reconciliation that produced nothing has nothing to show, so unlike an
        upload this route refuses — 503 because the FILE is fine and retrying
        later is the right advice. What the session keeps is the honest
        ``failed`` plus the provenance trio: "we asked this model and got
        nothing" is the diagnosable fact, and the previous report (if any) must
        be gone, because ``ok`` means "there is a document". ``reconciled_at``
        goes with it: it dates the REPORT, not the attempt (D-R5), so a failure
        leaves it NULL — the reason is in the log, not in a timestamp.
        """
        client = await make_llm_client(llm=FakeProvider("fake"))
        headers = await _register_and_login(client, "reconcile-fail@example.com")
        account_id = await _byn_account(client, headers)
        session = await _upload(client, headers, account_id, _csv(FAILING_ROW))

        answered = await _reconcile(client, headers, session["id"])

        assert answered.status_code == 503, answered.text
        assert answered.json()["detail"] == "AI_UNAVAILABLE"
        session_read = await _session_of(client, headers, session["id"])
        assert session_read["reconciliation_status"] == "failed"
        assert session_read["reconciliation_counts"] is None
        assert session_read["reconciliation_summary"] is None
        assert session_read["reconciled_at"] is None
        stored = await _report(client, headers, session["id"])
        assert stored["status"] == "failed"
        assert stored["items"] == []
        assert (stored["provider"], stored["model"], stored["prompt_version"]) == (
            "fake",
            "fake",
            PROMPT_VERSION,
        )

    async def test_too_many_open_items_is_refused_before_any_model_call(
        self, make_llm_client: Any
    ) -> None:
        """The one budget that refuses instead of degrading, and it costs nothing.

        An unbounded list in a prompt is what no token budget can fix, so the
        refusal has to come before the first call — asserted by the provider's
        own call counter, which the upload's categorize pass already moved.
        """
        provider = CountingProvider()
        client = await make_llm_client(llm=provider, reconcile_max_items_per_side=1)
        headers = await _register_and_login(client, "reconcile-large@example.com")
        account_id = await _byn_account(client, headers)
        session = await _upload(
            client, headers, account_id, _csv(FIRST_ROW, SECOND_ROW)
        )
        before = provider.calls

        refused = await _reconcile(client, headers, session["id"])

        assert refused.status_code == 422, refused.text
        assert refused.json()["detail"] == "RECONCILIATION_TOO_LARGE"
        assert provider.calls == before
        # Nothing claimed: the refusal is before the claim, so a user who fixes
        # the session is not locked out for two minutes.
        session_read = await _session_of(client, headers, session["id"])
        assert session_read["reconciliation_status"] == "none"


class TestReconcileGates:
    async def test_a_server_without_a_provider_refuses_and_claims_nothing(
        self, make_llm_client: Any
    ) -> None:
        """503 AI_NOT_CONFIGURED from the dependency, before the handler runs.

        Also the never-reconciled READ: 200 with ``status='none'`` and no items,
        because a 404 for "no report yet" would be a second code path for one
        resource — and therefore indistinguishable from a foreign id.
        """
        client = await make_llm_client()
        headers = await _register_and_login(client, "reconcile-none@example.com")
        account_id = await _byn_account(client, headers)
        session = await _upload(client, headers, account_id, _csv(FIRST_ROW))

        refused = await _reconcile(client, headers, session["id"])

        assert refused.status_code == 503, refused.text
        assert refused.json()["detail"] == "AI_NOT_CONFIGURED"
        never = await _report(client, headers, session["id"])
        assert never["status"] == "none"
        assert never["items"] == []
        assert never["counts"]["missing_in_app"] == 0
        assert never["summary"] is None
        assert (never["provider"], never["reconciled_at"]) == (None, None)
        assert (await _session_of(client, headers, session["id"]))[
            "reconciliation_status"
        ] == "none"

    async def test_another_users_session_is_the_routers_ordinary_404(
        self, make_llm_client: Any
    ) -> None:
        """Foreign and missing share ONE path on both routes (no-oracle).

        Asserted on the POST too, and deliberately: its existence gate runs
        before the claim, so a stranger must not be able to tell a real session
        id from an invented one by watching for a 409.
        """
        client = await make_llm_client(llm=FakeProvider("fake"))
        owner = await _register_and_login(client, "reconcile-owner@example.com")
        account_id = await _byn_account(client, owner)
        session = await _upload(client, owner, account_id, _csv(FIRST_ROW))
        stranger = await _register_and_login(client, "reconcile-other@example.com")

        foreign_post = await _reconcile(client, stranger, session["id"])
        foreign_get = await client.get(
            f"/statement-imports/{session['id']}/reconciliation", headers=stranger
        )
        missing_get = await client.get(
            f"/statement-imports/{uuid.uuid4()}/reconciliation", headers=stranger
        )

        assert foreign_post.status_code == 404
        assert foreign_post.json()["detail"] == "IMPORT_NOT_FOUND"
        assert foreign_get.status_code == 404
        assert missing_get.json() == foreign_get.json()
