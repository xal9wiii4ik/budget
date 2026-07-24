"""Category request/response schemas.

Lean DTOs (architecture §5): the wire never carries raw ``user_id`` — the router
derives ``is_system`` from ``user_id is None`` instead, so the client learns
"editable or not" without reimplementing the derivation. ``CategoryCreate`` has
no ``user_id`` field at all, so ownership is forced from the token and a stray
body ``user_id`` is silently ignored.

Name/icon share the same trim-and-validate logic across create and update; the
validators return ``None`` untouched so an omitted/explicit-null update field is
left for the router's ``model_fields_set`` handling.
"""

import uuid

from pydantic import BaseModel, ConfigDict, Field, field_validator

from budget_api.enums import CategoryKind

_COLOR_PATTERN = r"^#[0-9A-Fa-f]{6}$"
_NAME_MAX = 100
_ICON_MAX = 16


def _clean_name(v: str) -> str:
    v = v.strip()
    if not (1 <= len(v) <= _NAME_MAX):
        raise ValueError(f"name must be 1..{_NAME_MAX} chars after trimming")
    return v


def _clean_icon(v: str | None) -> str | None:
    if v is None:
        return None
    v = v.strip()
    if not v:
        return None
    if len(v) > _ICON_MAX:
        raise ValueError(f"icon must be at most {_ICON_MAX} characters")
    return v


class CategoryRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    icon: str | None
    color: str | None
    kind: CategoryKind
    archived: bool
    # Derived from (user_id is None) by the router — never the raw user_id.
    is_system: bool


class CategoryCreate(BaseModel):
    # No user_id field: ownership is forced from the token; extras are ignored.
    name: str
    kind: CategoryKind
    icon: str | None = None
    color: str | None = Field(default=None, pattern=_COLOR_PATTERN)

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        return _clean_name(v)

    @field_validator("icon")
    @classmethod
    def _validate_icon(cls, v: str | None) -> str | None:
        return _clean_icon(v)


class CategoryUpdate(BaseModel):
    # All optional. Omitted vs explicit-null is distinguished by the router via
    # model_fields_set: omitted preserves, explicit null clears icon/color, and
    # null name/kind is rejected 422 (can't clear a NOT NULL column).
    name: str | None = None
    kind: CategoryKind | None = None
    icon: str | None = None
    color: str | None = Field(default=None, pattern=_COLOR_PATTERN)
    archived: bool | None = None

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str | None) -> str | None:
        return None if v is None else _clean_name(v)

    @field_validator("icon")
    @classmethod
    def _validate_icon(cls, v: str | None) -> str | None:
        return _clean_icon(v)


class CategoryError(BaseModel):
    """403/404/409 error envelope — mirrors ``RateLimitedError`` (auth §7)."""

    detail: str
