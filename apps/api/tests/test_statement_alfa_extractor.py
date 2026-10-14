"""The Alfa PDF extraction — the text seam, one real PDF, and the upload gate.

What only this file can prove (pdf-reconcile S3):

* the DETERMINISTIC half: which lines are operations (a wrapped one is joined, a
  tail-less one is still read, the furniture is not), what the header anchors are,
  and that a missing anchor refuses the statement BEFORE a single token is spent;
* the SERVER's half of the model's answer: money at the statement exponent, the FX
  pair kept only when it says something, a structurally unusable row refusing the
  WHOLE extraction rather than storing a hole;
* the SELF-CHECK as data: a statement that does not add up is returned with all
  its rows and only ``apply``/``replace`` refuse it;
* that a real PDF goes in one end and the same rows come out the other.

Everything drives TEXT (architecture D-E2) except ``TestAlfaPdf``, the one test
that opens a file: the text fixture below is a statement a human can read, and it
carries every trap of the format at once.

The provider is always ``FakeProvider("fake")`` — a regex over the known line
layout, deliberately not an oracle. No test here asserts anything the fake
INVENTED; what is asserted is what the extractor did with the answer.
"""

from collections.abc import Sequence
from datetime import date
from pathlib import Path
from typing import Any

import pytest
from helpers import create_account
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.llm import LLMProvider, LLMRequest, LLMResponse
from budget_api.llm.fake import FAIL_MARKER, FakeProvider
from budget_api.models import StatementImport, Transaction
from budget_api.services.statement_import.alfa_pdf import (
    PROMPT_FINGERPRINTS,
    PROMPT_VERSION,
    ExtractConfig,
    StatementExtractionError,
    extract,
    extract_from_text,
    prompt_fingerprint,
    text_lines,
)
from budget_api.services.statement_import.types import (
    ParsedStatement,
    StatementParseError,
)

FORMAT = "alfa_pdf_v1"
PASSWORD = "password123"
FIXTURES = Path(__file__).parent / "fixtures" / "alfa"

#: What ``tests/fixtures/alfa/make_fixtures.py`` printed into ``alfa_good.pdf``
#: and, shifted by ``MISMATCH_MINOR``, into ``alfa_mismatch.pdf``. Part of the
#: fixture contract: the generator computes the anchors from its operations, so
#: these numbers change only when the fixtures are regenerated on purpose.
PDF_CLOSING_MINOR = 176_164
PDF_OPERATIONS = 25
PDF_MISMATCH_MINOR = 1_250

# --- the text fixture ------------------------------------------------------
# Hand-written, like ``helpers.build_credo_xlsx``'s grid: every trap of the
# format in nine operations, and the arithmetic below closes on purpose.
#   income  = 1400 + 100 + 100                            = 1600.00
#   expense = 35.5 + 99.9 + 9 + 1200 + 10 + 100           = 1454.40
#   closing = 1000 + 1600 - 1454.40                       = 1145.60

OPENING_MINOR = 100_000
CLOSING_MINOR = 114_560
INCOME_MINOR = 160_000
EXPENSE_MINOR = 145_440

#: The header block, in the real file's label order — including its PII lines
#: (nothing of which may ever appear in a row) and the WRAPPED
#: "Баланс на начало" / "периода …" label, which is why anchors are searched over
#: the joined header text and not per line.
HEADER: tuple[str, ...] = (
    'ЗАКРЫТОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО "АЛЬФА-БАНК"',
    "Выписка по операциям, совершенным по банковскому счету Текущий счёт, "
    "ИВАНОВ ИВАН ИВАНОВИЧ",
    "Клиент ИВАНОВ ИВАН ИВАНОВИЧ",
    "Документ, удостоверяющий личность паспорт AB1234567",
    "Адрес регистрации г. Минск, ул. Придуманная, д. 1",
    "Счёт BY00ALFA00000000000000000000",
    "Валюта счёта BYN",
    "Тип счёта Текущий счёт",
    "Дата открытия 01.02.2020",
    "Процентная ставка, текущая 0.001%",
    "Период 01.09.2026 - 30.09.2026",
    "Дата и время формирования выписки 01.10.2026, 09:15",
    "Доступный остаток 1145.6 BYN",
    "Кредитный лимит 0 BYN",
    "Неснижаемый остаток 0 BYN",
    "Баланс на начало",
    "периода 1000 BYN",
    "Баланс на конец периода 1145.6 BYN",
    "Приход 1600 BYN",
    "Расход -1454.4 BYN",
    "Привязанные карты Альфа-Смарт(5***********1234)",
    "Выписка за период 01.09.2026 - 30.09.2026",
)

