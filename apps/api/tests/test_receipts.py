"""Receipt create + read contracts — real Postgres, real migrations, faked storage.

The storage boundary is mocked at the ``app.state.storage`` seam (the ``Storage``
class surface, D9): a fake is assigned after ``create_app`` so the pytest layer
never touches MinIO or minio-py's URL format. Everything before that boundary — the
route, the DB write, the serializer — runs for real. Covers only what is unique to
this router: the pending-create + presigned-upload shape and the persisted
``storage_path``, the null-parsed GET shape, the no-oracle cross-user 404, and the
per-user rate key (the one place per-user keying can silently regress to per-IP).
"""

import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AsyncExitStack
from datetime import UTC, datetime, timedelta

import pytest
from asgi_lifespan import LifespanManager
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.app import create_app
from budget_api.config import Settings
from budget_api.services.storage import PresignedRequest

PASSWORD = "password123"
_FAKE_BASE = "https://fake-s3.test"


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
            storage: object | None = None, **overrides: object
        ) -> AsyncClient:
            overrides.setdefault("rate_limit_enabled", False)
            app = create_app(
                Settings(
                    database_url=test_database_url,
                    jwt_secret=test_jwt_secret,
                    **overrides,  # type: ignore[arg-type]
                )
            )
            app.state.storage = storage if storage is not None else _FakeStorage()
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
