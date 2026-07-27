# Code Review: receipts-ocr backend arc (S1 ecf6b85 + S2 89b5b6d + S3 working tree)

Combined FULL-tier review (PM token policy — one pass over the whole arc).
Reviewer: code-reviewer. Mode: full review. Loaded rules from: ~/.claude/CLAUDE.md
(tests policy), .claude/skills/code-review skill, .tasks/receipts-ocr/
{architecture.md, plan.md, grooming-review.md}.

Intent: architecture D1–D14 + plan S1–S3 + amendments AM-1..AM-4 + verifications
V1/V2 as recorded in grooming-review.md.

## Independent verification performed (not just read)

- `uv run pytest` — full suite: **94 passed** (receipts files: 29).
- `alembic upgrade head` → `alembic check` — **"No new upgrade operations
  detected"** (models ↔ migration 0004 byte-identical, incl. the status CHECK
  and all convention-generated names).
- `alembic downgrade 0003` → `upgrade head` — downgrade symmetry round-trips
  clean.
- `domain/money.py` exponent table diffed entry-by-entry against
  `packages/shared/src/currencies.ts` — **exact twin** (16 exponent-0, 7
  exponent-3, default 2), and I traced `"12."` and `".5"` through the AM-2 regex
  and `Decimal` (admitted, converted correctly: 1200 / 50 minor at exp 2).
- `openapi.json` response maps checked: POST /receipts {201,429}; GET
  {200,404,422-auto}; parse {202,404,409,422-anyOf-union,429,503}. Parse 422 is
  the honest anyOf[ReceiptError, HTTPValidationError] (V2 satisfied); GET keeps
  the bare auto arm. `PresignedUpload.headers` → `additionalProperties:
  {type: string}` (R7a satisfied); `ParsedReceiptRead.date` → `format: date`
  (R7b satisfied). `schema.d.ts` mirrors all of it (`SuggestionSource:
  "merchant_map" | "model"`, `parsed: ParsedReceiptRead | null`).
- Auth sweep: every receipts query is user-scoped (`_load_own_receipt`, the
  claim UPDATE predicate, the loser-path scalar re-read, the map lookup, and
  `_load_visible_options` via visible-clause + AM-4 archived filter). The
  guarded `_finish_*` UPDATEs are not user-scoped but only ever receive an id
  that came out of a user-scoped claim. No leak path found; no-oracle 404
  byte-identity tested.
- Services purity: `storage.py` imports config+minio only;
  `receipt_parser.py` imports config+schemas only — D13 holds.
- Rate limiting: `_rl_stash_user` (dependency) resolves before slowapi's
  wrapper, which runs before the handler body — key ordering correct; slowapi
  scopes counters per route function, so create/parse sharing the
  `{scope}:receipt:{uid}` prefix do NOT share counters; per-user key proven by
  the two-user 429 test.

## Findings

**MAJOR: none found.** The migration, claim/token concurrency, money path,
auth scoping, and contract artifacts all check out against the spec and against
live verification.

### 1. MINOR — `receipt_max_bytes` default (10 MiB) exceeds Anthropic's 5 MB per-image API limit
`apps/api/src/budget_api/config.py:68`

The parse-time HEAD gate admits images up to 10 MiB, but the Anthropic API
rejects images over ~5 MB per image. A 6 MB upload therefore passes the
in-request 422 gate, claims the row, spends the pipeline, and lands as
`failed / ANTHROPIC_ERROR` — a **permanent** condition mislabeled as a
transient one, and the client's R5 retry mapping ("ANTHROPIC_ERROR → just
re-POST /parse") sends the user into a guaranteed-failure retry loop instead of
the "restart from downscale" path that `IMAGE_TOO_LARGE` triggers. The S5
canvas downscale makes this rare in the happy flow, but the whole point of the
HEAD size gate (D5) was an immediate, actionable error. Fix: lower the default
to 5 MB (`5 * 1024 * 1024`) so the honest 422 fires first; keep the knob.

### 2. MINOR — MinIO-down HEAD probe is an unhandled 500 on the parse route
`apps/api/src/budget_api/routers/receipts.py:222-224, 281`

`_head_object` opens a plain `httpx.AsyncClient()` (implicit 5 s default
timeout — fine, but undocumented) and `parse_receipt` handles only
`status_code == 404`. If MinIO is not running — a routine operational state in
a compose-based dev setup — `httpx.ConnectError` propagates out of the handler
as a raw, undeclared 500 on the arc's money endpoint, in a codebase that is
otherwise strict about honest error taxonomy. Fix: wrap the HEAD in
`try/except httpx.HTTPError` and return a clean 503 (e.g.
`STORAGE_UNAVAILABLE`, declared in `responses=`), and pass an explicit
`timeout=` so the probe's budget is visible. (The background GET already
handles this class correctly via `DOWNLOAD_FAILED`.)

### 3. MINOR — last-resort guard reuses a possibly-dirty session without rollback
`apps/api/src/budget_api/routers/receipts.py:507-518`

The outer `except Exception` calls `_finish_failed` on the same session. If the
original exception left the session in a failed transaction (DB error in
`_load_visible_options`/`_resolve_suggestion`, or a failure inside
`_finish_parsed` itself), that write raises `PendingRollbackError` immediately,
is swallowed by the inner except, and the receipt stays `processing` — the
docstring's "never sticks in processing" claim breaks in exactly this path.
Stale takeover self-heals it, but only after `receipt_parse_stale_seconds`
(300 s), during which every retry is `409 RECEIPT_PROCESSING` (web gives up its
poll at 60 s). Fix: `await session.rollback()` (itself guarded) before the
last-resort `_finish_failed`.