#: The column titles as ``pypdf`` reads them: the first two in one line, the two
#: money columns broken into fragments. Repeated on every page.
TABLE_HEADER: tuple[str, ...] = (
    "Дата Примечание Сумма в",
    "валюте",
    "счета",
    "Сумма в",
    "валюте",
    "операции",
)

#: Page 1. The salary line carries two more dates and a № INSIDE its description
#: (the date trap); the ERIP line has no merchant; one purchase is in RUB.
PAGE_1: tuple[str, ...] = (
    "05.09.2026 Зачисление заработной платы за август 2026 согласно ведомости "
    "№ 77 от 03.09.2026 1400 BYN 1400 BYN",
    "07.09.2026 Зачисление перевода Мария Придуманная 06.09.2026 100 BYN 100 BYN",
    "09.09.2026 12345678 ALMATY Покупка товара / получение услуг ONLINE SHOP KZ "
    "-35.5 BYN -4500 RUB",
    '10.09.2026 87654321 MINSK Покупка товара / получение услуг SHOP "SANTA-362" '
    "-99.9 BYN -99.9 BYN",
    "11.09.2026 11223344 ONLINE SERVICE InSync (ERIP) -9 BYN -9 BYN",
    "12.09.2026 Перевод средств на помощь ребенку М ария -1200 BYN -1200 BYN",
)

#: Page 2. A zero turnover, a line whose amount block the SERVER regex cannot
#: read ("-10." — a trailing point the format never promised), a purchase the
#: PDF wrapped onto a second line, and an income line whose description ENDS in a
#: digit token right before a three-digit amount ("… по чеку 12 100 BYN 100 BYN"):
#: read with a plain space as a thousands separator, the trailing block would
#: start one token early, swallow the "12" out of the description and count a
#: phantom tail mismatch.
PAGE_2: tuple[str, ...] = (
    "13.09.2026 55667788 MINSK Покупка товара / получение услуг ZERO SHOP 0 BYN 0 BYN",
    "14.09.2026 Вознаграждение за обслуживание -10. BYN -10. BYN",
    "15.09.2026 99887766 G. MINSK Покупка товара / получение услуг BIG MARKET",
    "SUPERSTORE -100 BYN -100 BYN",
    "20.09.2026 Зачисление возврата по чеку 12 100 BYN 100 BYN",
)

#: The tail-less line's description: the line minus its leading date, collapsed —
#: amount block and all, because the server could not recognize one (ruling
#: FLAG-2).
TAIL_LESS_DESCRIPTION = "Вознаграждение за обслуживание -10. BYN -10. BYN"


def alfa_text(
    *,
    header: Sequence[str] = HEADER,
    page_1: Sequence[str] = PAGE_1,
    page_2: Sequence[str] = PAGE_2,
) -> list[str]:
    """The statement as ``text_lines`` would hand it over, with page furniture."""
    return [
        *header,
        *TABLE_HEADER,
        *page_1,
        "1 / 2",
        *TABLE_HEADER,
        *page_2,
        "2 / 2",
    ]


def without(label: str, *, header: Sequence[str] = HEADER) -> list[str]:
    return [line for line in header if not line.startswith(label)]


