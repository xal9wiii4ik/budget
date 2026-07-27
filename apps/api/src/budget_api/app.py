"""FastAPI application factory and lifespan.

The engine and sessionmaker are created in the lifespan and stored on
``app.state`` so each app instance owns its engine on the running loop; the
lifespan disposes the engine on shutdown. Resolved settings and the rate limiter
are also stored on ``app.state`` (read at request time by the auth deps and the
rate-limit callables; see architecture §8 and rate_limit.py's AM-C design).
"""

import uuid
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi.errors import RateLimitExceeded

from budget_api import __version__
from budget_api.config import Settings, get_settings
from budget_api.db import build_engine, build_sessionmaker
from budget_api.rate_limit import (
    limiter,
    prime_rate_limit,
    rate_limit_exceeded_handler,
)
from budget_api.routers import (
    auth,
    categories,
    health,
    receipts,
    transactions,
    users,
)
from budget_api.services.receipt_parser import ReceiptParser
from budget_api.services.storage import Storage


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncGenerator[None]:
        engine = build_engine(resolved)
        app.state.engine = engine
        app.state.sessionmaker = build_sessionmaker(engine)
        try:
            yield
        finally:
            await engine.dispose()

    app = FastAPI(title="Budget API", version=__version__, lifespan=lifespan)
    app.state.settings = resolved
    # Presign facade constructed once per app (stateless, no I/O at build time);
    # the receipts router reads it off app.state per request (app.state precedent).
    app.state.storage = Storage(resolved)
    # Anthropic parse seam constructed once per app (stateless, Settings-only, no I/O
    # at build time); the parse route reads it off app.state per request, and the
    # pytest layer swaps a fake at this seam so no test makes a live Anthropic call.
    app.state.receipt_parser = ReceiptParser(resolved)
    # Shared process-global limiter; per-app isolation is dynamic (rate_limit.py).
    # A unique scope makes this app's rate-limit storage keys distinct from every
    # other app instance's (multi-app test safety, AM-C).
    app.state.limiter = limiter
    app.state.rate_limit_scope = uuid.uuid4().hex
    app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)

    # CORS: only the application's own origins may make browser cross-origin calls
    # (architecture §3). Credentials stay off — the web client authenticates with
    # bearer tokens in the Authorization header, never cookies (AM-9).
    app.add_middleware(
        CORSMiddleware,
        allow_origins=resolved.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

    app.include_router(health.router)
    # The auth router primes the per-request rate-limit settings contextvar itself
    # via its own router-level dependency (finding 4), so it cannot be mounted
    # unprimed; only the /auth routes are limited.
    app.include_router(auth.router)
    app.include_router(users.router, prefix="/users", tags=["users"])
    # No Depends(prime_rate_limit): the categories router never calls
    # limiter.limit, so it never touches the rate-limit contextvar (plan §rate
    # limiting; grep-confirmed prime_rate_limit is read only by @limiter.limit routes).
    app.include_router(categories.router, prefix="/categories", tags=["categories"])
    # No Depends(prime_rate_limit): the transactions router never calls
    # limiter.limit, so it never touches the rate-limit contextvar (decision n;
    # identical construction to the categories mount above).
    app.include_router(
        transactions.router, prefix="/transactions", tags=["transactions"]
    )
    # Depends(prime_rate_limit) travels with the router (auth precedent): POST
    # /receipts is per-user rate limited, so the router can never be mounted
    # unprimed (an unprimed limiter check would 500).
    app.include_router(
        receipts.router,
        prefix="/receipts",
        tags=["receipts"],
        dependencies=[Depends(prime_rate_limit)],
    )
    return app
