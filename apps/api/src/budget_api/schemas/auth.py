"""Auth request/response schemas."""

from typing import Literal

from pydantic import BaseModel


class TokenPair(BaseModel):
    """Single shape for both /auth/login and /auth/refresh responses."""

    access_token: str
    refresh_token: str
    token_type: Literal["bearer"] = "bearer"


class RefreshRequest(BaseModel):
    refresh_token: str


class LogoutRequest(BaseModel):
    refresh_token: str


class RateLimitedError(BaseModel):
    """429 body — one error envelope across the API (AM-I)."""

    detail: str