def many_lines(count: int) -> list[str]:
    """A statement of ``count`` identical 1.00 purchases, anchors computed to fit."""
    operations = [
        f"05.09.2026 1000000{index} MINSK Покупка товара / получение услуг "
        f"SHOP {index} -1 BYN -1 BYN"
        for index in range(count)
    ]
    header = [
        "Валюта счёта BYN",
        "Период 01.09.2026 - 30.09.2026",
        "Баланс на начало",
        "периода 1000 BYN",
        f"Баланс на конец периода {1000 - count} BYN",
        "Приход 0 BYN",
        f"Расход -{count} BYN",
    ]
    return alfa_text(header=header, page_1=operations, page_2=())


def config(**overrides: Any) -> ExtractConfig:
    defaults: dict[str, Any] = {
        "lines_per_call": 60,
        "concurrency": 4,
        "time_budget_seconds": 60,
        "max_lines": 2000,
    }
    return ExtractConfig(**{**defaults, **overrides})


class CountingProvider:
    """``FakeProvider`` plus a call counter — "no call was made" is an assertion."""

    name = "fake"
    model = "fake"

    def __init__(self) -> None:
        self.calls = 0
        self._inner = FakeProvider("fake")

    async def complete(self, request: LLMRequest) -> LLMResponse:
        self.calls += 1
        return await self._inner.complete(request)


async def run_extraction(
    lines: Sequence[str],
    *,
    provider: LLMProvider | None = None,
    quota: bool = True,
    **config_overrides: Any,
) -> ParsedStatement:
    return await extract_from_text(
        lines,
        provider if provider is not None else FakeProvider("fake"),
        config(**config_overrides),
        lambda _lines: quota,
        user_id="test",
    )


