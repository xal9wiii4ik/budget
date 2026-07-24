"""GET /health — liveness plus a real DB round-trip through the production path."""

import asyncio
import logging

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.db import get_session
from budget_api.schemas.health import HealthResponse

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get(
    "/health",
    response_model=HealthResponse,
    responses={503: {"model": HealthResponse, "description": "Database unavailable"}},
)
async def health(
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> HealthResponse:
    try:
        await asyncio.wait_for(session.execute(text("SELECT 1")), timeout=2.0)
    except (SQLAlchemyError, TimeoutError, OSError) as exc:
        # Detail is logged server-side, never returned (API faces the internet).
        logger.warning("health DB check failed: %s", exc)
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return HealthResponse(status="degraded", database="unavailable")
    return HealthResponse(status="ok", database="ok")
