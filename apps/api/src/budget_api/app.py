"""FastAPI application factory and lifespan.

The engine and sessionmaker are created in the lifespan and stored on
``app.state`` so each app instance owns its engine on the running loop; the
lifespan disposes the engine on shutdown. Resolved settings and the rate limiter
are also stored on ``app.state`` (read at request time by the auth deps and the
rate-limit callables; see architecture §8 and rate_limit.py's AM-C design).
"""

import logging
import uuid
from collections.abc import AsyncGenerator
from contextlib import AsyncExitStack, asynccontextmanager
from datetime import UTC, datetime
from typing import Any

import httpx

# APScheduler 3.x ships no type stubs, so its symbols and ``add_job`` come in as
# partially unknown under strict mode; the ignores here and on the two add_job
# calls are that and only that (the kwargs handed to the job ARE typed —
# see job_kwargs).
from apscheduler.schedulers.asyncio import AsyncIOScheduler  # type: ignore
from apscheduler.triggers.cron import CronTrigger  # type: ignore
from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from slowapi.errors import RateLimitExceeded
from sqlalchemy.exc import SQLAlchemyError

from budget_api import __version__
from budget_api.config import Settings, get_settings
from budget_api.db import build_engine, build_sessionmaker
from budget_api.mcp.exposure import pat_allowlist
from budget_api.mcp.remote import INTERNAL_BASE_URL, build_remote
from budget_api.oauth.routes import oauth_routes
from budget_api.oauth.urls import PublicUrls
from budget_api.pat_audit import PatAuditMiddleware
from budget_api.rate_limit import (
    limiter,
    prime_rate_limit,
    rate_limit_exceeded_handler,
)
from budget_api.routers import (
    accounts,
    advisor,
    auth,
    categories,
    deposits,
    fx,
    goal_item_files,
    goal_items,
    goals,
    health,
    limits,
    oauth,
    profile,
    push,
    receipts,
    recurring,
    statement_imports,
    stats,
    tokens,
    transactions,
    users,
)
from budget_api.services.advisor import Advisor
from budget_api.services.fx_jobs import catch_up_needed, fetch_daily_rates
from budget_api.services.fx_rates import FxRateFetcher
from budget_api.services.push_jobs import send_daily_reminders
from budget_api.services.push_sender import PushSender
from budget_api.services.receipt_parser import ReceiptParser
from budget_api.services.recurring_jobs import materialize_due
from budget_api.services.storage import Storage

logger = logging.getLogger(__name__)

#: The package logger every module of this API writes to (``budget_api.*``
#: propagates here). Configured once by :func:`_configure_logging` below.
_PACKAGE_LOGGER = "budget_api"
#: uvicorn's own plain-text shape, so our lines sit flush with its startup output
#: instead of announcing a second logging system.
_LOG_FORMAT = "%(levelname)s:     %(name)s: %(message)s"