class TestAlfaExtraction:
    """``extract_from_text`` over the text fixture — the whole deterministic half."""

    async def test_the_statement_reads_as_the_file_spells_it(self) -> None:
        """One pass over every trap at once: anchors, rows, money, flags.

        One test rather than ten, because they are one statement and the
        interesting thing about each trap is that it survives ALONGSIDE the
        others: a continuation joined but a page header not, a wrapped anchor
        label read, a tail the regex cannot parse still sent to the model.
        """
        statement = await run_extraction(alfa_text())

        assert statement.source_format == FORMAT
        assert statement.currency == "BYN"
        assert (statement.period_from, statement.period_to) == (
            date(2026, 9, 1),
            date(2026, 9, 30),
        )
        # The WRAPPED label is the one anchor a per-line search would miss, and it
        # is the shape the real file has.
        assert statement.opening_balance_minor == OPENING_MINOR
        assert statement.closing_balance_minor == CLOSING_MINOR
        assert statement.self_check is not None
        assert statement.self_check.status == "passed"
        # Nine operation lines: the zero one is counted and dropped, the wrapped
        # one is ONE row (the continuation joined), and the two repeated page
        # headers and the two footers are not rows at all.
        assert statement.rows_zero_skipped == 1
        assert [row.row_index for row in statement.rows] == list(range(9))
        assert [(row.kind, row.amount_minor) for row in statement.rows] == [
            ("income", 140_000),
            ("income", 10_000),
            ("expense", 3_550),
            ("expense", 9_990),
            ("expense", 900),
            ("expense", 120_000),
            ("expense", 1_000),
            ("expense", 10_000),
            ("income", 10_000),
        ]
        by_index = {row.row_index: row for row in statement.rows}
        # The FX line keeps the pair; every same-currency line drops it — the file
        # prints the same number twice there and a stored second copy would make
        # every row look like a conversion.
        assert (by_index[2].original_amount_minor, by_index[2].original_currency) == (
            450_000,
            "RUB",
        )
        assert all(
            (row.original_amount_minor, row.original_currency) == (None, None)
            for index, row in by_index.items()
            if index != 2
        )
        # The merchant is the name or ``""`` — NEVER None for a sentence-shaped
        # format (``types.display_name``).
        assert by_index[3].merchant == 'SHOP "SANTA-362"'
        assert by_index[4].merchant == ""
        assert all(row.merchant is not None for row in statement.rows)
        # The description is the SERVER's cut: the leading date and the trailing
        # amount block gone, whitespace collapsed, the file's own word artefacts
        # ("М ария") verbatim.
        assert by_index[5].description == "Перевод средств на помощь ребенку М ария"
        assert by_index[7].description == (
            "99887766 G. MINSK Покупка товара / получение услуг BIG MARKET SUPERSTORE"
        )
        # Both P2P wordings flag, and nothing else does.
        assert [row.row_index for row in statement.rows if row.possible_transfer] == [
            1,
            5,
        ]
        # A line whose tail the regex cannot read is still a row — its description
        # is simply the whole line minus the date (ruling FLAG-2).
        assert by_index[6].description == TAIL_LESS_DESCRIPTION
        # ``raw`` carries the line and NOTHING else: the header's PII never
        # reaches the database (D-E4).
        assert set(by_index[6].raw) == {"line"}
        assert by_index[6].raw["line"].startswith("14.09.2026 ")
        # …and a description that ENDS in a digit token keeps it: the trailing
        # amount block groups thousands with NBSP only, so "12 100" is never read
        # as one number here (the tail is "100 BYN 100 BYN", which also agrees
        # with the row — no phantom mismatch in the summary count).
        assert by_index[8].description == "Зачисление возврата по чеку 12"

    async def test_a_missing_anchor_refuses_before_any_provider_call(self) -> None:
        """No closing balance, no statement — and no token spent proving it.

        The anchors are the only independent source the model's rows are checked
        against, so a statement without one could never prove itself. It is also
        the shape of a format drift, which must cost nothing.
        """
        provider = CountingProvider()

        with pytest.raises(StatementParseError):
            await run_extraction(
                alfa_text(header=without("Баланс на конец периода")),
                provider=provider,
            )

        assert provider.calls == 0

    async def test_a_statement_that_does_not_add_up_is_returned_and_flagged(
        self,
    ) -> None:
        """The self-check is DATA: both numbers, and all the rows.

        The user is the only one who can tell us WHICH line was misread, and they
        can only do that by looking at the preview — so the session is created and
        only ``apply``/``replace`` refuse it (migration 0019 + apply's gate).
        """
        header = [
            *without("Баланс на конец периода"),
            "Баланс на конец периода 1155.6 BYN",
        ]

        statement = await run_extraction(alfa_text(header=header))

        assert statement.self_check is not None
        assert statement.self_check.status == "failed"
        assert statement.self_check.failed == "balance"
        assert statement.self_check.expected_minor == CLOSING_MINOR + 1_000
        assert statement.self_check.actual_minor == CLOSING_MINOR
        assert len(statement.rows) == 9

    async def test_an_unusable_row_refuses_the_whole_extraction(self) -> None:
        """A hole is never stored half-read — ``invalid_output``, both ways.

        Two shapes of "unusable", because the server refuses both for the same
        reason: an amount with more decimals than the currency HAS (a misread
        column, not a number to round) and a line the model did not answer at all.
        A statement missing one line cannot pass its own sum check, and a half row
        cannot become a ``ParsedRow``.
        """
        three_decimals = (
            "16.09.2026 44556677 MINSK Покупка товара / получение услуг "
            "ROUNDING -1.234 BYN -1.234 BYN"
        )
        unanswerable = "17.09.2026 Строка без суммы и без валюты"

        for line in (three_decimals, unanswerable):
            with pytest.raises(StatementExtractionError) as refused:
                await run_extraction(alfa_text(page_2=(*PAGE_2, line)))
            assert refused.value.code == "invalid_output"

    async def test_lines_are_chunked_and_the_union_is_one_statement(self) -> None:
        """One line past the chunk size → two calls, and nothing lost between them.

        The keys the prompt uses are GLOBAL line indices for exactly this: two
        chunks numbering their lines from 1 would collide, and the validation of
        the union would then silently answer one line twice.
        """
        provider = CountingProvider()

        statement = await run_extraction(
            many_lines(61), provider=provider, lines_per_call=60
        )

        assert provider.calls == 2
        assert [row.row_index for row in statement.rows] == list(range(61))
        assert statement.self_check is not None
        assert statement.self_check.status == "passed"

    async def test_a_provider_outage_is_an_unavailable_extraction(self) -> None:
        """``LLMFAIL`` in a line → ``unavailable``, which the router answers 503 to.

        The code matters, not just the refusal: a 422 would tell the user their
        file is bad and send them looking for a better one.
        """
        failing = (
            f"16.09.2026 Покупка товара / получение услуг {FAIL_MARKER} -1 BYN -1 BYN"
        )

        with pytest.raises(StatementExtractionError) as refused:
            await run_extraction(alfa_text(page_2=(*PAGE_2, failing)))

        assert refused.value.code == "unavailable"

    async def test_the_quota_refuses_before_the_first_call(self) -> None:
        """The daily line budget is asked once, for the whole file, before any call."""
        provider = CountingProvider()

        with pytest.raises(StatementExtractionError) as refused:
            await run_extraction(alfa_text(), provider=provider, quota=False)

        assert refused.value.code == "quota"
        assert provider.calls == 0

    def test_the_prompt_fingerprint_is_pinned(self) -> None:
        """Editing the prompt or the schema without bumping the version fails here.

        The categorize precedent: the version is stamped on every log line and
        every evals report, and a silent edit would invalidate both.
        """
        assert PROMPT_FINGERPRINTS[PROMPT_VERSION] == prompt_fingerprint()


