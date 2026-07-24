"""Shared category-visibility helpers (1.2 §7 extraction, 2nd consumer at 1.4).

Top-level neutral module (same placement rationale as ``enums.py``): it imports
``models`` and is imported by routers, so there is no import cycle. The single
visibility predicate and the single-code-path visible-load live here so both the
categories router and the transactions write path share one definition — and, for
the load, one code path so cross-user and missing both return ``None`` (no-oracle).
"""

import uuid

from sqlalchemy import ColumnElement, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.models import Category


def visible_categories_clause(user_id: uuid.UUID) -> ColumnElement[bool]:
    """Own rows + shared system rows — the single visibility predicate."""
    return or_(Category.user_id == user_id, Category.user_id.is_(None))


async def load_visible_category(
    session: AsyncSession, category_id: uuid.UUID, user_id: uuid.UUID
) -> Category | None:
    """A category visible to this user (own or system). Foreign/missing → None.

    One code path for both miss cases keeps their error bodies indistinguishable
    (no-oracle) — the property the transactions write path and categories PATCH
    both rely on.
    """
    return await session.scalar(
        select(Category).where(
            Category.id == category_id, visible_categories_clause(user_id)
        )
    )
