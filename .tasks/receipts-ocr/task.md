# Scope: receipts-ocr (roadmap 2.1–2.5) — SCOPE GROOMING (first run of scope mode)

Photo → parsed receipt → confirmed transaction, plus merchant autocategorization.

## Binding constraints from the PM (direction-review session, 2026-07-26)

- **Localhost-only, nothing in the cloud**: storage = local MinIO service added to
  the existing root docker-compose.yml (NOT Cloudflare R2; keep the S3-compatible
  presigned-URL design from the architecture doc so a later swap to R2 is
  config-only). The only external call allowed is the Anthropic API for parsing
  (key via env; rate-limit per architecture §3).
- **Hybrid input model**: user enters large expenses manually (exists), everything
  else via photo/screenshot upload. Web-first: upload via input/drag-and-drop on
  the web (архитектура: тот же механизм для скриншотов банковских пушей).
  **MOBILE IS FROZEN — no apps/mobile work in this scope** (2.4 deferred).
- **Scope grooming output** per grooming-workflow SKILL.md "Scope grooming mode":
  architecture.md (whole scope), plan.md + plan-web.md with an ORDERED SUBTASK
  BREAKDOWN (each subtask one-engineer-run sized, with dependencies),
  qa-checklist.md (scope QA strategy mapped to subtasks), grooming-review.md
  (Phase 4 + review-tier tag per subtask).
- **Review tiers** (PM expectation, senior-lead confirms/tags): receipts API +
  storage + Claude parse pipeline = FULL (external integrations, new
  tables/migration); web upload/confirm UI = STANDARD; merchant_category_map =
  senior-lead's call. Tag each subtask explicitly.

## Scope content (architecture doc: "Добавление траты по фото чека" + "Категории")

- `receipts` table + migration (status pending/parsed/failed, storage_path,
  parsed_json, error).
- POST /receipts → presigned upload URL (private MinIO bucket,
  `{user_id}/{uuid}.jpg`, short TTL); direct client upload (file never passes
  through API workers).
- POST /receipts/{id}/parse → BackgroundTask → download → Claude API (strict
  JSON: total, currency, merchant, date, items[], suggested_category_id chosen
  from the user's category list incl. the 18 frozen system UUIDs) → Pydantic
  validation → parsed/failed (+ error reason).
- GET /receipts/{id} polling.
- Web: dropzone/input upload + poll + prefilled transaction confirm form —
  NO silent auto-create, подтверждение обязательно. Client-side image downscale
  (~1500px long side) on web before upload.
- `merchant_category_map` table + auto-suggestion learned from confirmed
  transactions; manual-override-wins precedence.
- Rate limit on the parse endpoint (slowapi already in the project).
- Contract regeneration (openapi.json + schema.d.ts, committed together)
  whenever the API changes.

## Team

architect (new tables, storage service boundary, Claude service in services/ —
first real service-layer code), backend-engineer, frontend-engineer (plan-web +
contract review folded into planning), qa-engineer (scope QA strategy; decide
the Claude-dependency test strategy honestly: record/replay vs tiny real call
vs mock at the service seam). web-qa checklist deferred to UI-subtask
implementation. mobile-engineer / mobile-qa NOT invoked (mobile frozen).

## Carry-forwards in force (read by this grooming)

- 1.2 (core-data-model §7): 2.1 must add `transactions.receipt_id Uuid NULL` +
  FK `ondelete=SET NULL` **in the same migration that creates `receipts`**.
  Seed category UUIDs are frozen and stable — 2.2/2.5 may cache them; the 18
  system UUIDs go into the OCR prompt category list.
- 1.4 (transactions-api §7): future trigger `GET /transactions/{id}` — add
  when 2.2's confirm flow needs an out-of-cache single row; `/summary` MUST
  stay declared before it. Second profile-reading consumer extracts
  `_get_or_create_profile` out of routers/transactions.py. 2.5/4.1: revisit
  `transactions.category_id` index if EXPLAIN shows it.
- 0.4 (shared-package-core): `toInputString` was built for the 2.3 OCR-total
  prefill; unknown-currency → exponent 2 chosen deliberately for OCR
  robustness.
- 0.3: SSE/streaming escape hatch in the generated client is a stage-4
  concern — NOT needed here; polling only.
- Process: contract artifacts (openapi.json + schema.d.ts) regenerate and
  commit together; root-file ownership (docker-compose.yml, turbo.json) =
  backend-engineer.