class TestAlfaPdf:
    """The ONE test that opens a PDF: ``pypdf`` → the same rows as text gives."""

    async def test_a_real_pdf_yields_one_line_per_operation(self) -> None:
        """What ``pypdf`` hands over IS the input this extractor was written for.

        The committed fixture is two pages with a wrapped description and repeated
        column titles, so this also pins that the page furniture never becomes a
        row — and it is the only place a ``pypdf`` upgrade that changes the text
        layout would be caught.
        """
        data = (FIXTURES / "alfa_good.pdf").read_bytes()

        lines = text_lines(data)
        statement = await extract(
            data,
            FakeProvider("fake"),
            config(),
            lambda _lines: True,
            user_id="test",
        )

        assert sum(1 for line in lines if line.startswith("01.09.2026 ")) == 1
        # 25 operation lines, one of them zero, one of them wrapped by the PDF.
        assert len(statement.rows) == PDF_OPERATIONS - 1
        assert statement.rows_zero_skipped == 1
        assert statement.closing_balance_minor == PDF_CLOSING_MINOR
        assert statement.self_check is not None
        assert statement.self_check.status == "passed"
        wrapped = next(
            row for row in statement.rows if "BOLSHOY GIPERMARKET" in row.description
        )
        assert wrapped.description.endswith("SEKCIYA PYAT")
        assert wrapped.amount_minor == 20_311


