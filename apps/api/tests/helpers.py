"""Cross-file test helpers (imported as ``from helpers import ...``).

Four things live here. One is resolving the account a transaction must be booked to.
Since the accounts-and-transfers scope ``POST /transactions`` requires an
``account_id`` and stamps the row's currency from that account, every test file
that books money needs an account whose currency matches what the test is about.
Duplicating that get-or-create in nine files is exactly the copy-paste the
conftest rule exists to prevent — and it is a plain function rather than a fixture
because the per-file ``_create_tx`` helpers that need it are called from ~40 sites
that take no fixtures.

The third is the OAuth consent flow (``connect_oauth_app`` and the pieces it is
built from): two test files need a working grant, and the five requests it takes
to produce one — DCR, authorize, read the request, decide it, exchange the code —
are the flow itself and must be driven exactly once in the suite.

The other is the synthetic Credo workbook builder: an xlsx fixture cannot be a
checked-in file that anyone can read, so it is BUILT from the tables below — and
built by a function rather than a fixture because half the parser tests need a
deliberately broken variant of it.
"""

import asyncio
import base64
import hashlib
import io
import secrets
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from urllib.parse import parse_qs, quote, urlsplit

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


#: A loopback callback, which is what Claude Code and Claude Desktop register.
#: The port is deliberately present: the port-agnostic match is a THING TO PROVE
#: (tests/test_oauth_server.py), not something to dodge by registering none.
OAUTH_REDIRECT_URI = "http://localhost:4242/cb"


def pkce_pair() -> tuple[str, str]:
    """A PKCE ``(verifier, S256 challenge)`` pair, built the way a client builds it."""
    verifier = secrets.token_urlsafe(48)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return verifier, challenge


@dataclass(frozen=True)
class ConnectedApp:
    """Everything a test needs about one completed consent flow."""

    client_id: str
    client_secret: str | None
    access_token: str
    refresh_token: str
    #: The consumed code and its verifier — the replay test re-presents both.
    code: str
    verifier: str
    redirect_uri: str
    #: The grant row's id, as ``GET /oauth/apps`` reports it.
    grant_id: str


async def register_oauth_client(
    client: AsyncClient, **overrides: Any
) -> dict[str, Any]:
    """RFC 7591 dynamic client registration. Returns the 201 body."""
    body: dict[str, Any] = {
        "redirect_uris": [OAUTH_REDIRECT_URI],
        "client_name": "Test AI app",
        "response_types": ["code"],
        "grant_types": ["authorization_code", "refresh_token"],
        "token_endpoint_auth_method": "none",
    }
    body.update(overrides)
    resp = await client.post("/oauth/register", json=body)
    assert resp.status_code == 201, resp.text
    registered: dict[str, Any] = resp.json()
    return registered


def basic_auth_header(client_id: str, secret: str) -> dict[str, str]:
    """RFC 6749 §2.3.1 credentials: both halves percent-encoded, then base64."""
    pair = f"{quote(client_id, safe='')}:{quote(secret, safe='')}"
    encoded = base64.b64encode(pair.encode("utf-8")).decode("ascii")
    return {"Authorization": f"Basic {encoded}"}


def consent_request_id(location: str) -> str:
    """The ``?req=`` of the consent URL ``/oauth/authorize`` redirects to."""
    return parse_qs(urlsplit(location).query)["req"][0]


def redirect_params(redirect_to: str) -> dict[str, str]:
    """The query of an authorization response, flattened."""
    return {k: v[0] for k, v in parse_qs(urlsplit(redirect_to).query).items()}


async def connect_oauth_app(
    client: AsyncClient,
    headers: dict[str, str],
    *,
    scope: str = "read",
    **register_overrides: Any,
) -> ConnectedApp:
    """Drive the whole flow once: DCR → authorize → consent → token.

    ``headers`` is the user's JWT session — the browser half of the flow, which is
    what the consent routes authenticate.
    """
    registered = await register_oauth_client(client, **register_overrides)
    client_id: str = registered["client_id"]
    client_secret: str | None = registered.get("client_secret")
    verifier, challenge = pkce_pair()
    redirect_uri: str = str(registered["redirect_uris"][0])

    started = await client.get(
        "/oauth/authorize",
        params={
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": "client-nonce",
        },
    )
    assert started.status_code == 302, started.text
    request_id = consent_request_id(started.headers["location"])

    decided = await client.post(
        f"/oauth/requests/{request_id}/decision",
        json={"decision": "allow", "scope": scope},
        headers=headers,
    )
    assert decided.status_code == 200, decided.text
    code = redirect_params(decided.json()["redirect_to"])["code"]

    form: dict[str, str] = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "client_id": client_id,
        "code_verifier": verifier,
    }
    token_headers: dict[str, str] = {}
    if client_secret is not None:
        # Where the secret travels is the method's whole difference: the header for
        # ``client_secret_basic``, the form for ``client_secret_post``.
        if registered["token_endpoint_auth_method"] == "client_secret_basic":
            token_headers = basic_auth_header(client_id, client_secret)
        else:
            form["client_secret"] = client_secret
    exchanged = await client.post("/oauth/token", data=form, headers=token_headers)
    assert exchanged.status_code == 200, exchanged.text
    tokens = exchanged.json()

    listed = await client.get("/oauth/apps", headers=headers)
    assert listed.status_code == 200, listed.text
    grant_id: str = listed.json()["items"][0]["id"]

    return ConnectedApp(
        client_id=client_id,
        client_secret=client_secret,
        access_token=tokens["access_token"],
        refresh_token=tokens["refresh_token"],
        code=code,
        verifier=verifier,
        redirect_uri=redirect_uri,
        grant_id=grant_id,
    )
