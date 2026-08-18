"""Receipt create + read contracts — real Postgres, real migrations, faked storage.

The storage boundary is mocked at the ``app.state.storage`` seam (the ``Storage``
class surface, D9): a fake is assigned after ``create_app`` so the pytest layer
never touches MinIO or minio-py's URL format. Everything before that boundary — the
route, the DB write, the serializer — runs for real. Covers only what is unique to
this router: the pending-create + presigned-upload shape and the persisted
``storage_path``, the null-parsed GET shape, the no-oracle cross-user 404, and the
per-user rate key (the one place per-user keying can silently regress to per-IP).
"""

import asyncio
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from contextlib import AsyncExitStack
from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from asgi_lifespan import LifespanManager
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.app import create_app
from budget_api.config import Settings
from budget_api.domain.merchant import normalize_merchant
from budget_api.domain.money import to_minor_units
from budget_api.enums import ReceiptStatus
from budget_api.models import Category, MerchantCategoryMap, Receipt

# Plan test 7 (stale-loser drop) calls the guarded terminal UPDATE helper directly,
# as the plan sanctions ("may call _finish_* helpers directly").
from budget_api.routers.receipts import (
    _finish_parsed,  # pyright: ignore[reportPrivateUsage]
)
from budget_api.schemas.receipt import ParsedReceipt, ReceiptItem
from budget_api.services.receipt_parser import (
    CategoryOption,
    ReceiptParseError,
    ReceiptParser,
)
from budget_api.services.storage import PresignedRequest

PASSWORD = "password123"
_FAKE_BASE = "https://fake-s3.test"


class _FakeParser:
    """Stub at the ``app.state.receipt_parser`` seam (the ReceiptParser surface).

    A settable ``result``/``exception`` drives the pipeline outcome; an optional
    ``event`` blocks ``parse`` so the claim-race test can hold a winner mid-parse.
    """

    def __init__(self) -> None:
        self.result: ParsedReceipt | None = None
        self.exception: Exception | None = None
        self.event: asyncio.Event | None = None
        self.calls = 0

    async def parse(
        self, image_jpeg: bytes, categories: Sequence[CategoryOption]
    ) -> ParsedReceipt:
        self.calls += 1
        if self.event is not None:
            await self.event.wait()
        if self.exception is not None:
            raise self.exception
        assert self.result is not None
        return self.result


class _FakeHTTPClient:
    """One fake AsyncClient serving both the HEAD probe and the GET download.

    Patched in at ``budget_api.routers.receipts.httpx.AsyncClient`` so the pipeline's
    real network I/O never leaves the process (per convention: httpx patched at the
    router module).
    """

    def __init__(
        self,
        *,
        head_response: httpx.Response | None = None,
        head_error: Exception | None = None,
        get_response: httpx.Response | None = None,
        get_error: Exception | None = None,
    ) -> None:
        self._head_response = head_response
        self._head_error = head_error
        self._get_response = get_response
        self._get_error = get_error

    async def __aenter__(self) -> "_FakeHTTPClient":
        return self

    async def __aexit__(self, *_: object) -> bool:
        return False

    async def head(self, url: str, **_kwargs: object) -> httpx.Response:
        if self._head_error is not None:
            raise self._head_error
        assert self._head_response is not None
        return self._head_response

    async def get(self, url: str, **_kwargs: object) -> httpx.Response:
        if self._get_error is not None:
            raise self._get_error
        assert self._get_response is not None
        return self._get_response


def _uploaded_http(size: int = 100) -> _FakeHTTPClient:
    """HEAD 200 (given content-length) + GET 200 with dummy JPEG bytes."""
    return _FakeHTTPClient(
        head_response=httpx.Response(200, headers={"content-length": str(size)}),
        # A request must be attached for raise_for_status() to work on a hand-built
        # Response (httpx guards against a detached response).
        get_response=httpx.Response(
            200,
            content=b"\xff\xd8\xff-fake-jpeg",
            request=httpx.Request("GET", "http://fake-s3.test/object"),
        ),
    )


