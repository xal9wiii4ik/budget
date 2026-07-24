"""FastAPI application factory and lifespan.

The engine and sessionmaker are created in the lifespan and stored on
``app.state`` so each app instance owns its engine on the running loop; the
lifespan disposes the engine on shutdown.
"""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from budget_api import __version__
from budget_api.config import Settings, get_settings
from budget_api.db import build_engine, build_sessionmaker
from budget_api.routers import health


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
    app.include_router(health.router)
    return app
