"""User request/response schemas.

Lean by design (architecture §5): ``is_superuser``/``is_verified`` are never on the
wire, and ``UserUpdate`` omits every privilege field so escalation-via-PATCH is
structurally impossible regardless of the library's safe-update behavior.

``UserRead`` and ``UserUpdate`` deliberately do NOT subclass ``BaseUser*``:
Pydantic v2 cannot drop inherited fields, so subclassing would keep the privilege
fields. ``UserRead`` is a plain ``BaseModel``. ``UserUpdate`` subclasses only the
fieldless ``CreateUpdateDictModel`` mixin (it carries NO privilege fields, just the
``create_update_dict`` helpers the stock users router calls at runtime), then adds
email/password. Both cost a documented ``# type: ignore[arg-type]`` at router
registration where fastapi-users' generic bound expects a ``BaseUser*`` subtype
(plan S1 / AM-A).
"""

import uuid
from typing import Any

from fastapi_users import schemas
from fastapi_users.schemas import CreateUpdateDictModel
from pydantic import BaseModel, ConfigDict, EmailStr


class UserRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: EmailStr
    is_active: bool


class UserCreate(schemas.BaseUserCreate):
    """{email, password} (+ ignored privilege fields; safe=True drops them)."""


class UserUpdate(CreateUpdateDictModel):
    """{email?, password?} only — privilege fields structurally absent (AM-A).

    Extra fields are ignored (Pydantic default), not forbidden (AM-H/R4). The
    ``CreateUpdateDictModel`` base contributes no fields — only the
    ``create_update_dict`` helpers the stock users router invokes.
    """

    email: EmailStr | None = None
    password: str | None = None

    # Finding 1: exclude_none in addition to exclude_unset so an explicit JSON null
    # (e.g. PATCH {"email": null}) is treated as "field not updated" rather than
    # reaching the DB as NULL (which 500s on a NOT NULL column).
    def create_update_dict(self) -> dict[str, Any]:
        return self.model_dump(
            exclude_unset=True,
            exclude_none=True,
            exclude={
                "id",
                "is_superuser",
                "is_active",
                "is_verified",
                "oauth_accounts",
            },
        )

    def create_update_dict_superuser(self) -> dict[str, Any]:
        return self.model_dump(exclude_unset=True, exclude_none=True, exclude={"id"})