def _sample_parsed(
    *,
    total: str = "12.50",
    currency: str | None = "USD",
    merchant: str | None = "Acme Coffee",
    suggested_category_id: uuid.UUID | None = None,
) -> ParsedReceipt:
    return ParsedReceipt(
        total=total,
        currency=currency,
        merchant=merchant,
        date=date(2026, 7, 1),
        items=[ReceiptItem(name="Coffee", amount="12.50")],
        suggested_category_id=suggested_category_id,
    )


class _FakeStorage:
    """Deterministic stand-in for ``services.storage.Storage`` (same surface).

    Mirrors ``object_path`` exactly (the router persists its result as
    ``storage_path``) and returns canned presign values, so the tests assert against
    the fake, never minio-py's real signed-URL format.
    """

    def object_path(self, user_id: uuid.UUID, receipt_id: uuid.UUID) -> str:
        return f"{user_id}/{receipt_id}.jpg"

    def presign_put(self, path: str) -> PresignedRequest:
        return PresignedRequest(
            url=f"{_FAKE_BASE}/{path}?sig=put",
            method="PUT",
            headers={"Content-Type": "image/jpeg"},
            expires_at=datetime.now(UTC) + timedelta(seconds=600),
        )

    def presign_get(self, path: str) -> str:
        return f"{_FAKE_BASE}/{path}?sig=get"

    def presign_head(self, path: str) -> str:
        return f"{_FAKE_BASE}/{path}?sig=head"


@pytest.fixture
async def make_receipts_client(
    test_database_url: str, test_jwt_secret: str
) -> AsyncIterator[Callable[..., Awaitable[AsyncClient]]]:
    """Factory: a lifespan-managed client whose app has a fake storage seam.

    Not foldable into conftest's ``make_client``: that factory returns only the
    client, and these tests must reach the app to assign ``app.state.storage`` (the
    seam). Rate limiting is off by default; the rate-limit test passes it on.
    """
    async with AsyncExitStack() as stack:

        async def _make(
            storage: object | None = None,
            parser: object | None = None,
            **overrides: object,
        ) -> AsyncClient:
            overrides.setdefault("rate_limit_enabled", False)
            # Non-empty key by default so the parse route runs; the 503 test overrides
            # it to "" to exercise the AI_NOT_CONFIGURED fast-fail gate.
            overrides.setdefault("anthropic_api_key", "test-anthropic-key")
            # Same D3/D5 gates conftest's make_client applies: this local factory
            # bypasses it, and no pytest app here may start a scheduler.
            overrides.setdefault("fx_scheduler_enabled", False)
            overrides.setdefault("recurring_scheduler_enabled", False)
            app = create_app(
                Settings(
                    database_url=test_database_url,
                    jwt_secret=test_jwt_secret,
                    **overrides,  # type: ignore[arg-type]
                )
            )
            app.state.storage = storage if storage is not None else _FakeStorage()
            if parser is not None:
                app.state.receipt_parser = parser
            await stack.enter_async_context(LifespanManager(app))
            transport = ASGITransport(app=app)
            return await stack.enter_async_context(
                AsyncClient(transport=transport, base_url="http://test")
            )

        yield _make


@pytest.fixture
async def client(
    make_receipts_client: Callable[..., Awaitable[AsyncClient]],
) -> AsyncClient:
    return await make_receipts_client()


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
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    return headers, user_id


