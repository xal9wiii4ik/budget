"""Plan-node attachments — real Postgres, real migrations, faked object storage.

The closed test list of `.tasks/goal-planner/plan.md` §3, plus one positive test
for the subtree sweep (the list's delete test only proves the FAILURE arm).

Two process boundaries are faked, and only those: the confirm route's HEAD probe
(``routers.goal_item_files.httpx.AsyncClient``) and the cleanup job's DELETE
(``services.object_cleanup.httpx.AsyncClient``). Everything before them — routes,
guards, DB writes, the CASCADE — runs for real. The ``Storage`` seam itself is
replaced at ``app.state.storage`` with a deterministic stand-in (the
test_receipts.py precedent), so no test depends on minio-py's URL format.

Absent on purpose: Pydantic bound rejections, the 401 wall, and a second no-oracle
test (one per router — the pytest-conventions skill).
"""

import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AsyncExitStack
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import patch

import httpx
import pytest
from asgi_lifespan import LifespanManager
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.app import create_app
from budget_api.config import Settings
from budget_api.models import GoalItemFile
from budget_api.services.storage import PresignedRequest

PASSWORD = "password123"
_FAKE_BASE = "https://fake-s3.test"
_ROUTER_HTTPX = "budget_api.routers.goal_item_files.httpx.AsyncClient"
_CLEANUP_HTTPX = "budget_api.services.object_cleanup.httpx.AsyncClient"


class _FakeStorage:
    """Deterministic stand-in for ``services.storage.Storage`` (same surface).

    ``goal_item_file_path`` mirrors the real key exactly — the router persists its
    result as ``storage_path``, and the cleanup assertions read it back.
    """

    def goal_item_file_path(self, user_id: uuid.UUID, file_id: uuid.UUID) -> str:
        return f"{user_id}/goal-items/{file_id}.jpg"

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

    def presign_delete(self, path: str) -> str:
        return f"{_FAKE_BASE}/{path}?sig=delete"


class _FakeHTTPClient:
    """One fake AsyncClient for both boundaries (HEAD probe / DELETE sweep).

    Records every DELETE it is asked for, so a test can prove WHICH keys the sweep
    went after — the subtree collection is the part that can silently regress.
    """

    def __init__(
        self,
        *,
        head_response: httpx.Response | None = None,
        head_error: Exception | None = None,
        delete_error: Exception | None = None,
    ) -> None:
        self._head_response = head_response
        self._head_error = head_error
        self._delete_error = delete_error
        self.deleted: list[str] = []

    async def __aenter__(self) -> "_FakeHTTPClient":
        return self

    async def __aexit__(self, *_: object) -> bool:
        return False

    async def head(self, url: str, **_kwargs: object) -> httpx.Response:
        if self._head_error is not None:
            raise self._head_error
        assert self._head_response is not None
        return self._head_response

    async def delete(self, url: str, **_kwargs: object) -> httpx.Response:
        self.deleted.append(url)
        if self._delete_error is not None:
            raise self._delete_error
        return httpx.Response(204)


def _head_ok(size: int = 1000) -> _FakeHTTPClient:
    return _FakeHTTPClient(
        head_response=httpx.Response(200, headers={"content-length": str(size)})
    )


@pytest.fixture
async def make_files_client(
    test_database_url: str, test_jwt_secret: str
) -> AsyncIterator[Callable[..., Awaitable[AsyncClient]]]:
    """Factory: a lifespan-managed client whose app has a fake storage seam.

    Not foldable into conftest's ``make_client`` (the test_receipts reason): that
    factory returns only the client, and these tests must reach the app to assign
    ``app.state.storage``.
    """
    async with AsyncExitStack() as stack:

        async def _make(**overrides: object) -> AsyncClient:
            overrides.setdefault("rate_limit_enabled", False)
            overrides.setdefault("fx_scheduler_enabled", False)
            overrides.setdefault("recurring_scheduler_enabled", False)
            overrides.setdefault("push_scheduler_enabled", False)
            overrides.setdefault("embeddings_scheduler_enabled", False)
            overrides.setdefault("embeddings_provider", "fake")
            app = create_app(
                Settings(
                    database_url=test_database_url,
                    jwt_secret=test_jwt_secret,
                    **overrides,  # type: ignore[arg-type]
                )
            )
            app.state.storage = _FakeStorage()
            await stack.enter_async_context(LifespanManager(app))
            transport = ASGITransport(app=app)
            return await stack.enter_async_context(
                AsyncClient(transport=transport, base_url="http://test")
            )

        yield _make


