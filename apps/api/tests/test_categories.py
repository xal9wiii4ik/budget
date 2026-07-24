"""Category CRUD contracts — real Postgres, real migrations, no mocks.

Covers only what is unique to this router: the own+system read merge and
archived filtering, forced ownership, the custom name/color validators, the soft
409 dedup (create + update paths, AM-1/AM-2), the no-oracle 404 vs system 403,
and the model_fields_set null/omit mechanics. Pure-Pydantic rejections
(name>100, icon>16, invalid kind) are QA-curl-owned per the grooming split.
"""

import uuid
from typing import Any

from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

PASSWORD = "password123"
# Seed system category (migration 0003): Продукты, expense, 🛒, #4CAF50.
PRODUKTY_ID = "ce814749-2554-40be-8952-3a63d505694f"
SYSTEM_COUNT = 18


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


async def _create(
    client: AsyncClient, headers: dict[str, str], **body: Any
) -> dict[str, Any]:
    resp = await client.post("/categories", json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _list(
    client: AsyncClient, headers: dict[str, str], **params: Any
) -> list[dict[str, Any]]:
    resp = await client.get("/categories", params=params, headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


class TestListCategories:
    async def test_lists_system_and_own_excludes_archived_by_default(
        self, client: AsyncClient
    ) -> None:
        headers, _ = await _register_and_login(client, "list@x.com")
        active = await _create(client, headers, name="MyCat", kind="expense")
        archived = await _create(client, headers, name="MyArchived", kind="expense")
        patched = await client.patch(
            f"/categories/{archived['id']}",
            json={"archived": True},
            headers=headers,
        )
        assert patched.status_code == 200, patched.text

        rows = await _list(client, headers)

        by_id = {r["id"]: r for r in rows}
        assert active["id"] in by_id
        assert archived["id"] not in by_id  # archived excluded by default
        assert by_id[active["id"]]["is_system"] is False
        system = [r for r in rows if r["is_system"]]
        assert len(system) == SYSTEM_COUNT
        assert all(r["archived"] is False for r in rows)

    async def test_include_archived_returns_archived(self, client: AsyncClient) -> None:
        headers, _ = await _register_and_login(client, "archlist@x.com")
        archived = await _create(client, headers, name="Gone", kind="expense")
        await client.patch(
            f"/categories/{archived['id']}",
            json={"archived": True},
            headers=headers,
        )

        rows = await _list(client, headers, include_archived=True)

        assert archived["id"] in {r["id"] for r in rows}

    async def test_does_not_leak_other_users_categories(
        self, client: AsyncClient
    ) -> None:
        headers_a, _ = await _register_and_login(client, "owner@x.com")
        secret = await _create(client, headers_a, name="Secret", kind="expense")

        headers_b, _ = await _register_and_login(client, "spy@x.com")
        rows = await _list(client, headers_b)

        assert secret["id"] not in {r["id"] for r in rows}
        assert all(r["is_system"] for r in rows)  # userB owns nothing yet


class TestCreateCategory:
    async def test_create_forces_owner_and_ignores_body_user_id(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers, user_id = await _register_and_login(client, "owner2@x.com")
        bogus = str(uuid.uuid4())

        resp = await client.post(
            "/categories",
            json={"name": "Mine", "kind": "expense", "user_id": bogus},
            headers=headers,
        )

        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["is_system"] is False
        assert "user_id" not in body  # raw ownership never on the wire
        stored = await db_session.scalar(
            text("SELECT user_id FROM categories WHERE id = :id"),
            {"id": uuid.UUID(body["id"])},
        )
        assert stored == user_id  # forced from token, body user_id ignored

    async def test_whitespace_name_rejected(self, client: AsyncClient) -> None:
        headers, _ = await _register_and_login(client, "ws@x.com")
        resp = await client.post(
            "/categories", json={"name": "   ", "kind": "expense"}, headers=headers
        )
        assert resp.status_code == 422, resp.text

    async def test_color_pattern_rejected(self, client: AsyncClient) -> None:
        # Load-bearing pin for the color validation deferred from 1.2 (R6): if the
        # regex is ever loosened, CI goes red rather than a one-time curl.
        headers, _ = await _register_and_login(client, "color@x.com")
        resp = await client.post(
            "/categories",
            json={"name": "Bad", "kind": "expense", "color": "red"},
            headers=headers,
        )
        assert resp.status_code == 422, resp.text

    async def test_duplicate_same_kind_conflict(self, client: AsyncClient) -> None:
        headers, _ = await _register_and_login(client, "dup@x.com")
        await _create(client, headers, name="Foo", kind="expense")

        resp = await client.post(
            "/categories", json={"name": "foo", "kind": "expense"}, headers=headers
        )

        assert resp.status_code == 409, resp.text
        assert resp.json()["detail"] == "CATEGORY_NAME_CONFLICT"

    async def test_same_name_different_kind_allowed(self, client: AsyncClient) -> None:
        headers, _ = await _register_and_login(client, "xkind@x.com")
        await _create(client, headers, name="Foo", kind="expense")
        await _create(client, headers, name="Foo", kind="income")  # 201 asserted

    async def test_can_copy_system_category_name(self, client: AsyncClient) -> None:
        headers, _ = await _register_and_login(client, "copy@x.com")
        # Colliding with a system name is intentional (editable copy) — dedup
        # ignores user_id IS NULL rows.
        await _create(client, headers, name="Продукты", kind="expense")

    async def test_archived_name_is_reusable(self, client: AsyncClient) -> None:
        # Pins the archived-exclusion branch of _reject_duplicate
        # (`Category.archived.is_(False)`): a name freed by archiving is reusable.
        # If a refactor drops that filter, the second create wrongly returns 409.
        headers, _ = await _register_and_login(client, "reuse@x.com")
        first = await _create(client, headers, name="Foo", kind="expense")

        archived = await client.patch(
            f"/categories/{first['id']}", json={"archived": True}, headers=headers
        )
        assert archived.status_code == 200, archived.text

        await _create(client, headers, name="Foo", kind="expense")  # 201 asserted


class TestUpdateCategory:
    async def test_patch_cross_user_and_missing_both_404(
        self, client: AsyncClient
    ) -> None:
        headers_a, _ = await _register_and_login(client, "a@x.com")
        cat = await _create(client, headers_a, name="Owned", kind="expense")

        headers_b, _ = await _register_and_login(client, "b@x.com")
        cross_user = await client.patch(
            f"/categories/{cat['id']}", json={"name": "hax"}, headers=headers_b
        )
        missing = await client.patch(
            f"/categories/{uuid.uuid4()}", json={"name": "hax"}, headers=headers_b
        )

        # No-oracle: byte-identical status AND body for cross-user vs nonexistent.
        assert cross_user.status_code == 404
        assert missing.status_code == 404
        assert cross_user.json() == missing.json() == {"detail": "CATEGORY_NOT_FOUND"}

    async def test_patch_system_category_403(self, client: AsyncClient) -> None:
        headers, _ = await _register_and_login(client, "sys@x.com")
        resp = await client.patch(
            f"/categories/{PRODUKTY_ID}", json={"name": "Mine now"}, headers=headers
        )
        assert resp.status_code == 403, resp.text
        assert resp.json()["detail"] == "SYSTEM_CATEGORY_READONLY"

    async def test_patch_null_clears_and_omitted_preserves(
        self, client: AsyncClient
    ) -> None:
        headers, _ = await _register_and_login(client, "null@x.com")
        cat = await _create(
            client, headers, name="Styled", kind="expense", icon="🛒", color="#4CAF50"
        )

        resp = await client.patch(
            f"/categories/{cat['id']}", json={"icon": None}, headers=headers
        )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["icon"] is None  # explicit null cleared it
        assert body["color"] == "#4CAF50"  # omitted color preserved

        # NOT NULL columns reject an explicit null with a custom 422 (else a bare
        # apply would 500 on IntegrityError). name proves the original guard,
        # archived the fixed one; kind shares the identical pattern (not re-pinned).
        name_null = await client.patch(
            f"/categories/{cat['id']}", json={"name": None}, headers=headers
        )
        assert name_null.status_code == 422, name_null.text
        assert name_null.json()["detail"] == "CATEGORY_NAME_REQUIRED"

        archived_null = await client.patch(
            f"/categories/{cat['id']}", json={"archived": None}, headers=headers
        )
        assert archived_null.status_code == 422, archived_null.text
        assert archived_null.json()["detail"] == "CATEGORY_ARCHIVED_REQUIRED"

    async def test_patch_kind_change_allowed(self, client: AsyncClient) -> None:
        headers, _ = await _register_and_login(client, "flip@x.com")
        cat = await _create(client, headers, name="Flippable", kind="expense")

        resp = await client.patch(
            f"/categories/{cat['id']}", json={"kind": "income"}, headers=headers
        )

        assert resp.status_code == 200, resp.text
        assert resp.json()["kind"] == "income"

    async def test_patch_archive_then_unarchive(self, client: AsyncClient) -> None:
        headers, _ = await _register_and_login(client, "arch@x.com")
        cat = await _create(client, headers, name="Cycle", kind="expense")

        await client.patch(
            f"/categories/{cat['id']}", json={"archived": True}, headers=headers
        )
        assert cat["id"] not in {r["id"] for r in await _list(client, headers)}

        await client.patch(
            f"/categories/{cat['id']}", json={"archived": False}, headers=headers
        )
        assert cat["id"] in {r["id"] for r in await _list(client, headers)}

    async def test_patch_dedup_rename_collision_self_rename_and_kind_only(
        self, client: AsyncClient
    ) -> None:
        # AM-1/AM-2 pin: dedup fires on the effective (name, kind) pair whenever
        # name OR kind changes, excluding the target row itself.
        headers, _ = await _register_and_login(client, "upddup@x.com")
        foo = await _create(client, headers, name="Foo", kind="expense")
        bar = await _create(client, headers, name="Bar", kind="expense")

        # rename-to-collision (case-insensitive) -> 409 (AM-1, not applied)
        collision = await client.patch(
            f"/categories/{bar['id']}", json={"name": "foo"}, headers=headers
        )
        assert collision.status_code == 409, collision.text
        assert collision.json()["detail"] == "CATEGORY_NAME_CONFLICT"

        # case-only self-rename -> 200 (AM-2 excludes the target row)
        self_rename = await client.patch(
            f"/categories/{foo['id']}", json={"name": "FOO"}, headers=headers
        )
        assert self_rename.status_code == 200, self_rename.text
        assert self_rename.json()["name"] == "FOO"

        # kind-only PATCH that creates a duplicate pair -> 409 (AM-1 on kind change)
        baz_exp = await _create(client, headers, name="Baz", kind="expense")
        baz_inc = await _create(client, headers, name="Baz", kind="income")
        assert baz_exp["id"] != baz_inc["id"]
        kind_collision = await client.patch(
            f"/categories/{baz_inc['id']}", json={"kind": "expense"}, headers=headers
        )
        assert kind_collision.status_code == 409, kind_collision.text
        assert kind_collision.json()["detail"] == "CATEGORY_NAME_CONFLICT"


class TestAuth:
    async def test_requires_auth(self, client: AsyncClient) -> None:
        # Once per router, per conventions.
        resp = await client.get("/categories")
        assert resp.status_code == 401