class TestCreateReceipt:
    async def test_create_receipt_returns_pending_and_upload(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers, user_id = await _register_and_login(client, "rcreate@x.com")

        resp = await client.post("/receipts", headers=headers)

        assert resp.status_code == 201, resp.text
        body = resp.json()
        receipt_id = uuid.UUID(body["id"])
        assert body["status"] == "pending"
        upload = body["upload"]
        assert upload["method"] == "PUT"
        expected_path = f"{user_id}/{receipt_id}.jpg"
        assert upload["url"] == f"{_FAKE_BASE}/{expected_path}?sig=put"
        # Advisory Content-Type (D9/V1): the header is a client hint, surfaced but
        # never enforced by storage.
        assert upload["headers"] == {"Content-Type": "image/jpeg"}
        assert "user_id" not in body  # raw ownership never on the wire

        row = (
            await db_session.execute(
                text(
                    "SELECT user_id, storage_path, status FROM receipts WHERE id = :id"
                ),
                {"id": receipt_id},
            )
        ).one()
        assert row.user_id == user_id  # forced from token
        assert row.storage_path == expected_path
        assert row.status == "pending"


class TestGetReceipt:
    async def test_get_receipt_pending(self, client: AsyncClient) -> None:
        headers, _ = await _register_and_login(client, "rget@x.com")
        created = await client.post("/receipts", headers=headers)
        receipt_id = created.json()["id"]

        resp = await client.get(f"/receipts/{receipt_id}", headers=headers)

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "pending"
        assert body["parsed"] is None
        assert body["suggested_category_id"] is None
        assert body["suggestion_source"] is None
        assert body["error"] is None

    async def test_get_receipt_foreign_is_404(self, client: AsyncClient) -> None:
        headers_a, _ = await _register_and_login(client, "rowner@x.com")
        headers_b, _ = await _register_and_login(client, "rintruder@x.com")
        created = await client.post("/receipts", headers=headers_a)
        receipt_id = created.json()["id"]

        resp = await client.get(f"/receipts/{receipt_id}", headers=headers_b)

        # No-oracle: foreign == missing, byte-identical code.
        assert resp.status_code == 404, resp.text
        assert resp.json() == {"detail": "RECEIPT_NOT_FOUND"}


class TestReceiptRateLimit:
    async def test_create_receipt_rate_limited_per_user(
        self, make_receipts_client: Callable[..., Awaitable[AsyncClient]]
    ) -> None:
        # One app instance (one rate_limit_scope) so the per-user key distinction is
        # what separates the two users' counters.
        client = await make_receipts_client(
            rate_limit_enabled=True, receipt_create_rate_limit="1/minute"
        )
        headers_a, _ = await _register_and_login(client, "rlA@x.com")
        headers_b, _ = await _register_and_login(client, "rlB@x.com")

        first_a = await client.post("/receipts", headers=headers_a)
        second_a = await client.post("/receipts", headers=headers_a)
        first_b = await client.post("/receipts", headers=headers_b)

        assert first_a.status_code == 201, first_a.text
        assert second_a.status_code == 429, second_a.text
        assert second_a.json() == {"detail": "RATE_LIMITED"}
        # Per-user key, not per-IP: user B (same localhost address) is untouched.
        assert first_b.status_code == 201, first_b.text


_ROUTER_HTTPX = "budget_api.routers.receipts.httpx.AsyncClient"


async def _create_receipt(client: AsyncClient, headers: dict[str, str]) -> str:
    resp = await client.post("/receipts", headers=headers)
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _seed_category(
    session: AsyncSession,
    user_id: uuid.UUID,
    *,
    name: str,
    archived: bool = False,
) -> uuid.UUID:
    category = Category(user_id=user_id, name=name, kind="expense", archived=archived)
    session.add(category)
    await session.commit()
    return category.id


async def _wait_for_status(
    client: AsyncClient,
    receipt_id: str,
    headers: dict[str, str],
    target: str,
    *,
    timeout_s: float = 3.0,
) -> None:
    """Poll GET until the receipt reaches ``target`` (or fail). Used by the race test
    to observe the winner's committed claim while it is parked in parse()."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout_s
    while loop.time() < deadline:
        body = (await client.get(f"/receipts/{receipt_id}", headers=headers)).json()
        if body["status"] == target:
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"receipt {receipt_id} never reached status {target!r}")


async def _seed_map(
    session: AsyncSession,
    user_id: uuid.UUID,
    merchant_norm: str,
    category_id: uuid.UUID,
) -> None:
    session.add(
        MerchantCategoryMap(
            user_id=user_id, merchant_norm=merchant_norm, category_id=category_id
        )
    )
    await session.commit()


class TestToMinorUnits:
    """AM-1: the exponent table is LIVE, not a hardcoded x100."""

    def test_exponent_zero_currency_differs_from_default(self) -> None:
        # Same decimal string, different minor units by currency exponent: JPY is
        # exponent 0 (whole units are minor units), USD is exponent 2. A hardcoded
        # x100 would return 123400 for both — the exact cross-layer 100x corruption.
        assert to_minor_units("1234", "JPY") == 1234
        assert to_minor_units("1234", "USD") == 123400


class TestReceiptParserValidation:
    """AM-2: a malformed model total is mapped to INVALID_MODEL_OUTPUT by the parser.

    Deviation from plan test 8's parametrization (flagged to senior-lead): the fake
    parser seam bypasses ``ParsedReceipt`` validation, so a param case there would be
    vacuous (the fake just re-raising the code). Instead this exercises the REAL
    parser mapping a dirty ``record_receipt`` input to INVALID_MODEL_OUTPUT with only
    the Anthropic SDK boundary mocked — proving the validator AND the mapping in one.
    """

    async def test_malformed_total_maps_to_invalid_model_output(
        self, test_database_url: str, test_jwt_secret: str
    ) -> None:
        parser = ReceiptParser(
            Settings(
                database_url=test_database_url,
                jwt_secret=test_jwt_secret,
                anthropic_api_key="test-anthropic-key",
            )
        )
        # A tool_use block whose total is not a bare decimal ("12,50" — comma).
        tool_block = SimpleNamespace(
            type="tool_use",
            name="record_receipt",
            input={"total": "12,50", "items": []},
        )
        parser._client = SimpleNamespace(  # type: ignore[assignment]
            messages=SimpleNamespace(
                create=AsyncMock(return_value=SimpleNamespace(content=[tool_block]))
            )
        )

        with pytest.raises(ReceiptParseError) as exc_info:
            await parser.parse(b"jpeg", [])
        assert exc_info.value.code == "INVALID_MODEL_OUTPUT"


class TestParseReceipt:
    async def test_parse_happy_sets_parsed_and_suggestion(
        self,
        make_receipts_client: Callable[..., Awaitable[AsyncClient]],
        db_session: AsyncSession,
    ) -> None:
        system_cat_id = await db_session.scalar(
            select(Category.id).where(Category.user_id.is_(None)).limit(1)
        )
        assert system_cat_id is not None
        parser = _FakeParser()
        parser.result = _sample_parsed(suggested_category_id=system_cat_id)
        client = await make_receipts_client(parser=parser)
        headers, _ = await _register_and_login(client, "phappy@x.com")
        receipt_id = await _create_receipt(client, headers)

        with patch(_ROUTER_HTTPX, return_value=_uploaded_http()):
            resp = await client.post(f"/receipts/{receipt_id}/parse", headers=headers)

        assert resp.status_code == 202, resp.text
        assert resp.json()["status"] == "processing"

        got = await client.get(f"/receipts/{receipt_id}", headers=headers)
        body = got.json()
        assert body["status"] == "parsed"
        assert body["parsed"]["total"] == "12.50"
        assert body["parsed"]["total_minor"] == 1250  # derived via to_minor_units
        assert body["parsed"]["currency"] == "USD"
        assert body["parsed"]["date"] == "2026-07-01"  # date-only serialization
        assert body["suggested_category_id"] == str(system_cat_id)
        assert body["suggestion_source"] == "model"
        assert body["error"] is None

    async def test_parse_ai_not_configured(
        self, make_receipts_client: Callable[..., Awaitable[AsyncClient]]
    ) -> None:
        client = await make_receipts_client(anthropic_api_key="")
        headers, _ = await _register_and_login(client, "pnokey@x.com")
        receipt_id = await _create_receipt(client, headers)

        resp = await client.post(f"/receipts/{receipt_id}/parse", headers=headers)

        assert resp.status_code == 503, resp.text
        assert resp.json()["detail"] == "AI_NOT_CONFIGURED"
        # No background failure: the receipt is untouched.
        got = await client.get(f"/receipts/{receipt_id}", headers=headers)
        assert got.json()["status"] == "pending"

    async def test_parse_not_uploaded(
        self, make_receipts_client: Callable[..., Awaitable[AsyncClient]]
    ) -> None:
        parser = _FakeParser()
        parser.result = _sample_parsed()
        client = await make_receipts_client(parser=parser)
        headers, _ = await _register_and_login(client, "pnoup@x.com")
        receipt_id = await _create_receipt(client, headers)

        head_404 = _FakeHTTPClient(head_response=httpx.Response(404))
        with patch(_ROUTER_HTTPX, return_value=head_404):
            resp = await client.post(f"/receipts/{receipt_id}/parse", headers=headers)

        assert resp.status_code == 409, resp.text
        assert resp.json()["detail"] == "RECEIPT_NOT_UPLOADED"
        got = await client.get(f"/receipts/{receipt_id}", headers=headers)
        assert got.json()["status"] == "pending"
        assert parser.calls == 0

    async def test_parse_storage_unavailable(
        self, make_receipts_client: Callable[..., Awaitable[AsyncClient]]
    ) -> None:
        # MinIO down: the HEAD probe raises httpx.ConnectError. The request must fail
        # honestly as 503 STORAGE_UNAVAILABLE (not a raw 500), and the receipt must be
        # untouched — no claim, still pending — so the client can retry.
        parser = _FakeParser()
        parser.result = _sample_parsed()
        client = await make_receipts_client(parser=parser)
        headers, _ = await _register_and_login(client, "pstorage@x.com")
        receipt_id = await _create_receipt(client, headers)

        down = _FakeHTTPClient(head_error=httpx.ConnectError("connection refused"))
        with patch(_ROUTER_HTTPX, return_value=down):
            resp = await client.post(f"/receipts/{receipt_id}/parse", headers=headers)

        assert resp.status_code == 503, resp.text
        assert resp.json()["detail"] == "STORAGE_UNAVAILABLE"
        got = await client.get(f"/receipts/{receipt_id}", headers=headers)
        assert got.json()["status"] == "pending"  # never claimed
        assert parser.calls == 0

    async def test_parse_image_too_large(
        self, make_receipts_client: Callable[..., Awaitable[AsyncClient]]
    ) -> None:
        parser = _FakeParser()
        parser.result = _sample_parsed()
        # Tight cap so a modest content-length trips it.
        client = await make_receipts_client(parser=parser, receipt_max_bytes=1024)
        headers, _ = await _register_and_login(client, "pbig@x.com")
        receipt_id = await _create_receipt(client, headers)

        with patch(_ROUTER_HTTPX, return_value=_uploaded_http(size=2048)):
            resp = await client.post(f"/receipts/{receipt_id}/parse", headers=headers)

        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"] == "IMAGE_TOO_LARGE"
        got = await client.get(f"/receipts/{receipt_id}", headers=headers)
        assert got.json()["status"] == "pending"
        assert parser.calls == 0

    async def test_parse_already_parsed_409(
        self, make_receipts_client: Callable[..., Awaitable[AsyncClient]]
    ) -> None:
        parser = _FakeParser()
        parser.result = _sample_parsed()
        client = await make_receipts_client(parser=parser)
        headers, _ = await _register_and_login(client, "pdup@x.com")
        receipt_id = await _create_receipt(client, headers)

        with patch(_ROUTER_HTTPX, return_value=_uploaded_http()):
            first = await client.post(f"/receipts/{receipt_id}/parse", headers=headers)
        assert first.status_code == 202, first.text

        # Terminal: the second parse short-circuits before any HEAD/claim.
        second = await client.post(f"/receipts/{receipt_id}/parse", headers=headers)
        assert second.status_code == 409, second.text
        assert second.json()["detail"] == "RECEIPT_ALREADY_PARSED"

    async def test_parse_claim_race_one_winner(
        self, make_receipts_client: Callable[..., Awaitable[AsyncClient]]
    ) -> None:
        parser = _FakeParser()
        parser.result = _sample_parsed()
        parser.event = asyncio.Event()  # hold the winner mid-parse (claim committed)
        client = await make_receipts_client(parser=parser)
        headers, _ = await _register_and_login(client, "prace@x.com")
        receipt_id = await _create_receipt(client, headers)
        url = f"/receipts/{receipt_id}/parse"

        with patch(_ROUTER_HTTPX, return_value=_uploaded_http()):
            # The winner claims (status→processing, commits) then parks in parse() on
            # the event, so its POST does not return yet. A second parse now hits a
            # committed, fresh (non-stale) processing row: its claim UPDATE matches 0
            # rows → the loser path → 409 RECEIPT_PROCESSING. Serialized on purpose:
            # two truly-simultaneous claim statements on one event loop trip
            # SQLAlchemy's greenlet guard, and the DB UPDATE...WHERE atomicity (not the
            # test harness) is what guarantees a single winner under real concurrency.
            winner_task = asyncio.create_task(client.post(url, headers=headers))
            await _wait_for_status(client, receipt_id, headers, "processing")

            loser = await client.post(url, headers=headers)
            assert loser.status_code == 409, loser.text
            assert loser.json()["detail"] == "RECEIPT_PROCESSING"

            parser.event.set()
            winner = await winner_task
            assert winner.status_code == 202, winner.text

        assert parser.calls == 1  # exactly one worker reached the model
        got = await client.get(f"/receipts/{receipt_id}", headers=headers)
        assert got.json()["status"] == "parsed"  # exactly one terminal write

    async def test_stale_takeover_loser_update_drops(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        # The winner has already finished (status parsed, its own token + payload).
        _headers, user_id = await _register_and_login(client, "pstale@x.com")
        winner_token = datetime.now(UTC)
        winner_doc: dict[str, object] = {
            "model": {
                "total": "99.00",
                "currency": "USD",
                "merchant": None,
                "date": None,
                "items": [],
                "suggested_category_id": None,
            },
            "suggested_category_id": None,
            "suggestion_source": None,
        }
        receipt = Receipt(
            user_id=user_id,
            storage_path=f"{user_id}/stale.jpg",
            status=ReceiptStatus.parsed.value,
            parse_started_at=winner_token,
            parsed_json=winner_doc,
        )
        db_session.add(receipt)
        await db_session.commit()

        # A stale loser (older token) tries to write a different payload.
        stale_token = winner_token - timedelta(seconds=600)
        loser_doc: dict[str, object] = {
            "model": {
                "total": "1.00",
                "currency": "USD",
                "merchant": None,
                "date": None,
                "items": [],
                "suggested_category_id": None,
            },
            "suggested_category_id": None,
            "suggestion_source": None,
        }
        await _finish_parsed(db_session, receipt.id, stale_token, loser_doc)

        await db_session.refresh(receipt)
        # Guarded UPDATE matched 0 rows: the winner's state is intact.
        assert receipt.status == ReceiptStatus.parsed.value
        assert receipt.parsed_json is not None
        model = receipt.parsed_json["model"]
        assert isinstance(model, dict)
        assert model["total"] == "99.00"

    async def test_stale_takeover_claim_reclaims_then_fresh_conflicts(
        self,
        make_receipts_client: Callable[..., Awaitable[AsyncClient]],
        db_session: AsyncSession,
    ) -> None:
        # The claim predicate's stale arm (processing AND parse_started_at <
        # now()-interval): the loser-drop test covers the guarded terminal UPDATE, but
        # not the SQL interval arithmetic that decides re-claimability. An inverted
        # comparison would ship green otherwise. Both arms asserted here.
        parser = _FakeParser()
        parser.result = _sample_parsed()
        client = await make_receipts_client(parser=parser)
        headers, user_id = await _register_and_login(client, "pstaleclaim@x.com")

        # Seed a receipt stuck ``processing`` with a token older than the 300s window —
        # a crashed worker's row.
        receipt = Receipt(
            user_id=user_id,
            storage_path=f"{user_id}/staleclaim.jpg",
            status=ReceiptStatus.processing.value,
            parse_started_at=datetime.now(UTC) - timedelta(minutes=10),
        )
        db_session.add(receipt)
        await db_session.commit()
        url = f"/receipts/{receipt.id}/parse"

        with patch(_ROUTER_HTTPX, return_value=_uploaded_http()):
            # Stale arm: the claim UPDATE matches the stale row → re-claim → 202. The
            # background worker (fake parser, ASGITransport runs it within this await)
            # then finishes the receipt. A never-reclaimable row would 409 here.
            reclaim = await client.post(url, headers=headers)
        assert reclaim.status_code == 202, reclaim.text
        got = await client.get(f"/receipts/{receipt.id}", headers=headers)
        assert got.json()["status"] == "parsed"  # re-claim ran to a terminal state

        # Fresh arm: force the row back to ``processing`` with a token of now() (a live
        # parse). The stale predicate must NOT match, so a second parse loses → 409.
        await db_session.execute(
            text(
                "UPDATE receipts SET status = 'processing', parse_started_at = now(), "
                "parsed_json = NULL, error = NULL WHERE id = :id"
            ),
            {"id": receipt.id},
        )
        await db_session.commit()

        with patch(_ROUTER_HTTPX, return_value=_uploaded_http()):
            conflict = await client.post(url, headers=headers)
        assert conflict.status_code == 409, conflict.text
        assert conflict.json()["detail"] == "RECEIPT_PROCESSING"

    @pytest.mark.parametrize(
        "code",
        [
            "NOT_A_RECEIPT",
            "UNREADABLE_IMAGE",
            "INVALID_MODEL_OUTPUT",
            "ANTHROPIC_ERROR",
        ],
    )
    async def test_parse_failure_taxonomy(
        self,
        make_receipts_client: Callable[..., Awaitable[AsyncClient]],
        code: str,
    ) -> None:
        parser = _FakeParser()
        parser.exception = ReceiptParseError(code)
        client = await make_receipts_client(parser=parser)
        headers, _ = await _register_and_login(client, f"pfail-{code}@x.com")
        receipt_id = await _create_receipt(client, headers)

        with patch(_ROUTER_HTTPX, return_value=_uploaded_http()):
            resp = await client.post(f"/receipts/{receipt_id}/parse", headers=headers)
        assert resp.status_code == 202, resp.text

        got = await client.get(f"/receipts/{receipt_id}", headers=headers)
        body = got.json()
        assert body["status"] == "failed"
        assert body["error"] == code
        assert body["parsed"] is None  # no partial parsed_json

    async def test_parse_download_failed(
        self, make_receipts_client: Callable[..., Awaitable[AsyncClient]]
    ) -> None:
        parser = _FakeParser()
        parser.result = _sample_parsed()
        client = await make_receipts_client(parser=parser)
        headers, _ = await _register_and_login(client, "pdl@x.com")
        receipt_id = await _create_receipt(client, headers)

        # HEAD 200 (object present + small) but the GET download errors.
        broken = _FakeHTTPClient(
            head_response=httpx.Response(200, headers={"content-length": "100"}),
            get_error=httpx.ConnectError("boom"),
        )
        with patch(_ROUTER_HTTPX, return_value=broken):
            resp = await client.post(f"/receipts/{receipt_id}/parse", headers=headers)
        assert resp.status_code == 202, resp.text

        got = await client.get(f"/receipts/{receipt_id}", headers=headers)
        body = got.json()
        assert body["status"] == "failed"
        assert body["error"] == "DOWNLOAD_FAILED"
        assert body["parsed"] is None
        assert parser.calls == 0  # never reached the model

    async def test_suggestion_map_beats_model(
        self,
        make_receipts_client: Callable[..., Awaitable[AsyncClient]],
        db_session: AsyncSession,
    ) -> None:
        parser = _FakeParser()
        client = await make_receipts_client(parser=parser)
        headers, user_id = await _register_and_login(client, "smap@x.com")
        mapped = await _seed_category(db_session, user_id, name="Groceries")
        model_pick = await _seed_category(db_session, user_id, name="Dining")
        await _seed_map(db_session, user_id, normalize_merchant("Acme Coffee"), mapped)
        parser.result = _sample_parsed(
            merchant="Acme Coffee", suggested_category_id=model_pick
        )
        receipt_id = await _create_receipt(client, headers)

        with patch(_ROUTER_HTTPX, return_value=_uploaded_http()):
            resp = await client.post(f"/receipts/{receipt_id}/parse", headers=headers)
        assert resp.status_code == 202, resp.text

        body = (await client.get(f"/receipts/{receipt_id}", headers=headers)).json()
        assert body["suggested_category_id"] == str(mapped)
        assert body["suggestion_source"] == "merchant_map"

    async def test_suggestion_archived_map_target_skipped(
        self,
        make_receipts_client: Callable[..., Awaitable[AsyncClient]],
        db_session: AsyncSession,
    ) -> None:
        # AM-4 contrast: the map points at an ARCHIVED category. Because the archived
        # filter keeps it out of the loaded visible options, the map hit is skipped
        # and the (visible) model pick wins. Without the filter the archived target
        # would be in visible_ids and merchant_map would win — this asserts it does
        # NOT.
        parser = _FakeParser()
        client = await make_receipts_client(parser=parser)
        headers, user_id = await _register_and_login(client, "sarch@x.com")
        archived_target = await _seed_category(
            db_session, user_id, name="ArchivedTarget", archived=True
        )
        model_pick = await _seed_category(db_session, user_id, name="VisiblePick")
        await _seed_map(
            db_session, user_id, normalize_merchant("Acme Coffee"), archived_target
        )
        parser.result = _sample_parsed(
            merchant="Acme Coffee", suggested_category_id=model_pick
        )
        receipt_id = await _create_receipt(client, headers)

        with patch(_ROUTER_HTTPX, return_value=_uploaded_http()):
            resp = await client.post(f"/receipts/{receipt_id}/parse", headers=headers)
        assert resp.status_code == 202, resp.text

        body = (await client.get(f"/receipts/{receipt_id}", headers=headers)).json()
        assert body["suggested_category_id"] == str(model_pick)
        assert body["suggestion_source"] == "model"

    async def test_suggestion_unknown_model_id_dropped(
        self,
        make_receipts_client: Callable[..., Awaitable[AsyncClient]],
    ) -> None:
        parser = _FakeParser()
        # Merchant with no map entry + a model id that is not a visible category.
        parser.result = _sample_parsed(
            merchant="Nowhere", suggested_category_id=uuid.uuid4()
        )
        client = await make_receipts_client(parser=parser)
        headers, _ = await _register_and_login(client, "sunknown@x.com")
        receipt_id = await _create_receipt(client, headers)

        with patch(_ROUTER_HTTPX, return_value=_uploaded_http()):
            resp = await client.post(f"/receipts/{receipt_id}/parse", headers=headers)
        assert resp.status_code == 202, resp.text

        body = (await client.get(f"/receipts/{receipt_id}", headers=headers)).json()
        assert body["status"] == "parsed"
        assert body["suggested_category_id"] is None
        assert body["suggestion_source"] is None

    async def test_parse_rate_limited(
        self, make_receipts_client: Callable[..., Awaitable[AsyncClient]]
    ) -> None:
        parser = _FakeParser()
        parser.result = _sample_parsed()
        client = await make_receipts_client(
            parser=parser,
            rate_limit_enabled=True,
            receipt_parse_rate_limit="1/minute",
        )
        headers, _ = await _register_and_login(client, "prl@x.com")
        receipt_id = await _create_receipt(client, headers)
        url = f"/receipts/{receipt_id}/parse"

        with patch(_ROUTER_HTTPX, return_value=_uploaded_http()):
            first = await client.post(url, headers=headers)
            second = await client.post(url, headers=headers)

        assert first.status_code == 202, first.text
        assert second.status_code == 429, second.text
        assert second.json() == {"detail": "RATE_LIMITED"}