@pytest.fixture
async def client(
    make_files_client: Callable[..., Awaitable[AsyncClient]],
) -> AsyncClient:
    return await make_files_client()


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


async def _create_goal(client: AsyncClient, headers: dict[str, str]) -> str:
    resp = await client.post(
        "/goals",
        json={"name": "trip", "target_minor": 1_000_000, "currency": "USD"},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    goal_id: str = resp.json()["id"]
    return goal_id


async def _create_item(
    client: AsyncClient, headers: dict[str, str], goal_id: str, **body: Any
) -> str:
    body.setdefault("name", "item")
    resp = await client.post(f"/goals/{goal_id}/items", json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    item_id: str = resp.json()["id"]
    return item_id


async def _create_file(
    client: AsyncClient, headers: dict[str, str], goal_id: str, item_id: str
) -> str:
    resp = await client.post(f"/goals/{goal_id}/items/{item_id}/files", headers=headers)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["uploaded"] is False
    file_id: str = body["id"]
    return file_id


async def _list_files(
    client: AsyncClient, headers: dict[str, str], goal_id: str, item_id: str
) -> list[dict[str, Any]]:
    resp = await client.get(f"/goals/{goal_id}/items/{item_id}/files", headers=headers)
    assert resp.status_code == 200, resp.text
    files: list[dict[str, Any]] = resp.json()
    return files


async def _uploaded_flag(session: AsyncSession, file_id: str) -> bool | None:
    return await session.scalar(
        select(GoalItemFile.uploaded).where(GoalItemFile.id == uuid.UUID(file_id))
    )


class TestConfirm:
    async def test_confirm_marks_uploaded_and_only_then_mints_view_url(
        self, client: AsyncClient
    ) -> None:
        """A URL is handed out only for bytes the server has seen (§7).

        The contrast lives in ONE test on purpose: "null before, signed after" is
        a single rule, and asserting the two halves apart would let a regression
        that mints URLs unconditionally still pass the first one.
        """
        headers = await _register_and_login(client, "gif-confirm@x.com")
        goal_id = await _create_goal(client, headers)
        item_id = await _create_item(client, headers, goal_id)
        file_id = await _create_file(client, headers, goal_id, item_id)

        before = await _list_files(client, headers, goal_id, item_id)
        assert [(f["uploaded"], f["view_url"]) for f in before] == [(False, None)]

        with patch(_ROUTER_HTTPX, return_value=_head_ok()):
            confirmed = await client.post(
                f"/goals/{goal_id}/items/{item_id}/files/{file_id}/confirm",
                headers=headers,
            )
        assert confirmed.status_code == 200, confirmed.text
        assert confirmed.json()["uploaded"] is True

        after = await _list_files(client, headers, goal_id, item_id)
        assert after[0]["uploaded"] is True
        # A presigned GET for THIS file's key — not merely "some string".
        assert after[0]["view_url"].endswith(f"/goal-items/{file_id}.jpg?sig=get")

    async def test_confirm_without_object_is_409_and_row_stays_unconfirmed(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """HEAD 404 → the client uploaded nothing yet; the row must NOT flip."""
        headers = await _register_and_login(client, "gif-409@x.com")
        goal_id = await _create_goal(client, headers)
        item_id = await _create_item(client, headers, goal_id)
        file_id = await _create_file(client, headers, goal_id, item_id)

        with patch(
            _ROUTER_HTTPX,
            return_value=_FakeHTTPClient(head_response=httpx.Response(404)),
        ):
            resp = await client.post(
                f"/goals/{goal_id}/items/{item_id}/files/{file_id}/confirm",
                headers=headers,
            )

        assert resp.status_code == 409, resp.text
        assert resp.json()["detail"] == "FILE_NOT_UPLOADED"
        assert await _uploaded_flag(db_session, file_id) is False

    async def test_confirm_oversize_is_422(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """The size ceiling is ``receipt_max_bytes`` — one number for both paths."""
        headers = await _register_and_login(client, "gif-big@x.com")
        goal_id = await _create_goal(client, headers)
        item_id = await _create_item(client, headers, goal_id)
        file_id = await _create_file(client, headers, goal_id, item_id)

        with patch(_ROUTER_HTTPX, return_value=_head_ok(size=5_000_001)):
            resp = await client.post(
                f"/goals/{goal_id}/items/{item_id}/files/{file_id}/confirm",
                headers=headers,
            )

        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"] == "IMAGE_TOO_LARGE"
        assert await _uploaded_flag(db_session, file_id) is False

    async def test_confirm_when_storage_unreachable_is_503(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """MinIO down is a SERVICE condition: 503, row intact, never a 500."""
        headers = await _register_and_login(client, "gif-503@x.com")
        goal_id = await _create_goal(client, headers)
        item_id = await _create_item(client, headers, goal_id)
        file_id = await _create_file(client, headers, goal_id, item_id)

        with patch(
            _ROUTER_HTTPX,
            return_value=_FakeHTTPClient(head_error=httpx.ConnectError("down")),
        ):
            resp = await client.post(
                f"/goals/{goal_id}/items/{item_id}/files/{file_id}/confirm",
                headers=headers,
            )

        assert resp.status_code == 503, resp.text
        assert resp.json()["detail"] == "STORAGE_UNAVAILABLE"
        assert await _uploaded_flag(db_session, file_id) is False


class TestItemDeleteCascade:
    async def test_deleting_a_parent_sweeps_the_whole_subtrees_objects(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """The keys are collected BEFORE the CASCADE, over the whole subtree.

        A child's attachment is the interesting one: after the delete nothing on
        the server knows the node ever existed, so a sweep built from anything but
        a pre-delete subtree read would silently leak it.
        """
        headers = await _register_and_login(client, "gif-sweep@x.com")
        goal_id = await _create_goal(client, headers)
        parent_id = await _create_item(client, headers, goal_id, name="P")
        child_id = await _create_item(
            client, headers, goal_id, name="C", parent_id=parent_id
        )
        parent_file = await _create_file(client, headers, goal_id, parent_id)
        child_file = await _create_file(client, headers, goal_id, child_id)

        http = _FakeHTTPClient()
        with patch(_CLEANUP_HTTPX, return_value=http):
            resp = await client.delete(
                f"/goals/{goal_id}/items/{parent_id}", headers=headers
            )

        assert resp.status_code == 204, resp.text
        assert {
            url.split("/goal-items/")[1].split(".jpg")[0] for url in http.deleted
        } == {
            parent_file,
            child_file,
        }
        assert (
            await db_session.scalar(select(func.count()).select_from(GoalItemFile)) == 0
        )

    async def test_delete_item_removes_file_rows_even_if_storage_fails(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """The DB is the truth: an unreachable MinIO cannot block the delete (§7)."""
        headers = await _register_and_login(client, "gif-sweep-fail@x.com")
        goal_id = await _create_goal(client, headers)
        item_id = await _create_item(client, headers, goal_id)
        await _create_file(client, headers, goal_id, item_id)

        with patch(
            _CLEANUP_HTTPX,
            return_value=_FakeHTTPClient(delete_error=httpx.ConnectError("down")),
        ):
            resp = await client.delete(
                f"/goals/{goal_id}/items/{item_id}", headers=headers
            )

        assert resp.status_code == 204, resp.text
        assert (
            await db_session.scalar(select(func.count()).select_from(GoalItemFile)) == 0
        )
        listed = await client.get(f"/goals/{goal_id}/items", headers=headers)
        assert listed.json()["items"] == []


class TestNoOracle:
    async def test_files_of_a_foreign_item_are_404(self, client: AsyncClient) -> None:
        """Someone else's node answers byte-identically to one that never existed."""
        owner = await _register_and_login(client, "gif-owner@x.com")
        intruder = await _register_and_login(client, "gif-intruder@x.com")
        goal_id = await _create_goal(client, owner)
        item_id = await _create_item(client, owner, goal_id)

        foreign = await client.get(
            f"/goals/{goal_id}/items/{item_id}/files", headers=intruder
        )
        missing = await client.get(
            f"/goals/{uuid.uuid4()}/items/{uuid.uuid4()}/files", headers=intruder
        )

        assert foreign.status_code == missing.status_code == 404
        assert foreign.content == missing.content