class TestAlfaUpload:
    """The upload route: the per-format provider gate and a failed self-check."""

    async def test_a_pdf_needs_a_provider_but_a_csv_does_not(
        self,
        make_llm_client: Any,
        statement_csv_bytes: bytes,
    ) -> None:
        """The gate is per FORMAT, not per server (D-E10).

        A server with no provider must keep accepting the formats it can read
        deterministically — otherwise turning the AI off would take the whole
        import feature with it.
        """
        client: AsyncClient = await make_llm_client(llm=None)
        headers = await _login(client, "alfa-no-llm@example.com")
        # ONE account, both formats: the Priorbank fixture is a BYN statement
        # too, and the refused PDF stored nothing to supersede.
        account_id = await _account(client, headers, "BYN")

        refused = await _upload(
            client,
            headers,
            account_id,
            (FIXTURES / "alfa_good.pdf").read_bytes(),
            FORMAT,
        )
        csv = await _upload(
            client,
            headers,
            account_id,
            statement_csv_bytes,
            "priorbank_csv_v1",
            "s.csv",
        )

        assert refused.status_code == 503, refused.text
        assert refused.json()["detail"] == "AI_NOT_CONFIGURED"
        assert csv.status_code == 201, csv.text

    async def test_a_failed_self_check_previews_but_never_applies(
        self,
        make_llm_client: Any,
        db_session: AsyncSession,
    ) -> None:
        """The whole refusal, end to end from the PDF that caused it.

        ``alfa_mismatch.pdf`` prints a closing balance ``PDF_MISMATCH_MINOR``
        higher than its own operations give. The session is created (the user has
        to see the rows to find the misread line), the write is refused, and
        everything that is not a write still works — including the DELETE that
        lets them start over.
        """
        client: AsyncClient = await make_llm_client(llm=FakeProvider("fake"))
        headers = await _login(client, "alfa-mismatch@example.com")
        account_id = await _account(client, headers, "BYN")

        created = await _upload(
            client,
            headers,
            account_id,
            (FIXTURES / "alfa_mismatch.pdf").read_bytes(),
            FORMAT,
        )

        assert created.status_code == 201, created.text
        session_body: dict[str, Any] = created.json()
        assert session_body["self_check_status"] == "failed"
        assert session_body["self_check_failed"] == "balance"
        assert session_body["self_check_expected_minor"] == (
            PDF_CLOSING_MINOR + PDF_MISMATCH_MINOR
        )
        assert session_body["self_check_actual_minor"] == PDF_CLOSING_MINOR
        import_id = session_body["id"]

        applied = await client.post(
            f"/statement-imports/{import_id}/apply", json={"rows": []}, headers=headers
        )
        assert applied.status_code == 422, applied.text
        assert applied.json()["detail"] == "STATEMENT_BALANCE_MISMATCH"
        assert (
            await db_session.scalar(select(func.count()).select_from(Transaction)) == 0
        )

        rows = await client.get(f"/statement-imports/{import_id}/rows", headers=headers)
        assert rows.status_code == 200, rows.text
        patched = await client.patch(
            f"/statement-imports/{import_id}/rows/{rows.json()['items'][0]['id']}",
            json={"decision": "skip"},
            headers=headers,
        )
        assert patched.status_code == 200, patched.text

        deleted = await client.delete(
            f"/statement-imports/{import_id}", headers=headers
        )
        assert deleted.status_code == 204, deleted.text
        assert (
            await db_session.scalar(select(func.count()).select_from(StatementImport))
            == 0
        )


async def _login(client: AsyncClient, email: str) -> dict[str, str]:
    registered = await client.post(
        "/auth/register", json={"email": email, "password": PASSWORD}
    )
    assert registered.status_code == 201, registered.text
    login = await client.post(
        "/auth/login", data={"username": email, "password": PASSWORD}
    )
    assert login.status_code == 200, login.text
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


async def _account(client: AsyncClient, headers: dict[str, str], currency: str) -> str:
    account = await create_account(
        client, headers, currency=currency, name=f"Card {currency}"
    )
    return str(account["id"])


async def _upload(
    client: AsyncClient,
    headers: dict[str, str],
    account_id: str,
    data: bytes,
    statement_format: str,
    filename: str = "statement.pdf",
) -> Any:
    return await client.post(
        "/statement-imports",
        files={"file": (filename, data, "application/pdf")},
        data={"account_id": account_id, "format": statement_format},
        headers=headers,
    )
