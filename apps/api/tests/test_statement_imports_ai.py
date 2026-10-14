"""The statement import's LLM pass, through the ``app.state.llm`` seam.

Real Postgres, real router, real ``services/categorize`` — the ONLY thing swapped
is the provider (``FakeProvider``, which answers a substring match with no network
at all). What only this layer can prove: which rows are ELIGIBLE, how an answer
becomes row columns, that a provider failure costs the import nothing, and that
``ai_status`` plus the two counted numbers describe what actually happened.

The service's own arms (validation, dedupe, batching, the time budget, the quota
refusal) are covered in ``test_categorize.py`` without a database and are not
re-asserted here.

ONE rule for every assertion below: the fake is a SUBSTRING MATCHER, so a test
must never assert WHICH category it picked — only that a row was seeded at all,
from which source, and with which flags. A test reading the picked category would
be testing the matcher.
"""

import json
import uuid
from typing import Any

from helpers import create_account
from httpx import AsyncClient, Response
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.llm import LLMRequest, LLMResponse, TextPart
from budget_api.llm.fake import FAIL_MARKER, FakeProvider
from budget_api.services.categorize import PROMPT_VERSION

PASSWORD = "password123"
FORMAT = "priorbank_csv_v1"

#: A seed category name (migration 0003, frozen) the fake can find in a row's
#: text. The CSV below carries it inside an upper-case description, which is also
#: the case-insensitivity of the matcher being exercised.
SEED_CATEGORY_NAME = "Продукты"

_HEADER = (
    "Выписка по контракту;;;;;;;;",
    "Клиент;QA USER;;;;;;;",
    "......5817 Валюта контракта BYN;;;;;;;;",
    "Период выписки: с 01.06.2026 по 30.06.2026;;;;;;;;",
    ";;;;;;;;",
    "Операции по ......5817;;;;;;;;",
    "Дата транзакции;Операция;Сумма;Валюта;Дата операции по счету;"
    "Комиссия/Money-back;Обороты по счету;Цифровая карта;Категория операции",
)


def _operation(
    description: str,
    turnover: str,
    *,
    day: int = 2,
    bank_category: str = "Магазины продуктовые",
) -> str:
    """One operations line of the Priorbank grid (positional, see its parser)."""
    return (
        f"{day:02d}.06.2026 10:15:00;{description};;;{day:02d}.06.2026;;"
        f"{turnover};;{bank_category}"
    )


def _csv(*operations: str) -> bytes:
    """A minimal valid Priorbank export around the given operation lines.

    Built per test rather than taken from the shared fixture: what each case needs
    is a SPECIFIC row ("the fake can match this one", "this one makes the call
    fail"), and a file that holds all of them at once would make every assertion
    depend on rows the test does not care about.
    """
    lines = [*_HEADER, *operations, "Всего по контракту;;;;;;0,00;;"]
    return "\r\n".join(lines).encode("cp1251")


#: The fake matches it (case-insensitively) against the seed category name.
MATCHING_ROW = _operation(f"МАГАЗИН {SEED_CATEGORY_NAME.upper()}", "-25,40", day=2)
#: Nothing in the user's category list appears in it → the fake answers "none".
UNSURE_ROW = _operation("PAYBYCARD.BY", "-1,15", day=3, bank_category="Прочие расходы")
#: ``FAIL_MARKER`` in the text makes the fake raise ``LLMError("unavailable")`` for
#: the WHOLE call — the router's "the provider is down" arm without an outage.
FAILING_ROW = _operation(f"TERMINAL {FAIL_MARKER}", "-9,99", day=4)


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
) -> Response:
    return await client.post(
        "/statement-imports",
        files={"file": ("Vpsk_71466782.csv", data, "text/csv")},
        data={"account_id": account_id, "format": FORMAT},
        headers=headers,
    )


async def _rows(
    client: AsyncClient, headers: dict[str, str], import_id: str, **query: Any
) -> list[dict[str, Any]]:
    resp = await client.get(
        f"/statement-imports/{import_id}/rows", params=query, headers=headers
    )
    assert resp.status_code == 200, resp.text
    items: list[dict[str, Any]] = resp.json()["items"]
    return items


def _by_description(rows: list[dict[str, Any]], needle: str) -> dict[str, Any]:
    return next(row for row in rows if needle in row["description"])


