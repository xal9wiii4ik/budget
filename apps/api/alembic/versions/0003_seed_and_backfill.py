"""seed system categories and backfill profiles

Revision ID: 0003
Revises: 0002
Create Date: 2026-07-24

Data migration (roadmap 1.2, architecture §4/§9): seeds the 18 system categories
(``user_id IS NULL``) with frozen UUID literals so every environment agrees on
their ids, and backfills a ``RUB`` profile for every pre-existing user (the 1.1
carry-forward — users created before ``on_after_register`` provisioned profiles).

Downgrade is deliberately ASYMMETRIC (architecture §9): it deletes only the 18
seed categories by id and leaves ``profiles`` untouched. Backfilled profiles are
indistinguishable from hook-created ones post-hoc, and a full ``downgrade base``
drops the ``profiles`` table via 0002 anyway. ``transactions.category_id ON DELETE
SET NULL`` means the seed delete cannot be blocked by referencing transactions.
"""

import uuid
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Frozen system-category ids (architecture §4). These are the contract: dev, test,
# prod, and any rebuilt DB must agree on them (they leak into client caches,
# receipts prompts at 2.2, and merchant_category_map at 2.5). Do NOT regenerate.
_SEED_CATEGORIES: list[dict[str, object]] = [
    {
        "id": "ce814749-2554-40be-8952-3a63d505694f",
        "name": "Продукты",
        "kind": "expense",
        "icon": "🛒",
        "color": "#4CAF50",
    },
    {
        "id": "f9a5b100-13a0-49c4-9da1-f23a07f70e81",
        "name": "Кафе и рестораны",
        "kind": "expense",
        "icon": "🍽️",
        "color": "#FF9800",
    },
    {
        "id": "fbee0e67-0fd3-49b2-851d-fff8bc390255",
        "name": "Транспорт",
        "kind": "expense",
        "icon": "🚗",
        "color": "#2196F3",
    },
    {
        "id": "c861af3a-73f2-475e-af4f-0556d7d143c9",
        "name": "Жильё",
        "kind": "expense",
        "icon": "🏠",
        "color": "#795548",
    },
    {
        "id": "6c53a9ed-9fb0-4cf5-aba2-1c36e1296d23",
        "name": "Здоровье",
        "kind": "expense",
        "icon": "💊",
        "color": "#F44336",
    },
    {
        "id": "1ac8d199-db1d-487c-9080-6949a62aad66",
        "name": "Одежда",
        "kind": "expense",
        "icon": "👕",
        "color": "#9C27B0",
    },
    {
        "id": "1b0f9d5f-df44-471b-b084-b9db75d42d50",
        "name": "Развлечения",
        "kind": "expense",
        "icon": "🎬",
        "color": "#E91E63",
    },
    {
        "id": "2363f62a-b11c-42cc-8121-49286fb4f098",
        "name": "Связь и интернет",
        "kind": "expense",
        "icon": "📱",
        "color": "#00BCD4",
    },
    {
        "id": "ebcb3fe0-e47b-4327-8248-b3d19e89c2c9",
        "name": "Подписки",
        "kind": "expense",
        "icon": "🔁",
        "color": "#673AB7",
    },
    {
        "id": "0f69fdb2-ff62-4fd9-b59b-ad891d992035",
        "name": "Подарки",
        "kind": "expense",
        "icon": "🎁",
        "color": "#FFC107",
    },
    {
        "id": "a786fbc9-d36e-458a-842b-6d4d9ed29c58",
        "name": "Путешествия",
        "kind": "expense",
        "icon": "✈️",
        "color": "#3F51B5",
    },
    {
        "id": "f80ae2b9-38ea-4d08-a169-58b203e9ea10",
        "name": "Образование",
        "kind": "expense",
        "icon": "📚",
        "color": "#009688",
    },
    {
        "id": "3363eedd-dde8-45e7-853b-f9fcef853229",
        "name": "Прочее",
        "kind": "expense",
        "icon": "📦",
        "color": "#9E9E9E",
    },
    {
        "id": "8fe4d517-33d6-437d-a2c0-4cd95e262676",
        "name": "Зарплата",
        "kind": "income",
        "icon": "💼",
        "color": "#4CAF50",
    },
    {
        "id": "00d81258-6d7e-4b83-ab44-f8ff62fddb7f",
        "name": "Фриланс",
        "kind": "income",
        "icon": "🧑‍💻",
        "color": "#8BC34A",
    },
    {
        "id": "f9c4adfa-2db5-4d6f-bdf8-d5c55c7de457",
        "name": "Подарки",
        "kind": "income",
        "icon": "🎁",
        "color": "#CDDC39",
    },
    {
        "id": "bd83bb2c-8561-4f06-8a8c-61a2b40fe6bb",
        "name": "Проценты и кэшбэк",
        "kind": "income",
        "icon": "🏦",
        "color": "#00BCD4",
    },
    {
        "id": "fd316f6c-fa04-456b-a0c2-46e781568d56",
        "name": "Прочее",
        "kind": "income",
        "icon": "📦",
        "color": "#9E9E9E",
    },
]

_categories = sa.table(
    "categories",
    sa.column("id", sa.Uuid()),
    sa.column("user_id", sa.Uuid()),
    sa.column("name", sa.String()),
    sa.column("icon", sa.String()),
    sa.column("color", sa.String()),
    sa.column("kind", sa.String()),
    sa.column("archived", sa.Boolean()),
)


def upgrade() -> None:
    op.bulk_insert(
        _categories,
        [
            {
                "id": uuid.UUID(str(row["id"])),
                "user_id": None,
                "name": row["name"],
                "icon": row["icon"],
                "color": row["color"],
                "kind": row["kind"],
                "archived": False,
            }
            for row in _SEED_CATEGORIES
        ],
    )
    # Backfill: provision a RUB profile for every pre-existing user. Idempotent by
    # construction (ON CONFLICT DO NOTHING), so re-running is safe.
    op.execute(
        "INSERT INTO profiles (user_id, base_currency) "
        "SELECT id, 'RUB' FROM users ON CONFLICT (user_id) DO NOTHING"
    )


def downgrade() -> None:
    # Delete ONLY the 18 seed categories by id; leave profiles in place (see the
    # module docstring for the documented asymmetry).
    seed_ids = [uuid.UUID(str(row["id"])) for row in _SEED_CATEGORIES]
    op.execute(_categories.delete().where(_categories.c.id.in_(seed_ids)))
