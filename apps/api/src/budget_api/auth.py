"""Authentication wiring — the single definition point for auth infrastructure.

Sibling of ``db.py`` (framework glue, not a ``services/`` integration). Owns the
user-db factory, ``UserManager`` (+ hooks), the JWT and refresh strategy factories,
the JWT-only ``FastAPIUsers`` instance, and the canonical ``current_active_user``
dependency that every later task imports (architecture §3/§9).

Security-critical construction: ``FastAPIUsers`` is built with the JWT backend
ONLY, so an opaque refresh token can never authenticate a protected route — it
fails JWT decode (F6). Do not register the refresh/database strategy as an
authentication backend on this instance.
"""

import logging
import uuid
from collections.abc import AsyncIterator
from typing import Any

from fastapi import Depends, Request
from fastapi_users import BaseUserManager, FastAPIUsers, UUIDIDMixin
from fastapi_users.authentication import (
    AuthenticationBackend,
    BearerTransport,
    JWTStrategy,
)
from fastapi_users.authentication.strategy.db import DatabaseStrategy
from fastapi_users.exceptions import InvalidPasswordException
from fastapi_users_db_sqlalchemy import SQLAlchemyUserDatabase
from fastapi_users_db_sqlalchemy.access_token import SQLAlchemyAccessTokenDatabase
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.config import Settings
from budget_api.db import get_session
from budget_api.models import RefreshToken, User

logger = logging.getLogger(__name__)

MIN_PASSWORD_LENGTH = 8


async def get_user_db(
    session: AsyncSession = Depends(get_session),
) -> AsyncIterator[SQLAlchemyUserDatabase[User, uuid.UUID]]:
    yield SQLAlchemyUserDatabase(session, User)


class UserManager(UUIDIDMixin, BaseUserManager[User, uuid.UUID]):
    def __init__(
        self, user_db: SQLAlchemyUserDatabase[User, uuid.UUID], settings: Settings
    ) -> None:
        super().__init__(user_db)
        # Capture the concrete adapter's AsyncSession now, before super() upcasts
        # user_db to BaseUserDatabase (which has no .session) — used to revoke tokens.
        self._session: AsyncSession = user_db.session
        # Both are required class attributes even though the verify router is not
        # mounted; the reset router uses reset_password_token_secret (plan §13.3).
        self.reset_password_token_secret = settings.jwt_secret
        self.verification_token_secret = settings.jwt_secret

    async def validate_password(self, password: str, user: Any) -> None:
        # Length-only policy (R3/AM-G): argon2 + rate limiting are the real
        # defenses; NIST 800-63 favors length over composition. Routed through
        # register, reset, and update flows (one definition guards all three).
        if len(password) < MIN_PASSWORD_LENGTH:
            raise InvalidPasswordException(
                reason=f"Password must be at least {MIN_PASSWORD_LENGTH} characters."
            )

    async def on_after_register(
        self, user: User, request: Request | None = None
    ) -> None:
        # Log-only no-op in 1.1; 1.2 extends this to create the profile row.
        logger.info("user registered: %s", user.id)

    async def on_after_forgot_password(
        self, user: User, token: str, request: Request | None = None
    ) -> None:
        # No email infra: the operator reads the token from logs and calls
        # /auth/reset-password (architecture §5; revisit at the multi-user trigger).
        logger.warning("password reset token for %s: %s", user.id, token)

    async def on_after_reset_password(
        self, user: User, request: Request | None = None
    ) -> None:
        # Revoke every refresh token so a reset (forgotten/compromised password)
        # actually logs the user out everywhere (R1/AM-E).
        await self._revoke_all_refresh_tokens(user.id)

    async def on_after_update(
        self,
        user: User,
        update_dict: dict[str, Any],
        request: Request | None = None,
    ) -> None:
        # update_dict carries the raw "password" key when the password changed
        # (verified against BaseUserManager.update). Same revocation as reset.
        if "password" in update_dict:
            await self._revoke_all_refresh_tokens(user.id)

    async def _revoke_all_refresh_tokens(self, user_id: uuid.UUID) -> None:
        # Raw DELETE (not the ORM delete()) so no typed-column reference is needed
        # against the TYPE_CHECKING-split model.
        await self._session.execute(
            text("DELETE FROM refresh_tokens WHERE user_id = :user_id"),
            {"user_id": user_id},
        )
        await self._session.commit()


async def get_user_manager(
    request: Request,
    user_db: SQLAlchemyUserDatabase[User, uuid.UUID] = Depends(get_user_db),
) -> AsyncIterator[UserManager]:
    # Settings from app.state, never module-level get_settings() (architecture §8).
    yield UserManager(user_db, request.app.state.settings)


def get_jwt_strategy(request: Request) -> JWTStrategy[User, uuid.UUID]:
    settings: Settings = request.app.state.settings
    return JWTStrategy(
        secret=settings.jwt_secret,
        lifetime_seconds=settings.access_token_lifetime_seconds,
    )


def get_refresh_strategy(
    session: AsyncSession, settings: Settings
) -> DatabaseStrategy[User, uuid.UUID, RefreshToken]:
    return DatabaseStrategy(
        SQLAlchemyAccessTokenDatabase(session, RefreshToken),
        lifetime_seconds=settings.refresh_token_lifetime_seconds,
    )


bearer_transport = BearerTransport(tokenUrl="/auth/login")
jwt_backend = AuthenticationBackend(
    name="jwt", transport=bearer_transport, get_strategy=get_jwt_strategy
)

# JWT backend ONLY (F6) — refresh tokens can never authenticate a protected route.
fastapi_users = FastAPIUsers[User, uuid.UUID](get_user_manager, [jwt_backend])

current_active_user = fastapi_users.current_user(active=True)