class RecordingProvider:
    """``FakeProvider("fake")`` plus the operation texts it was asked about.

    The only way to prove a row was NEVER SENT: an untouched row and a row the
    model refused to answer look the same on the wire, and the difference —
    whether the user's quota and the model's time were spent on it — is exactly
    what eligibility is about.
    """

    def __init__(self) -> None:
        self._inner = FakeProvider("fake")
        self.name = self._inner.name
        self.model = self._inner.model
        self.texts: list[str] = []
        self.calls = 0

    async def complete(self, request: LLMRequest) -> LLMResponse:
        self.calls += 1
        for part in request.messages[-1].content:
            if isinstance(part, TextPart):
                document: Any = json.loads(part.text)
                self.texts.extend(
                    str(operation["text"]) for operation in document["operations"]
                )
        return await self._inner.complete(request)


class TestImportAiPass:
    async def test_an_answer_is_seeded_and_an_unsure_row_is_flagged(
        self, make_llm_client: Any
    ) -> None:
        """One upload, both answers the model can give, and the session's numbers.

        The seeded row is the whole feature: a category the rules did not know
        arrives filled in, marked as the MODEL's guess (``suggestion_source=llm``,
        ``category_user_set`` still false, so the learning maps stay untaught) and
        carrying the sentence the user is shown. The unsure row is the other half
        of the same promise — "not sure" is an answer, and it must cost the user a
        flag rather than a wrong category.

        ``ai_rows_suggested``/``ai_rows_flagged`` come from the in-memory count on
        the 201 here; the read path is pinned by the filter test below.
        """
        client = await make_llm_client(llm=FakeProvider("fake"))
        headers = await _register_and_login(client, "ai-ok@example.com")
        account_id = await _byn_account(client, headers)

        created = await _upload(
            client, headers, account_id, _csv(MATCHING_ROW, UNSURE_ROW)
        )

        assert created.status_code == 201, created.text
        session = created.json()
        assert session["ai_status"] == "ok"
        assert session["ai_provider"] == "fake"
        assert session["ai_model"] == "fake"
        assert session["ai_prompt_version"] == PROMPT_VERSION
        assert (session["ai_rows_suggested"], session["ai_rows_flagged"]) == (1, 1)

        rows = await _rows(client, headers, session["id"])
        seeded = _by_description(rows, "ПРОДУКТЫ")
        assert seeded["suggestion_source"] == "llm"
        # WHICH category the fake picked is the matcher's business; that the two
        # columns agree is the router's.
        assert seeded["category_id"] == seeded["suggested_category_id"]
        assert seeded["category_id"] is not None
        assert seeded["category_user_set"] is False
        assert seeded["ai_confidence"] == 0.9
        assert seeded["ai_reason"]
        assert seeded["needs_review"] is False

        unsure = _by_description(rows, "PAYBYCARD")
        assert unsure["needs_review"] is True
        assert unsure["category_id"] is None
        assert unsure["suggested_category_id"] is None
        assert unsure["suggestion_source"] is None
        assert unsure["ai_confidence"] == 0.2
        # No category was chosen, so there is nothing for a reason to be about.
        assert unsure["ai_reason"] is None

    async def test_a_provider_failure_never_fails_the_import(
        self, make_llm_client: Any
    ) -> None:
        """A dead provider only moves ``ai_status``; the rows stay as parsed.

        Two arms, because the two statuses are two different promises and the
        second cannot be read off the first:

        * nothing answered → ``failed``, every row exactly as the rules left it;
        * something answered, then the provider died → ``partial``, and what DID
          come back is kept. Forced to be deterministic with a batch size and a
          concurrency of one: with the defaults both kinds' batches race, and the
          test would flake between the two statuses.
        """
        client = await make_llm_client(
            llm=FakeProvider("fake"),
            categorize_batch_size=1,
            categorize_concurrency=1,
        )
        headers = await _register_and_login(client, "ai-failed@example.com")
        dead = await _byn_account(client, headers)

        failed = await _upload(client, headers, dead, _csv(FAILING_ROW))

        assert failed.status_code == 201, failed.text
        body = failed.json()
        assert body["ai_status"] == "failed"
        # The provider EXISTED, so its identity is still the honest stamp: "we
        # asked this model and got nothing" is the diagnosable fact.
        assert body["ai_provider"] == "fake"
        assert (body["ai_rows_suggested"], body["ai_rows_flagged"]) == (0, 0)
        untouched = _by_description(
            await _rows(client, headers, body["id"]), FAIL_MARKER
        )
        assert untouched["ai_confidence"] is None
        assert untouched["ai_reason"] is None
        assert untouched["needs_review"] is False
        assert untouched["category_id"] is None

        partial_account = str(
            (await create_account(client, headers, currency="BYN", name="Second"))["id"]
        )
        partial = await _upload(
            client, headers, partial_account, _csv(MATCHING_ROW, FAILING_ROW)
        )

        assert partial.status_code == 201, partial.text
        assert partial.json()["ai_status"] == "partial"
        assert partial.json()["ai_rows_suggested"] == 1
        rows = await _rows(client, headers, partial.json()["id"])
        assert _by_description(rows, "ПРОДУКТЫ")["suggestion_source"] == "llm"
        assert _by_description(rows, FAIL_MARKER)["needs_review"] is False

    async def test_the_daily_quota_is_spent_in_rows_and_refuses_a_whole_batch(
        self, make_llm_client: Any
    ) -> None:
        """The only test that runs the row quota through the REAL limiter.

        ``_row_quota`` hits the shared limiter with ``cost=rows`` — the one piece
        of ``limits`` this app uses nowhere else (every decorated route hits with
        the default cost of one). Every other test here runs with rate limiting
        OFF, so a wrong key or a wrong keyword would ship green. A two-row batch
        against a one-row budget is refused as a whole: no call is made, and the
        upload itself is untouched by it.
        """
        client = await make_llm_client(
            llm=FakeProvider("fake"),
            rate_limit_enabled=True,
            categorize_daily_row_quota="1/day",
        )
        headers = await _register_and_login(client, "ai-quota@example.com")
        account_id = await _byn_account(client, headers)

        created = await _upload(
            client, headers, account_id, _csv(MATCHING_ROW, UNSURE_ROW)
        )

        assert created.status_code == 201, created.text
        session = created.json()
        assert session["ai_status"] == "failed"
        assert (session["ai_rows_suggested"], session["ai_rows_flagged"]) == (0, 0)

    async def test_a_server_without_a_provider_imports_exactly_as_before(
        self, make_llm_client: Any
    ) -> None:
        """``app.state.llm is None`` — the default of every keyless deployment.

        The honest status is ``not_configured`` with no provenance at all, and
        every AI column of every row reads as "nobody looked": this is the arm
        that guarantees the scope changed no existing behaviour on a server that
        has no AI.
        """
        client = await make_llm_client()
        headers = await _register_and_login(client, "ai-off@example.com")
        account_id = await _byn_account(client, headers)

        created = await _upload(
            client, headers, account_id, _csv(MATCHING_ROW, UNSURE_ROW)
        )

        assert created.status_code == 201, created.text
        session = created.json()
        assert session["ai_status"] == "not_configured"
        assert session["ai_provider"] is None
        assert session["ai_model"] is None
        assert session["ai_prompt_version"] is None
        assert (session["ai_rows_suggested"], session["ai_rows_flagged"]) == (0, 0)
        for row in await _rows(client, headers, session["id"]):
            assert row["ai_confidence"] is None
            assert row["ai_reason"] is None
            assert row["needs_review"] is False

    async def test_rules_covered_and_already_imported_rows_are_never_sent(
        self, make_llm_client: Any, db_session: AsyncSession
    ) -> None:
        """Eligibility, proven by what the provider was ASKED, not by the answer.

        Two rows the pass must not spend a token on: one the bank-category map
        already answers (the user's own learned truth beats a guess), and — after
        an apply — every row that is now an ``exact`` match of a transaction the
        app already holds. The second arm is also the ``skipped`` status: a
        provider exists and there was simply nothing to ask.
        """
        provider = RecordingProvider()
        client = await make_llm_client(llm=provider)
        headers = await _register_and_login(client, "ai-eligible@example.com")
        account_id = await _byn_account(client, headers)
        me = await client.get("/users/me", headers=headers)
        assert me.status_code == 200, me.text
        categories = await client.get("/categories", headers=headers)
        category_id = categories.json()[0]["id"]
        # The learned map, written directly: how it got there is the apply path's
        # own test, and this one is about the ROW NOT BEING SENT.
        await db_session.execute(
            text(
                "INSERT INTO bank_category_map (user_id, bank_category, category_id) "
                "VALUES (:user_id, :bank_category, :category_id)"
            ),
            {
                "user_id": uuid.UUID(me.json()["id"]),
                "bank_category": "Прочие расходы",
                "category_id": uuid.UUID(category_id),
            },
        )
        await db_session.commit()

        created = await _upload(
            client, headers, account_id, _csv(MATCHING_ROW, UNSURE_ROW)
        )

        assert created.status_code == 201, created.text
        assert provider.texts == ["МАГАЗИН ПРОДУКТЫ"]
        rows = await _rows(client, headers, created.json()["id"])
        assert (
            _by_description(rows, "PAYBYCARD")["suggestion_source"] == "bank_category"
        )

        applied = await client.post(
            f"/statement-imports/{created.json()['id']}/apply", headers=headers
        )
        assert applied.status_code == 200, applied.text
        calls_before = provider.calls

        again = await _upload(
            client, headers, account_id, _csv(MATCHING_ROW, UNSURE_ROW)
        )

        assert again.status_code == 201, again.text
        assert again.json()["by_match_status"]["exact"] == 2
        assert again.json()["ai_status"] == "skipped"
        assert provider.calls == calls_before

    async def test_a_category_patch_clears_the_review_flag_and_a_decision_does_not(
        self, make_llm_client: Any
    ) -> None:
        """ "The user looked" is the whole content of ``needs_review``.

        Sending a category — a value OR an explicit null — is looking, so the flag
        goes. Choosing what APPLY does with the row is a different question and
        must leave it standing, or "skip all my own records" would silently clear
        every flag the model raised.
        """
        client = await make_llm_client(llm=FakeProvider("fake"))
        headers = await _register_and_login(client, "ai-patch@example.com")
        account_id = await _byn_account(client, headers)
        created = await _upload(
            client, headers, account_id, _csv(UNSURE_ROW, _operation("CAFE", "-5,00"))
        )
        assert created.status_code == 201, created.text
        import_id = created.json()["id"]
        rows = await _rows(client, headers, import_id)
        flagged, other = rows[0], rows[1]
        assert (flagged["needs_review"], other["needs_review"]) == (True, True)
        categories = await client.get("/categories", headers=headers)
        category_id = categories.json()[0]["id"]

        decided = await client.patch(
            f"/statement-imports/{import_id}/rows/{other['id']}",
            json={"decision": "skip"},
            headers=headers,
        )
        assert decided.status_code == 200, decided.text
        assert decided.json()["needs_review"] is True

        patched = await client.patch(
            f"/statement-imports/{import_id}/rows/{flagged['id']}",
            json={"category_id": category_id},
            headers=headers,
        )
        assert patched.status_code == 200, patched.text
        assert patched.json()["needs_review"] is False
        # The model's own record is never rewritten by a later edit: it says what
        # the model said, which does not stop being true.
        assert patched.json()["ai_confidence"] == 0.2

    async def test_the_needs_review_filter_and_the_flag_count_are_read_live(
        self, make_llm_client: Any
    ) -> None:
        """The chip's rows and the chip's number, both counted at read (A2).

        ``?needs_review=`` is ANDed with ``match_status`` and its ``total`` is the
        filtered one, because the preview pages on it. ``ai_rows_flagged`` has to
        fall with the PATCH that answers a flag — a stored counter would still be
        advertising work the user has already done.
        """
        client = await make_llm_client(llm=FakeProvider("fake"))
        headers = await _register_and_login(client, "ai-filter@example.com")
        account_id = await _byn_account(client, headers)
        created = await _upload(
            client, headers, account_id, _csv(MATCHING_ROW, UNSURE_ROW)
        )
        assert created.status_code == 201, created.text
        import_id = created.json()["id"]

        flagged = await client.get(
            f"/statement-imports/{import_id}/rows",
            params={"needs_review": True, "match_status": "new"},
            headers=headers,
        )

        assert flagged.status_code == 200, flagged.text
        assert flagged.json()["total"] == 1
        row = flagged.json()["items"][0]
        assert "PAYBYCARD" in row["description"]

        patched = await client.patch(
            f"/statement-imports/{import_id}/rows/{row['id']}",
            json={"category_id": None},
            headers=headers,
        )
        assert patched.status_code == 200, patched.text

        session = await client.get(f"/statement-imports/{import_id}", headers=headers)
        assert session.status_code == 200, session.text
        assert session.json()["ai_rows_flagged"] == 0
        # The suggested count is independent of the flag and survives the patch.
        assert session.json()["ai_rows_suggested"] == 1
        assert (
            await client.get(
                f"/statement-imports/{import_id}/rows",
                params={"needs_review": True},
                headers=headers,
            )
        ).json()["total"] == 0
