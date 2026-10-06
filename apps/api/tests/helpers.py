"""Cross-file test helpers (imported as ``from helpers import ...``).

Three things live here. One is resolving the account a transaction must be booked to.
Since the accounts-and-transfers scope ``POST /transactions`` requires an
``account_id`` and stamps the row's currency from that account, every test file
that books money needs an account whose currency matches what the test is about.
Duplicating that get-or-create in nine files is exactly the copy-paste the
conftest rule exists to prevent — and it is a plain function rather than a fixture
because the per-file ``_create_tx`` helpers that need it are called from ~40 sites
that take no fixtures.

The other is the synthetic Credo workbook builder: an xlsx fixture cannot be a
checked-in file that anyone can read, so it is BUILT from the tables below — and
built by a function rather than a fixture because half the parser tests need a
deliberately broken variant of it.
"""

import asyncio
import io
import uuid
from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any

from httpx import AsyncClient
from openpyxl import Workbook
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.models import Account
from budget_api.services.push_sender import PushSender, PushTarget, SendOutcome

#: The default base currency a freshly registered user's profile carries, so a
#: transaction created without an explicit currency keeps its pre-accounts meaning
#: (stamped base currency, no snapshot).
DEFAULT_TEST_CURRENCY = "RUB"


async def create_account(
    client: AsyncClient, headers: dict[str, str], **body: Any
) -> dict[str, Any]:
    body.setdefault("name", f"Account {body.get('currency', DEFAULT_TEST_CURRENCY)}")
    body.setdefault("currency", DEFAULT_TEST_CURRENCY)
    body.setdefault("type", "card")
    resp = await client.post("/accounts", json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    created: dict[str, Any] = resp.json()
    return created


async def account_for_currency(
    client: AsyncClient, headers: dict[str, str], currency: str | None = None
) -> str:
    """The caller's account in ``currency``, created on first use.

    Reuses an existing one so a test that books five RUB rows still ends up with a
    single account (and therefore one balance to reason about). ``None`` means "the
    test does not care", which maps to the default-currency account.
    """
    wanted = currency or DEFAULT_TEST_CURRENCY
    listed = await client.get(
        "/accounts", params={"include_archived": True}, headers=headers
    )
    assert listed.status_code == 200, listed.text
    for account in listed.json():
        if account["currency"] == wanted and not account["archived"]:
            account_id: str = account["id"]
            return account_id
    return str((await create_account(client, headers, currency=wanted))["id"])


async def add_account(
    session: AsyncSession,
    user_id: uuid.UUID,
    currency: str = DEFAULT_TEST_CURRENCY,
    **kwargs: Any,
) -> Account:
    """Insert an account straight through the ORM, for tests that seed rows directly.

    Flushed, not committed: the caller owns the transaction, exactly as it does for
    the ``Transaction`` rows this account exists to make insertable.
    """
    account = Account(
        user_id=user_id,
        name=kwargs.pop("name", f"{currency} account"),
        currency=currency,
        type=kwargs.pop("type", "card"),
        **kwargs,
    )
    session.add(account)
    await session.flush()
    return account


class FakePushSender(PushSender):
    """The push seam, recording instead of sending: no test reaches a push service.

    Subclasses the real seam without ``super().__init__`` (the fx
    ``_NoNetworkFetcher`` construction): every member the callers touch is
    overridden. ``outcomes`` scripts the push service's answer per endpoint
    (default: delivered); ``sent`` records ``(endpoint, payload)`` in send order.
    """

    def __init__(
        self,
        *,
        enabled: bool = True,
        outcomes: Mapping[str, SendOutcome] | None = None,
    ) -> None:
        self._fake_enabled = enabled
        self.outcomes = dict(outcomes or {})
        self.sent: list[tuple[str, dict[str, str]]] = []

    @property
    def enabled(self) -> bool:
        return self._fake_enabled

    @property
    def public_key(self) -> str | None:
        return "fake-vapid-public-key" if self._fake_enabled else None

    async def send(self, target: PushTarget, payload: dict[str, str]) -> SendOutcome:
        # Yield like a real network call would, so concurrent job runs interleave.
        await asyncio.sleep(0)
        self.sent.append((target.endpoint, payload))
        return self.outcomes.get(target.endpoint, SendOutcome.delivered)


#: The synthetic Credo workbook, as data. Kept here rather than as a checked-in
#: file: an xlsx is a zip nobody can review in a diff, and every trap below has to
#: be READABLE — that is what a fixture of a money parser is for.
CREDO_HEADERS: tuple[str, ...] = (
    "Date",
    "Operation",
    "Turnover (DB)",
    "Turnover (Cr)",
    "Balance",
    "Description",
    "Beneficiary Name",
    "Beneficiary Account",
)

CREDO_DETAILS: tuple[tuple[str, str], ...] = (
    ("Account Holder", "ტესტ ტესტიშვილი"),
    ("Identification Number", "PD0000000"),
    ("Statement Period", "01.08.2026 - 31.08.2026"),
    ("Account Number", "GE00CD0000000000000000"),
    ("Account Currency", "USD"),
    ("Opening Balance", "1,000.00"),
    ("Closing Balance", "1,796.37"),
    ("Income", "1,500.00"),
    ("Expenses", "703.63"),
)

CredoCell = str | float | datetime | None
CredoRow = tuple[CredoCell, ...]

#: One operation per trap of the format, in file order (see the fixture docstring
#: in conftest.py for what each line is there to prove). The dates alternate
#: between a bare 1900 serial and an already-typed datetime because a bank's
#: export may carry either, and the balances chain exactly — the parser refuses a
#: statement whose own arithmetic does not close.
CREDO_ROWS: tuple[CredoRow, ...] = (
    (
        46235,
        "საბარათე ოპერაცია",
        "19.79",
        "",
        "980.21",
        "გადახდა - YANDEX.EDA 56.10 BYN 01.08.2026",
        None,
        None,
    ),
    (
        datetime(2026, 8, 1),
        "საბარათე ოპერაცია",
        "8.08",
        "",
        "972.13",
        'გადახდა - SHOP "SANTA-362" BAPB 22.97 BYN 31.07.2026',
        None,
        None,
    ),
    (
        46236,
        "საბარათე ოპერაცია",
        "13.84",
        "",
        "958.29",
        "გადახდა - Coop Pronto 5241 10.95 CHF 01.08.2026",
        None,
        None,
    ),
    (
        46236,
        "საბარათე ოპერაცია",
        "145.42",
        "",
        "812.87",
        "გადახდა - WWW.SIMPLEWAY.BY 145.42 USD 01.08.2026",
        None,
        None,
    ),
    (
        46237,
        "საბარათე ოპერაცია",
        "200.00",
        "",
        "612.87",
        "განაღდება - PR.NEZAVISIMOSTI, 3/2 200.00 USD 02.08.2026",
        None,
        None,
    ),
    (
        46237,
        "საბარათე ოპერაცია",
        "200.00",
        "",
        "412.87",
        "განაღდება - PR.NEZAVISIMOSTI, 3/2 200.00 USD 02.08.2026",
        None,
        None,
    ),
    (
        46237,
        "სხვა და სხვა საკომისიო",
        "4.00",
        "",
        "408.87",
        "სხვა და სხვა საკომისიო",
        None,
        None,
    ),
    (
        46238,
        "ბარათზე თანხის ჩარიცხვა",
        "",
        "1,500.00",
        "1,908.87",
        "ბარათზე თანხის ჩარიცხვა",
        None,
        None,
    ),
    (
        46238,
        "უნაღდო კონვერტაცია",
        "100.00",
        "",
        "1,808.87",
        "Currency Exchange",
        "ტესტ ტესტიშვილი",
        "GE00CD0000000000000000",
    ),
    (
        46239,
        "ბანკის ახალი ოპერაცია",
        "12.50",
        "",
        "1,796.37",
        "სესხის დაფარვა",
        None,
        None,
    ),
    (
        46239,
        "საბარათე ოპერაცია",
        "0.00",
        "",
        "1,796.37",
        "გადახდა - ZERO SHOP 0.00 BYN 04.08.2026",
        None,
        None,
    ),
)


def build_credo_xlsx(
    *,
    details: Sequence[tuple[str, str]] = CREDO_DETAILS,
    rows: Sequence[CredoRow] = CREDO_ROWS,
    headers: Sequence[str] = CREDO_HEADERS,
    details_sheet: str = "Account Details",
    transactions_sheet: str = "Transactions",
) -> bytes:
    """The synthetic Credo export as the bytes an upload would carry.

    Built with openpyxl rather than stored, so a variant (a drifted header, a row
    whose balance does not close, money in a numeric cell) is one keyword away and
    the difference from the good file is visible in the test that needs it.
    """
    workbook = Workbook()
    sheet = workbook.active
    assert sheet is not None
    sheet.title = details_sheet
    for label, value in details:
        sheet.append([label, value])

    grid = workbook.create_sheet(transactions_sheet)
    grid.append(list(headers))
    for row in rows:
        grid.append(list(row))
        # The bank's dates are serials under a date number format; openpyxl hands
        # such a cell back as a datetime, while a bare number stays a number. Both
        # spellings have to exist in the fixture, so only the typed ones are given
        # the format.
        cell = grid.cell(row=grid.max_row, column=1)
        if isinstance(cell.value, datetime):
            cell.number_format = "yyyy/MM/dd HH:mm:ss"

    buffer = io.BytesIO()
    workbook.save(buffer)
    workbook.close()
    return buffer.getvalue()
