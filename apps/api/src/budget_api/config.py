"""Application settings.

Single source of configuration. Imports nothing internal (see architecture §1
dependency direction). ``get_settings`` is the canonical accessor used by
``create_app``'s default and ``alembic/env.py``; tests construct ``Settings``
explicitly and never touch the cache.
"""

from functools import lru_cache
from urllib.parse import urlsplit

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

#: Hosts a plaintext ``http://`` public base URL may name (see
#: ``Settings.public_base_url``). Anything else must be https: the OAuth
#: credentials of the remote connector travel over that base URL.
_PLAINTEXT_BASE_URL_HOSTS = frozenset({"localhost", "127.0.0.1"})


class Settings(BaseSettings):
    database_url: str
    # Required, no default: fail fast if JWT_SECRET is missing from the env. Signs
    # access JWTs and (reused for single-secret simplicity) reset-password tokens.
    jwt_secret: str

    # Token lifetimes. Kept as fields (not surfaced in .env.example) so tests can
    # shrink them; code defaults are the production values.
    access_token_lifetime_seconds: int = 900  # ~15 min
    refresh_token_lifetime_seconds: int = 2_592_000  # 30 days

    # Browser origins allowed by CORS (architecture §3: "CORS — только домены
    # приложения"). Default is the vite dev server so the known explicit
    # Settings(...) construction sites (openapi_export, tests, test_health) need no
    # new env. Override in deploy (1.7) via the CORS_ORIGINS env var, which
    # pydantic-settings parses as a JSON array of strings, e.g.
    # CORS_ORIGINS='["https://app.example.com","https://www.example.com"]'.
    cors_origins: list[str] = ["http://localhost:5173"]

    # Rate limiting. Per-app knobs read at request time so the multi-app test
    # pattern can enable/disable and shrink limits per app instance.
    rate_limit_enabled: bool = True
    login_rate_limit: str = "10/minute"
    register_rate_limit: str = "5/hour"
    forgot_password_rate_limit: str = "5/hour"
    # Per-user receipt-create limit (D11): the account is the cost driver, not the
    # localhost IP, so this keys on user id (see rate_limit.receipt_rl_key).
    receipt_create_rate_limit: str = "30/minute"
    # Per-PAT limits (5.6 architecture §6). NOT decorators: the check lives inside
    # the PAT branch of ``pat_auth.current_user_jwt_or_pat``, so JWT traffic on the
    # same ~25 routes is untouched and the whole config stays in two fields. Reads
    # are cheap and an AI client polls; writes touch the ledger, so they are three
    # times tighter.
    pat_read_rate_limit: str = "60/minute"
    pat_write_rate_limit: str = "20/minute"
    # Debounce window for ``personal_access_tokens.last_used_at`` (architecture §2):
    # minute granularity is honest for a "last used" UI and costs no write per call.
    pat_last_used_debounce_seconds: int = 60

    # Object storage (D9/D11). Defaults target the local MinIO from docker-compose
    # (host ports 9010 S3 / 9011 console, private bucket ``receipts``). Every field
    # has a default so the explicit Settings(...) sites (openapi_export, conftest)
    # keep constructing with no S3 env. s3_endpoint_url is a full URL; Storage
    # splits scheme->secure and netloc->endpoint for minio-py.
    s3_endpoint_url: str = "http://localhost:9010"
    s3_access_key: str = "minioadmin"
    s3_secret_key: str = "minioadmin"
    s3_bucket: str = "receipts"
    s3_region: str = "us-east-1"
    s3_presign_put_ttl_seconds: int = 600
    s3_presign_get_ttl_seconds: int = 300

    # Anthropic parse pipeline (D10/D11). ``anthropic_api_key`` defaults to "" so the
    # explicit Settings(...) sites (openapi_export, conftest) keep constructing with
    # no key; the handler turns an empty key into a fast 503 AI_NOT_CONFIGURED rather
    # than a background failure. ``anthropic_model`` is pinned to the dated Haiku 4.5
    # snapshot (anthropic SDK 0.120.0 anthropic.types.model listing) for
    # reproducibility; swap to Sonnet via env if quality demands (open Q4 default).
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-haiku-4-5-20251001"
    receipt_parse_timeout_seconds: int = 90
    # Staleness cutoff for re-claiming a stuck ``processing`` receipt. Kept strictly
    # greater than the parse timeout so a live parse can never be double-claimed.
    receipt_parse_stale_seconds: int = 300
    # Parse-time HEAD size gate. Kept safely under Anthropic's ~5 MB per-image API
    # limit (5_000_000, not 5 MiB, to dodge MB-vs-MiB ambiguity): a larger upload
    # would sail past this 422 gate, claim the row, spend the metered pipeline, and
    # come back as ``failed / ANTHROPIC_ERROR`` — a *permanent* condition mislabeled
    # as transient, sending the client into the wrong (just-re-POST) retry branch
    # instead of the IMAGE_TOO_LARGE "restart from downscale" path.
    receipt_max_bytes: int = 5_000_000
    # Per-user parse limit (D11): each parse is an Anthropic spend, so the account is
    # the cost driver. Keys on user id via rate_limit.receipt_rl_key.
    receipt_parse_rate_limit: str = "10/minute;100/day"

    # AI advisor (D7/D10). ``anthropic_api_key`` above is SHARED with the receipt
    # pipeline: one key, one configured/not state, one 503 AI_NOT_CONFIGURED
    # (``ai_gate``). The model is its OWN setting rather than reusing
    # ``anthropic_model``: advice quality is the feature here, so this defaults to a
    # dated Sonnet snapshot (present in the anthropic 0.120.0 model listing) while
    # OCR keeps its cheaper Haiku — the two economics do not transfer (OQ-8).
    advisor_model: str = "claude-sonnet-4-5-20250929"
    advisor_max_tokens: int = 2048
    # Generous: the client watches a stream, so a slow answer is visibly progressing
    # rather than a hung request.
    advisor_timeout_seconds: int = 120
    # Per-user ask limit (D10/OQ-3): each ask is an Anthropic spend, so the account
    # is the cost driver. Two windows — the burst guard and the daily budget — keyed
    # per user via rate_limit.user_rl_key("advisor").
    advisor_ask_rate_limit: str = "5/minute;20/day"

    # LLM categorization of a statement import (ai-layer architecture §7). Every
    # field has a default, and the DEFAULT STATE OF THIS SERVER IS "no AI": the
    # provider below is ``anthropic`` while ``anthropic_api_key`` above is empty,
    # so ``llm.registry.provider_from_settings`` returns None, imports read
    # ``ai_status=not_configured`` and behave exactly as they did before this
    # scope. Setting the shared key (receipts/advisor reuse it) is what turns the
    # pass on.
    #
    # ``anthropic`` | ``ollama`` | ``fake`` | ``off``. ``fake`` is the synthetic
    # provider in ``llm/fake.py`` — a QA stand demo with no key and no network;
    # ``off`` is the explicit refusal regardless of the key.
    llm_provider: str = "anthropic"
    # The Anthropic model of the categorize pass, and the cheapest member of the
    # family: this is a classification job over a few hundred short strings, not
    # advice. UNLIKE ``anthropic_model``/``advisor_model`` this id carries no date
    # — per docs.claude.com the dateless 5.x ids ARE pinned snapshots, so it is
    # reproducible for the evals exactly as a dated snapshot would be (grooming
    # ruling R4).
    categorize_model: str = "claude-haiku-5-5"
    # Its OWN setting rather than ``categorize_model`` reused (amendment A1): with
    # one knob, LLM_PROVIDER=ollama would ask the local daemon for
    # ``claude-haiku-5-5`` and EVERY call would degrade — a misconfiguration whose
    # only symptom is an import that silently categorizes nothing.
    ollama_model: str = "llama3.1"
    ollama_base_url: str = "http://localhost:11434"
    # Per-call ceiling. Tighter than the receipt/advisor timeouts on purpose: the
    # user is waiting on an upload response, not watching a stream.
    llm_timeout_seconds: int = 30
    # Below this confidence a suggestion is still seeded (the user sees a filled
    # category) but the row is FLAGGED for review. Starting point; the evals run
    # may move it.
    categorize_confidence_threshold: float = 0.7
    # Rows per call. Big enough that a 400-row import is ~20 calls, small enough
    # that losing one answer costs little and that the output stays well inside
    # the model's token budget.
    categorize_batch_size: int = 20
    categorize_concurrency: int = 4
    # The whole pass is bounded by this: batches still running when it expires are
    # cancelled and their rows stay untouched (``ai_status=partial``). The upload
    # handler is therefore bounded too — it never waits on the model indefinitely.
    categorize_time_budget_seconds: int = 45
    # Per-import cap on UNIQUE operations sent (duplicates ride along for free).
    categorize_max_rows_per_import: int = 400
    # Per-user daily row budget, spent through the limiter by the upload handler.
    # The cost driver is rows, not requests, so the limiter is hit with
    # ``cost=len(batch)`` rather than once per call.
    categorize_daily_row_quota: str = "3000/day"

    # FX rates (D1/D3/D4). Every field has a default so the explicit Settings(...)
    # sites (openapi_export, conftest) keep constructing with no FX env.
    # ``fx_scheduler_enabled`` is the D3 gate: the whole pytest suite constructs apps
    # with it False (conftest), so no test ever spawns a background job or makes a
    # provider call; the one real fetch happens live at /test.
    fx_scheduler_enabled: bool = True
    # Daily cron slot: both providers have published by 17:30 UTC on business days
    # (ECB ~16:00 CET, NBRB in the Minsk afternoon) and the nearest-previous lookup
    # absorbs any lag anyway (D2/D3).
    fx_fetch_hour_utc: int = 17
    fx_fetch_minute_utc: int = 30
    # One-shot history depth when a provider has no rows at all (D4, OQ-3 default):
    # "a year ago" plus lookup slack, so pre-existing transactions convert on day one.
    fx_backfill_days: int = 400
    fx_http_timeout_seconds: int = 30
    # Provider base URLs as settings so a live session can point at a local stub.
    frankfurter_base_url: str = "https://api.frankfurter.app"
    nbrb_base_url: str = "https://api.nbrb.by"

    # Recurring materialization (D5). Same gate construction as
    # ``fx_scheduler_enabled``: the whole pytest suite constructs apps with it
    # False, test servers run RECURRING_SCHEDULER_ENABLED=false, and the job
    # function is exercised by direct call — never via a live scheduler (the one
    # exception is tests/test_scheduler_wiring.py, which asserts registration
    # only, against a template-free DB).
    recurring_scheduler_enabled: bool = True
    # Daily cron just after the UTC date rolls over, so a row due "today" exists
    # before any user wakes up. (fx runs 17:30 UTC for provider-publication
    # reasons that do not apply to a local-only job.)
    recurring_materialize_hour_utc: int = 0
    recurring_materialize_minute_utc: int = 30

    # Web push reminders (web-push architecture §2). The VAPID trio defaults to ""
    # so the explicit Settings(...) sites (openapi_export, conftest) keep
    # constructing with no keys; the feature is ON if and only if ALL THREE are
    # non-empty (``PushSender.enabled``), otherwise the push routes answer 503
    # PUSH_NOT_CONFIGURED and the job logs one line and returns. Formats:
    # ``vapid_public_key`` = base64url of the UNCOMPRESSED P-256 point (65 bytes,
    # leading 0x04) — what the browser's ``applicationServerKey`` takes;
    # ``vapid_private_key`` = base64url of the raw 32-byte private scalar — the
    # string form ``pywebpush``/``py_vapid.Vapid.from_string`` accepts;
    # ``vapid_subject`` = the ``mailto:`` (or https:) contact claim push services
    # require. The owner generates them (one-liner in .env.example).
    vapid_public_key: str = ""
    vapid_private_key: str = ""
    vapid_subject: str = ""
    # Same gate construction as ``recurring_scheduler_enabled``: the whole pytest
    # suite constructs apps with it False, test/QA servers run
    # PUSH_SCHEDULER_ENABLED=false, and the job is exercised by direct call. A
    # keyless server with the gate on is harmless — the job no-ops.
    push_scheduler_enabled: bool = True
    # The daily digest slot. MUST stay AFTER the 00:30 recurring materializer:
    # today's charges are then already booked and drop out of the upcoming set by
    # their watermark, which is what makes the charges family "due tomorrow" and
    # not a reminder about money that has already moved.
    push_reminder_hour_utc: int = 6
    push_reminder_minute_utc: int = 0
    # The "soon" window is ``[today, today + horizon]`` for all three families.
    # 0 = today only: goal reminders on their reminder date, and the charges family
    # is then ALWAYS empty (00:30 already booked today's, see above). Negative is
    # refused at boot — it would empty every family and claim every subscriber.
    push_reminder_horizon_days: int = Field(default=1, ge=0)
    # Per-user limit on POST /push/test: each call is an outbound request per
    # device, so the account is the cost driver (rate_limit.user_rl_key).
    push_test_rate_limit: str = "5/minute"
    # EXISTS ONLY FOR A LOCAL STUB PUSH SERVICE ON A QA STAND. Off, a subscription
    # endpoint must be an https URL whose host is a dotted ASCII name — never a
    # literal IP, ``localhost`` or a bare label (domain/push_endpoint) — because the
    # server POSTs to that URL on its own (the daily job, /push/test): an unchecked
    # endpoint is a request-forgery primitive into the server's own network. On,
    # ANY absolute http(s) URL is accepted.
    # Never set it on a server real users reach.
    push_allow_insecure_endpoints: bool = False

    # Goal plan bounds (goal-planner §10a). VALIDATION limits, not DB constraints:
    # the schema stays "dynamic" as the user asked, and raising either of these is
    # a config change rather than a migration. Depth 6 is where breadcrumbs stop
    # being readable; 500 nodes is what keeps the recursive read's unnest cheap
    # (500 x 6 ~ 3000 rows).
    goal_item_max_depth: int = 6
    goal_items_max_per_goal: int = 500
    # Attachments per node (§7). Its own bound, but NOT its own SIZE bound: the
    # byte ceiling stays ``receipt_max_bytes`` — one number for "how big an image
    # this server accepts", so the two upload paths can never drift apart.
    goal_item_files_max_per_item: int = 10

    # Statement import (statement-import architecture §6). A year of a real
    # Priorbank statement is ~1000 lines / well under 200 KB, so 1 MB is generous
    # while still refusing "the wrong file" before it is decoded and parsed. The
    # gate reads limit+1 bytes off the upload rather than trusting Content-Length:
    # a multipart header is a client claim, and the bytes are the fact.
    statement_max_bytes: int = 1_000_000
    # Per-user upload limit: one upload parses and matches up to a thousand rows
    # against the account's history, so the account (not the IP — on localhost
    # everyone shares one) is the cost driver. Keys via
    # rate_limit.statement_import_rl_key.
    statement_import_rate_limit: str = "10/minute"
    # How long an unfinished (``parsed``) session survives. Cleaned lazily by the
    # next upload instead of by a scheduler: an abandoned preview is worthless, and
    # a whole cron job to notice that would be more moving parts than the feature.
    statement_import_ttl_days: int = 7

    # Remote MCP connector / OAuth authorization server (mcp-remote §D5). THE
    # feature switch: empty (dev, pytest, the hermetic contract export) means the
    # OAuth and /mcp Starlette routes are not registered at all. Set it to the URL
    # the OUTSIDE world uses — docker-compose.prod.yml derives it from SITE_DOMAIN
    # — because nothing inside this process can know it: the API sits behind nginx
    # behind Caddy, and the public ``/api/`` prefix does not exist in here.
    #
    # A plain ``str`` with a validator, deliberately NOT AnyHttpUrl: that type
    # renders "https://host" as "https://host/", and a trailing slash in the
    # published issuer is a different server to an OAuth client.
    public_base_url: str = ""
    # Lifetimes as fields (the access_token_lifetime_seconds precedent) so tests
    # shrink them instead of sleeping; the code defaults are the production values.
    # An access token lives an hour: Claude refreshes ~5 minutes early, so this is
    # ~11 cheap rotations a day. A refresh token lives 30 days SLIDING (the same
    # figure as the web session's refresh token) with NO absolute cap — a connector
    # someone uses daily must not die on a fixed day with "Authorization failed" as
    # its only symptom, and Settings → Revoke is the kill switch.
    oauth_access_token_lifetime_seconds: int = 3600
    oauth_refresh_token_lifetime_seconds: int = 2_592_000  # 30 days
    # An authorization code is redeemed by a program within a second (RFC 6749
    # §4.1.2 says "short"); 60s absorbs a slow network and nothing else.
    oauth_authorization_code_lifetime_seconds: int = 60
    # How long a pending consent survives: the time a human needs to read the
    # consent page, log in if they were not, and click.
    oauth_request_lifetime_seconds: int = 600
    # Per-IP limits on the PRE-grant endpoints (architecture §D9): there is no
    # token to key a budget on yet. Registration is the expensive one — it is open
    # to anonymous callers and writes a row — and a REFUSED registration spends the
    # bucket too (ruling R8), so the limiter sits ahead of validation. Hosted
    # Claude's DCR arrives from Anthropic's shared egress IPs, so this bucket is
    # effectively per deployment, not per user — 30 keeps anonymous row writes
    # bounded without capping onboarding at ten connections an hour.
    oauth_register_rate_limit: str = "30/hour"
    oauth_endpoint_rate_limit: str = "60/minute"

    # What of OUR OWN output reaches the server's log (app.py::_configure_logging).
    # INFO by default because this API's info lines are deliberate operational
    # facts — a refused statement file, an idempotent replay recovered from a race —
    # and each is a question support would otherwise have no answer to. Neither
    # uvicorn nor FastAPI configures the root logger, so without that call anything
    # below WARNING is dropped by logging's lastResort handler.
    log_level: str = "INFO"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @field_validator("public_base_url")
    @classmethod
    def _check_public_base_url(cls, value: str) -> str:
        """Scheme + host only, no trailing slash, and ``http://`` only on loopback.

        Refused at BOOT rather than discovered later, because every consequence of
        a wrong value is silent or confusing: a path would be duplicated into every
        published endpoint, a trailing slash would make the issuer a different
        server to Claude's discovery check, and ``http://`` on a real host would
        put authorization codes and bearer tokens on the wire in plaintext — the
        two stands that legitimately need it (the prod-like compose on
        ``https://localhost:8443`` is https; the vite stand is
        ``http://localhost:5199``) are loopback, so the exception stops there
        (ruling R6).
        """
        if not value:
            return value
        trimmed = value.rstrip("/")
        parts = urlsplit(trimmed)
        if parts.scheme not in {"http", "https"} or not parts.netloc:
            raise ValueError("PUBLIC_BASE_URL must be an http(s) URL with a host")
        if parts.path or parts.query or parts.fragment:
            raise ValueError("PUBLIC_BASE_URL must carry no path, query or fragment")
        if parts.scheme == "http" and (parts.hostname or "") not in (
            _PLAINTEXT_BASE_URL_HOSTS
        ):
            raise ValueError(
                "PUBLIC_BASE_URL may only be http:// for localhost or 127.0.0.1"
            )
        return trimmed


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]  # database_url/jwt_secret from env/.env