### 4. MINOR — the stale-takeover *claim* branch of the UPDATE predicate is untested
`apps/api/tests/test_receipts.py` (gap), predicate at
`apps/api/src/budget_api/routers/receipts.py:294-308`

`test_stale_takeover_loser_update_drops` covers the guarded terminal UPDATE
(the loser's write dropping), but nothing exercises the claim predicate's
`processing AND parse_started_at < now() - stale_interval` arm — the SQL-side
interval arithmetic and comparison direction. If that comparison were inverted
or the interval binding wrong, either a crashed worker's row could never be
reclaimed (permanent 409 for the user) or a live parse could be double-claimed,
and the suite would stay green. This is a genuinely breakable, uncovered path
(passes the project's no-vacuous-tests bar): seed a `processing` receipt with
`parse_started_at` older than the cutoff via `db_session`, POST /parse, assert
202 and a terminal state.

### 5. NIT — catch-all writes `ANTHROPIC_ERROR` regardless of origin
`apps/api/src/budget_api/routers/receipts.py:507-513`

The plan says the last-resort guard records the failure "per origin", but a DB
error loading categories, a `presign_get` failure, or a bug in suggestion
resolution all land as `ANTHROPIC_ERROR`. Taxonomy is fixed (D10) so this is
tolerable, but the code label is misleading for debugging. Take or leave: log
line already carries the traceback; a comment acknowledging the mislabel (or a
future `INTERNAL` code, recorded) would do.

### 6. NIT — non-404 HEAD failures fall through the size gate
`apps/api/src/budget_api/routers/receipts.py:282-289`

A HEAD returning 403/500 (expired presign edge, storage error) is neither the
404 branch nor guaranteed to carry `content-length`, so `int(get(..., "0"))`
passes and the row is claimed; the failure only surfaces later as
`DOWNLOAD_FAILED`. Coherent but degraded; an explicit `not
head.is_success` branch would keep the request-time contract crisp. (Also:
`int()` on a malformed content-length would 500 — unreachable with MinIO.)

### 7. NIT — pre-check failures burn the 100/day parse budget
`apps/api/src/budget_api/routers/receipts.py:246-262`

slowapi counts the hit before the handler runs, so 503/404/409/422 responses
consume `receipt_parse_rate_limit` — the "AI spend" cap ticks without any AI
spend. Harmless at localhost scale (and 409-retry storms are exactly what the
burst window should cap), but worth recording so nobody treats "100/day" as
"100 Claude calls/day".

### 8. NIT — record the decode invariant for `total_minor` + null currency (S6 obligation)
`apps/api/src/budget_api/schemas/receipt.py:108-114`

`total_minor` is scaled by the exponent of the **returned** `currency` field,
with null/unknown → 2. `toInputString(minor, currency)` types `currency` as
non-null `string`, so S6 will be forced to substitute something when
`parsed.currency` is null — and the natural `?? baseCurrency` reintroduces the
100× footgun for an exponent-0 base currency (server encoded at 2, client
decodes at 0). One doc line on `ParsedReceiptRead` ("clients must decode with
the same null→2 rule, never the base currency's exponent") pins it before S6 is
written. See the referred-item verdict below.

## Verdict: APPROVE-WITH-FIXES

Zero MAJOR findings. This is a disciplined implementation of a well-groomed
spec: migration 0004 is byte-verified against the models by a clean `alembic
check` and a symmetric downgrade round-trip; the claim/token concurrency design
(atomic UPDATE...RETURNING claim, token-guarded terminal writes, loser-path
scalar reclassify) is correctly implemented and non-vacuously tested; every
query path is user-scoped with no-oracle 404s; AM-1..AM-4 are all genuinely
folded (live exponent table matching the shared twin exactly, real-seam AM-2
validator test, archived-filter with the contrast test QA demanded); and the
declared contract matches both the code and the regenerated artifacts,
including the honest anyOf-422. The four MINORs are edge-hardening around the
external seams (a config default that contradicts the Anthropic image limit,
one unhandled storage-down 500, one missing rollback in the last-resort guard,
one untested claim branch) — none blocks the arc's core correctness, all are
small and localized; senior decides whether they land with the S3 commit or as
an immediate follow-up. NITs are take-or-leave records.

## Referred item: `ParsedReceipt._normalize_currency` coercion — verdict: SOUND

Coercing a present-but-malformed currency to None (after strip+upper) is the
right call, for a load-bearing reason the referral asks about directly: **the
coercion cannot change the minor-unit scale asymmetrically.** The post-coercion
value is what gets stored in `parsed_json` and returned on the wire, and the
same value drives both sides of the conversion — server `to_minor_units`
(unknown/None → exponent 2) and client `getCurrencyExponent` (unknown → 2). A
coerced None yields exponent 2 on both layers, so the rendered major string
always equals the printed total; there is no path where "US$"/"usd "/garbage
silently changes the scale the web renders. Note the trap cases mostly dissolve
before the regex: "usd " and "jpy " are *repaired* by strip+upper, not nulled.
The genuinely dangerous input — a well-formed-but-wrong code like "YEN" — sails
through `^[A-Z]{3}$` regardless of posture, and the exceptions-only table
handles it identically on both layers (default 2), so failing validation
instead of coercing would not protect against it either. The alternative
(reject → `INVALID_MODEL_OUTPUT`) would fail the entire parse — total,
merchant, date, items — over a cosmetic field, which inverts the tolerant-OCR
posture for zero safety gain. Residual risks, both accepted/recorded: a nulled
currency suppresses S6's mismatch warning (R4's accepted posture — the field is
editable), and the only way to reintroduce a 100× footgun is a *client*
decoding null currency with the base currency's exponent — pinned as NIT 8 so
S6 cannot do it accidentally. Sound as implemented; keep it.