def _configure_logging(settings: Settings) -> None:
    """Give ``budget_api`` a handler so its INFO lines reach the server's output.

    Neither uvicorn nor FastAPI configures the ROOT logger: uvicorn's default
    dictConfig sets up ``uvicorn``/``uvicorn.error``/``uvicorn.access`` and nothing
    else, so a record from ``budget_api.*`` propagates to a root with no handlers
    and is served by ``logging.lastResort`` — which is hardcoded to WARNING. Every
    ``logger.info`` in this codebase (the idempotent-replay recovery, a refused
    statement file) was therefore invisible in production: the one class of event
    that is deliberately NOT an error, and therefore the one you can only learn
    about from a log.

    Attached to the package logger rather than the root: this configures OUR
    output and leaves uvicorn's, and any embedding process's, alone. Idempotent —
    ``create_app`` is called per app instance (the whole pytest suite builds one
    per test) and handlers must not stack up.
    """
    package_logger = logging.getLogger(_PACKAGE_LOGGER)
    package_logger.setLevel(settings.log_level.upper())
    if not package_logger.handlers:
        # stderr, which is where uvicorn's own default handler writes.
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter(_LOG_FORMAT))
        package_logger.addHandler(handler)


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved = settings or get_settings()
    _configure_logging(resolved)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncGenerator[None]:
        engine = build_engine(resolved)
        app.state.engine = engine
        app.state.sessionmaker = build_sessionmaker(engine)
        # The scheduler is the only seam owning both the running loop and the
        # sessionmaker, so it is built here (the engine precedent) and torn down
        # before the engine. It now carries THREE features behind three
        # independent gates; with all of them disabled (the whole pytest suite)
        # there is no scheduler object, no jobs, and no boot DB read at all.
        scheduler: AsyncIOScheduler | None = None
        if (
            resolved.fx_scheduler_enabled
            or resolved.recurring_scheduler_enabled
            or resolved.push_scheduler_enabled
        ):
            scheduler = AsyncIOScheduler()
            if resolved.fx_scheduler_enabled:
                job_kwargs: dict[str, Any] = {
                    "sessionmaker": app.state.sessionmaker,
                    "fetcher": app.state.fx_fetcher,
                    "backfill_days": resolved.fx_backfill_days,
                }
                scheduler.add_job(  # type: ignore
                    fetch_daily_rates,
                    CronTrigger(
                        hour=resolved.fx_fetch_hour_utc,
                        minute=resolved.fx_fetch_minute_utc,
                        timezone="UTC",
                    ),
                    kwargs=job_kwargs,
                    # APScheduler's 1s default misfire_grace_time would silently skip
                    # a whole day if the host slept through the cron time; allow one
                    # late run within the hour, collapsed if several were missed.
                    misfire_grace_time=3600,
                    coalesce=True,
                )
                # One LOCAL read; the catch-up fetch itself runs as a background job
                # so startup never blocks on (or fails from) a provider being down
                # (D3).
                try:
                    async with app.state.sessionmaker() as session:
                        needs_catch_up = await catch_up_needed(
                            session, today=datetime.now(UTC).date()
                        )
                except (SQLAlchemyError, TimeoutError, OSError) as exc:
                    # A DB that is down at boot must not stop the app from starting —
                    # /health is what reports that (its own timeout-bounded probe,
                    # same catch tuple: asyncpg surfaces a refused connection as
                    # OSError, which is NOT a SQLAlchemyError).
                    logger.warning("fx catch-up probe failed: %r", exc)
                    needs_catch_up = False
                if needs_catch_up:
                    scheduler.add_job(  # type: ignore
                        fetch_daily_rates,
                        next_run_time=datetime.now(UTC),
                        kwargs=job_kwargs,
                        # Explicitly a "run now" job: APScheduler's 1s default grace
                        # would discard it as a misfire if the loop is busy at startup.
                        misfire_grace_time=None,
                    )
            if resolved.recurring_scheduler_enabled:
                # ``today`` is deliberately NOT bound: kwargs are frozen at schedule
                # time, so a bound date would freeze the job's idea of "today" until
                # the next process restart. The job computes it per run (D5).
                recurring_kwargs: dict[str, Any] = {
                    "sessionmaker": app.state.sessionmaker
                }
                scheduler.add_job(  # type: ignore
                    materialize_due,
                    CronTrigger(
                        hour=resolved.recurring_materialize_hour_utc,
                        minute=resolved.recurring_materialize_minute_utc,
                        timezone="UTC",
                    ),
                    kwargs=recurring_kwargs,
                    # Same reasoning as the fx cron above: a host asleep at 00:30 UTC
                    # must still book the day's occurrences, once.
                    misfire_grace_time=3600,
                    coalesce=True,
                )
                # UNCONDITIONAL boot catch-up (D5), no probe: any probe would run the
                # same tiny query the job itself starts with, and the job never
                # raises — so a probe could only add a second way to be wrong.
                scheduler.add_job(  # type: ignore
                    materialize_due,
                    next_run_time=datetime.now(UTC),
                    kwargs=recurring_kwargs,
                    # Explicitly a "run now" job: APScheduler's 1s default grace would
                    # discard it as a misfire if the loop is busy at startup.
                    misfire_grace_time=None,
                )
            if resolved.push_scheduler_enabled:
                # Registered whether or not VAPID keys are set: a keyless job logs
                # one line and returns (push_jobs.py), so the gate alone decides
                # registration. ``today`` is NOT bound, for the D5 reason above.
                push_kwargs: dict[str, Any] = {
                    "sessionmaker": app.state.sessionmaker,
                    "sender": app.state.push_sender,
                    "horizon_days": resolved.push_reminder_horizon_days,
                }
                scheduler.add_job(  # type: ignore
                    send_daily_reminders,
                    CronTrigger(
                        hour=resolved.push_reminder_hour_utc,
                        minute=resolved.push_reminder_minute_utc,
                        timezone="UTC",
                    ),
                    kwargs=push_kwargs,
                    # A host asleep at the slot still sends within the hour, once;
                    # past the grace hour the day is simply skipped.
                    misfire_grace_time=3600,
                    coalesce=True,
                )
                # Deliberately NO boot run-now job (unlike recurring): a restart
                # must not push. The per-day claim would keep it from DUPLICATING,
                # but a late-evening restart after a missed 06:00 would deliver a
                # morning digest at 23:00 — a stale reminder is worse than none.
            scheduler.start()
        app.state.scheduler = scheduler
        # The remote MCP transport, if this deployment has one (create_app built
        # the manager only when PUBLIC_BASE_URL is set). Two things have to exist
        # for the lifetime of the app and only here can they: the manager's task
        # group, and the ONE httpx client every tool call re-enters this app
        # through. raise_app_exceptions=False is mandatory — an inner 500 must
        # become text the model reads, not an exception inside a JSON-RPC
        # handler (mcp/remote.py).
        manager: StreamableHTTPSessionManager | None = app.state.mcp_manager
        try:
            async with AsyncExitStack() as remote:
                if manager is not None:
                    app.state.mcp_api_client = await remote.enter_async_context(
                        httpx.AsyncClient(
                            transport=httpx.ASGITransport(
                                app=app, raise_app_exceptions=False
                            ),
                            base_url=INTERNAL_BASE_URL,
                        )
                    )
                    # Entered second, so it is torn down FIRST: no request may
                    # still be in flight when the client it borrows closes.
                    await remote.enter_async_context(manager.run())
                yield
        finally:
            app.state.mcp_api_client = None
            if scheduler is not None:
                # wait=False, and BEFORE dispose: a running job holds a session from
                # this engine, so the engine must outlive the shutdown call.
                scheduler.shutdown(wait=False)
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
    # Anthropic streaming seam, same construction contract as receipt_parser above
    # (stateless, Settings-only, no I/O at build time). The ask route reads it off
    # app.state per request and pytest swaps a fake here, so no test streams from
    # Anthropic.
    app.state.advisor = Advisor(resolved)
    # Provider fetch seam, same construction contract as receipt_parser above
    # (stateless, Settings-only, no I/O at build time). The scheduler job reads it
    # off app.state, and pytest swaps a fake here so no test calls a provider.
    app.state.fx_fetcher = FxRateFetcher(resolved)
    # Web Push delivery seam, same construction contract as the seams above
    # (Settings-only, no I/O at build time). /push/test reads it off app.state, the
    # daily job gets it in its kwargs, and pytest swaps a recording fake here so no
    # test reaches a push service.
    app.state.push_sender = PushSender(resolved)
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
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )
    # PAT audit trail (5.6 architecture §6): writes one pat_audit_log row per call
    # that carried a personal access token. Added AFTER CORS, so it is the OUTERMOST
    # user middleware and observes the final status of every request — including one
    # an exception handler turned into a 4xx. It can never fail a request
    # (pat_audit.py), and it does nothing at all for JWT traffic.
    app.add_middleware(PatAuditMiddleware)

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
    # No Depends(prime_rate_limit): the accounts router never calls limiter.limit
    # (DB-only CRUD plus one grouped balance read), so it never touches the
    # rate-limit contextvar — identical construction to the categories mount above.
    app.include_router(accounts.router, prefix="/accounts", tags=["accounts"])
    # No Depends(prime_rate_limit): the deposits router never calls limiter.limit
    # (DB-only CRUD plus the same grouped balance read /accounts does), so it never
    # touches the rate-limit contextvar — identical construction to the categories
    # mount above. It declares no static segment under /deposits, so there is no
    # mount-order landmine of the /goals kind.
    app.include_router(deposits.router, prefix="/deposits", tags=["deposits"])
    # No Depends(prime_rate_limit): the transactions router never calls
    # limiter.limit, so it never touches the rate-limit contextvar (decision n;
    # identical construction to the categories mount above).
    app.include_router(
        transactions.router, prefix="/transactions", tags=["transactions"]
    )
    # No Depends(prime_rate_limit): the fx router never calls limiter.limit
    # (GET /fx/convert is a DB-only read), so it never touches the rate-limit
    # contextvar — identical construction to the categories mount above.
    app.include_router(fx.router, prefix="/fx", tags=["fx"])
    # MOUNTED BEFORE goals.py, and that order is load-bearing (goal-planner §6):
    # this router owns the STATIC segments under /goals, and a router mounted
    # after one that declares /{goal_id} can never win a path like
    # /goals/upcoming. Same no-rate-limit construction as the mounts above.
    app.include_router(goal_items.router, prefix="/goals", tags=["goal-items"])
    # Attachments live in their own router (goal-planner §7) and mount BEFORE
    # goals.py for the same reason as the line above. No Depends(prime_rate_limit):
    # unlike /receipts, these routes call no limiter.limit — the cost driver here is
    # the per-node cap of ten, not a per-user quota.
    app.include_router(
        goal_item_files.router, prefix="/goals", tags=["goal-item-files"]
    )
    # No Depends(prime_rate_limit): the goals router never calls limiter.limit
    # (DB-only CRUD, no cost driver — D12), so it never touches the rate-limit
    # contextvar — identical construction to the categories mount above.
    app.include_router(goals.router, prefix="/goals", tags=["goals"])
    # No Depends(prime_rate_limit): the recurring router never calls limiter.limit
    # (DB-only CRUD, no cost driver — D1; the materialization it configures runs in
    # the scheduler, not in a request), so it never touches the rate-limit
    # contextvar — identical construction to the categories mount above.
    app.include_router(recurring.router, prefix="/recurring", tags=["recurring"])
    # No Depends(prime_rate_limit): the limits router never calls limiter.limit
    # (DB-only CRUD plus one shared aggregate read, no cost driver — D1), so it
    # never touches the rate-limit contextvar — identical construction to the
    # categories mount above.
    app.include_router(limits.router, prefix="/limits", tags=["limits"])
    # No Depends(prime_rate_limit): the stats router never calls limiter.limit
    # (DB-only aggregate reads, no cost driver — D4), so it never touches the
    # rate-limit contextvar — identical construction to the categories mount above.
    app.include_router(stats.router, prefix="/stats", tags=["stats"])
    # No Depends(prime_rate_limit): the tokens router never calls limiter.limit —
    # PAT rate limiting lives inside the pat_auth dependency and reads settings off
    # request.app.state, not the contextvar (architecture §6). Identical
    # construction to the categories mount above.
    app.include_router(tokens.router, prefix="/tokens", tags=["tokens"])
    # No Depends(prime_rate_limit): the profile router never calls limiter.limit
    # (one row read and one row write), so it never touches the rate-limit
    # contextvar — identical construction to the categories mount above. PATCH is
    # JWT-only by dependency and unmarked (routers/profile.py); GET carries the
    # get_profile tool marker.
    app.include_router(profile.router, prefix="/profile", tags=["profile"])
    # Depends(prime_rate_limit) travels with the router (auth precedent): POST
    # /receipts is per-user rate limited, so the router can never be mounted
    # unprimed (an unprimed limiter check would 500).
    app.include_router(
        receipts.router,
        prefix="/receipts",
        tags=["receipts"],
        dependencies=[Depends(prime_rate_limit)],
    )
    # Depends(prime_rate_limit) travels with the router (the receipts precedent):
    # POST /statement-imports is per-user rate limited, so it can never be mounted
    # unprimed (an unprimed limiter check would 500). It declares no static segment
    # under its prefix, so there is no mount-order landmine of the /goals kind.
    app.include_router(
        statement_imports.router,
        prefix="/statement-imports",
        tags=["statement-imports"],
        dependencies=[Depends(prime_rate_limit)],
    )
    # Depends(prime_rate_limit) travels with the router (the receipts precedent):
    # POST /advisor/ask is per-user rate limited, so it can never be mounted
    # unprimed (an unprimed limiter check would 500).
    app.include_router(
        advisor.router,
        prefix="/advisor",
        tags=["advisor"],
        dependencies=[Depends(prime_rate_limit)],
    )
    # Depends(prime_rate_limit) travels with the router (the receipts precedent):
    # POST /push/test is per-user rate limited, so it can never be mounted
    # unprimed (an unprimed limiter check would 500). JWT-only and unmarked, so no
    # /push pair enters the PAT allowlist derived below.
    app.include_router(
        push.router,
        prefix="/push",
        tags=["push"],
        dependencies=[Depends(prime_rate_limit)],
    )
    # No Depends(prime_rate_limit): the consent/connected-apps router never calls
    # limiter.limit — the PRE-grant OAuth endpoints are limited per IP inside
    # oauth/routes.py, and these four routes are an authenticated browser's. All
    # four are JWT-only and unmarked, so no /oauth pair enters the PAT allowlist
    # derived below (routers/oauth.py).
    app.include_router(oauth.router, prefix="/oauth", tags=["oauth"])

    # The remote connector's URL topology, resolved ONCE (settings cannot change
    # under a running app) and published on app.state for the routes and the
    # transport to read. None == no PUBLIC_BASE_URL == the feature is off, which is
    # the state of dev, the whole pytest suite bar its own tests, and the hermetic
    # contract export.
    app.state.public_urls = PublicUrls.from_settings(resolved)
    # The remote transport's two long-lived objects. Both stay None when the
    # connector is off, and that is the single condition the lifespan branches on.
    app.state.mcp_manager = None
    app.state.mcp_api_client = None
    if app.state.public_urls is not None:
        # Built from THIS app: the tool schemas are the contract's own bytes, read
        # off the app that will serve the calls (mcp/remote.py). The Server itself
        # is reachable through the manager, which owns it.
        _, manager = build_remote(app)
        app.state.mcp_manager = manager
        # BEFORE the pat_allowlist line, and that order is load-bearing (ruling
        # R7): the exposure walk below then MEETS these routes, so its TypeError
        # tripwire against an unknown route container fires at production startup
        # and not only in a test that happens to build the app with URLs set.
        app.router.routes.extend(
            oauth_routes(app, resolved, app.state.public_urls, manager)
        )

    # AFTER the last include_router and deliberately not in the lifespan: the PAT
    # gate reads this set on every token request, and a test app built without a
    # lifespan must have it too. It is derived from the markers on the handlers
    # (mcp/decorator.py), so a route nobody decided about is unreachable by a
    # token — fail-closed by construction, no literal to keep in step.
    app.state.pat_allowlist = pat_allowlist(app)
    return app
