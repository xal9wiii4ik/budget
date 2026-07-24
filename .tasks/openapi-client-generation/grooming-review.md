# Grooming Review (Phase 4) — openapi-client-generation

Senior-lead critical review of architecture.md (D1–D6), plan.md (backend B1–B5,
9 steps), plan-web.md (frontend F1–F6), qa-checklist.md (15 checks). Verdict:
**accepted with the amendments below.** No artifact goes back for rewrite;
amendments are binding on the implementers.

## 1. Team selection (recorded)

architect (cross-package contract, pipeline decisions that outlive the task) +
backend-engineer (export module, committed schema, python drift test, ALL root
files per the 0.1 §1.1 ownership rule) + frontend-engineer (packages/api-client:
generation wrapper, generated types, typed client, first real tests) +
qa-engineer narrow-scope (the drift/contract tests are the *permanent* gate but
cannot verify themselves — QA's checklist is dominated by negative tests proving
the gates actually go red). web-qa / mobile-qa / mobile-engineer NOT invoked: no
user-visible client change, apps consume the client only at 1.5/1.8.

## 2. Seam cross-check (the two plans against each other)

1. **Exact-bytes contract (B1 serializer ↔ F2 reader/regenerator).** Consistent:
   backend's `openapi_json()` (sort_keys, indent=2, ensure_ascii=False, trailing
   newline, explicit UTF-8) is the single byte source for `apps/api/openapi.json`;
   frontend's `generateSchema()` is the single byte source for `schema.d.ts`, and
   each side's drift test imports the *same* function its writer uses. Neither
   side re-serializes the other's artifact — F2 consumes the schema via
   `openapiTS(file URL)`, byte-format of the JSON is irrelevant to edge 2.
   Verified: F2's `../../../apps/api/openapi.json` relative path is correct
   (scripts → api-client → packages → root).
2. **Turbo graph.** `@budget/api#openapi` (outputs `openapi.json`) ←
   `@budget/api-client#generate` via `pkg#task` dependsOn, `$TURBO_ROOT$` input;
   explicit `@budget/api-client#test` inputs; `openapi.json` added to
   `@budget/api#test` inputs. Consistent between plans; root
   `"openapi": "turbo run generate"` resolves. Crucially,
   `@budget/api-client#test` has NO dependsOn on api tasks — the client's gate
   stays Python-free (QA TC verifies no api task enters that graph).
   One cache-honesty hole existed (frontend's F6 `vitest.config.ts` was absent
   from backend's test inputs) — **dissolved by AM1**, which removes the file.
3. **Sequencing gate.** Both plans state it identically: backend lands fully
   first (including the committed `openapi.json`); frontend blocks and reports
   if the schema is absent (never fabricates one); an empty `turbo run generate`
   before the frontend slice is NOT a defect (→ AM7).
4. **eslint seam.** Backend's node-globals block (`packages/*/scripts/**/*.mjs`)
   does not match frontend's new `scripts/generate.d.mts` — ruled in AM4: no
   widening needed (see below).

## 3. Amendments (binding)

- **AM1 — contract test renamed `src/contract.test-d.ts`; F6 `vitest.config.ts`
  DROPPED.** Overrules frontend's Open Q1 recommendation (they preferred keeping
  the architect's `contract.test.ts` name + a config file). Reasons: (a) the
  `.test-d.ts` suffix is the vitest-native marker for type tests — vitest's
  default `--typecheck` glob collects it and the default runtime glob collects
  `drift.test.ts`, so zero config is needed; (b) dropping the config file closes
  the turbo cache-honesty hole (it was missing from `@budget/api-client#test`
  inputs); (c) architecture §"What this does NOT decide" explicitly grants test
  idiom latitude — the F-list filename was inventory, not contract.
  **Attached verification obligation (QA gap 2):** nothing yet *proves* the
  default glob collects `contract.test-d.ts`. Frontend acceptance criterion 7
  (flip an assertion → test run must FAIL) and QA TC-A9 falsify this; if the
  default glob does NOT collect it, the recorded contingency is reinstating the
  minimal `vitest.config.ts` AND backend adding `"vitest.config.ts"` to
  `@budget/api-client#test` inputs in the same commit. `tsc --noEmit` remains
  the independent fallback gate either way (the file is under `src/`).
- **AM2 — `build_export_app()` helper and `.dockerignore` exclusion accepted.**
  Backend's two "clarifications" are approved as stated: one canonical hermetic
  app builder shared by CLI and drift test strengthens D1; `openapi.json` is a
  build-time contract artifact with zero runtime role (the live server serves
  `/openapi.json` from `app.openapi()`), so it stays out of the image.
- **AM3 — backend rewords the stale README Layout line** (api-client described
  as "currently a shell; generated in task 0.3") in Step 8, to "OpenAPI-generated
  TS types + typed fetch client". Root-file ownership is exclusive; frontend
  cannot touch README. Resolves backend Open Q2 as recommended.
- **AM4 — no eslint glob widening for `generate.d.mts`.** Verified against the
  actual root config: `js.configs.recommended` + `tseslint.configs.recommended`
  have no rule that fires on a single ambient `export function` declaration, and
  node globals are irrelevant to a declaration-only file. Contingency: if any
  rule fires at implementation, backend (root owner) adds a targeted override —
  frontend must NOT add a package-local eslint config. Resolves frontend Open Q2.
- **AM5 — repo gate substitution confirmed.** No Makefile exists or is added in
  0.3; `pnpm turbo test --filter=@budget/api` (slice) / root `pnpm test` (whole
  repo) is the "make test" equivalent. Resolves backend Open Q1.
- **AM6 — two implementation nits in the F2 sketch (reviewer checkpoints at
  /implement, not plan rewrites):** (a) the script-mode detection
  `import.meta.url === \`file://${process.argv[1]}\`` is URL-encoding-fragile; use
  `import.meta.url === pathToFileURL(process.argv[1]).href` (`node:url`). A false
  negative would make `pnpm generate` silently no-op — drift tests would catch
  the staleness, but the command lying about having worked is unacceptable.
  (b) The sketch imports `readFileSync` unused — drop it (lint would flag it).
- **AM7 — sequencing codified:** backend slice merges first with the committed
  schema; between the slices, `turbo run generate` finding no `generate` script
  is expected, and the api-side export remains independently runnable via
  `pnpm --filter @budget/api openapi`.

## 4. Per-amendment / carry-forward checklist (Phase 4 obligation)

| Binding item | Source | In plan.md | In plan-web.md | In qa-checklist.md |
|---|---|---|---|---|
| Root-file ownership = backend (turbo.json, root package.json, eslint, README) | 0.1 §1.1 | ✓ Steps 5–8 (sole root editor) | ✓ writes none, deps listed §Cross-slice | ✓ TC-A14 README; lint TC |
| Scaffold-lifetime placeholder: `export {}` shell dies with first real content | 0.1 §1.3/§1.4 | ✓ explicitly disclaimed (frontend-owned) | ✓ F4 rewrites `src/index.ts`; F1 first-ever test script | ✓ placeholder-absorbed check |
| A5 — 503 visible to the generated client (the reason 0.3 has this shape) | 0.2 A5 | ✓ Step 3 acceptance (200+503 in committed schema) | ✓ F5 contract test = executable A5 | ✓ TC-A4 (schema), TC-A8 (type gate isolated from drift) |
| Explicit turbo inputs / cache honesty | 0.2 convention | ✓ Step 5 (incl. `$TURBO_ROOT$`, api#test gains openapi.json) | n/a (root files not theirs) | ✓ TC-A6/TC-A13 stale-green probes |
| pyright strict on src/, ruff scope | 0.2 | ✓ Step 1 + acceptance 6 | n/a | ✓ lint/typecheck TCs |
| Exact-version pins | 0.1 | n/a (no new node deps at root) | ✓ F1 (openapi-fetch, openapi-typescript, vitest 4.1.10) | ✓ no-range check |
| Per-amendment reporting at /implement | 0.1 retro / 0.2 §4 | ✓ table present; obligation restated | ✓ table present | ✓ coverage table present |
| AM1–AM7 (this review) | here | AM2/AM3/AM5/AM7 land in backend's steps | AM1/AM4/AM6/AM7 land in frontend's steps | ✓ checklist already written against amended state (AM1 etc.) |

Implementation reports at /implement MUST tick each row above individually,
plus AM1's verification obligation outcome (default-glob proof or the recorded
contingency) — that is the standing process fix from the 0.1 retro.

## 5. Risky spots — senior-lead's own verification

1. **Vacuous-gate risk is the task's center of gravity, and it is structurally
   handled:** shared writer/checker function on BOTH sides (python
   `openapi_json`/`build_export_app`; TS `generateSchema()`), both drift edges
   checked (edge-2-only was rejected as the classic always-green variant), and
   the type-level contract test covering the one failure drift cannot see
   (removing the A5 503 and dutifully regenerating). QA TC-A8/TC-A9 exist to
   falsify the gates themselves. Residual risk = AM1's default-glob assumption,
   with a named contingency.
2. **Determinism.** Backend's analysis is sound: no timestamps/UUIDs/env leakage
   in `app.openapi()` (no `servers`, no `root_path`, dummy DSN never appears);
   `sort_keys` neutralizes object-key order; semantic array order preserved.
   Byte changes require a FastAPI/Pydantic or openapi-typescript pin bump — a
   designed, drift-enforced regeneration event.
3. **Hermeticity.** Dummy `Settings(database_url=...)` passed as kwarg bypasses
   env/.env (sole field supplied) and `get_settings()` is never called; QA
   TC-A1 runs the export with `.env` moved away and Postgres stopped.
4. **QA's opposite-DB-state collision** (export check needs DB down; pytest
   suite needs DB up due to 0.2's conftest fail-fast) — real operational note,
   correctly sequenced inside the checklist; not a design defect.
5. **openapi-fetch on Metro** remains an accepted deferred risk (proven at 1.8);
   the package surface is small enough to swap runtimes while keeping `paths`.

## 6. QA scope note

qa-engineer invoked narrow-scope; 15 checks (TC-A1…TC-A15), no endpoint/curl
section (no endpoint behavior changed). The permanent gate after this task is
`pnpm test` (both drift edges + type contract); QA's one-time pass verifies
those gates bite. web-qa/mobile-qa not invoked. QA's minor cautions carried to
/test: turbo cache-miss output wording pinned against 2.10.6 at test time
(TC-A13), TC-A8's perturbation must assert its edit actually changed bytes,
AM3 verified by review not mechanically.

## 7. Open questions for the PM (veto-style; defaults apply if unanswered)

1. **Commit both generated artifacts (openapi.json + schema.d.ts) vs schema
   only.** **Recommendation: both** — Vercel/no-Python satisfied with zero build
   hooks, fresh clones typecheck without Python, reviewable contract diffs;
   drift tests neutralize staleness. (Architect Q1; both plans assume it.)
2. **openapi-fetch runtime vs types-only + hand-rolled wrapper.**
   **Recommendation: openapi-fetch** — ~6 kB, zero deps, same maintainers as the
   generator, middleware story for 1.1 JWT, RN-compatible; hand-rolling the
   path/query/body typing is where type lies creep in. (Architect Q2.)
3. **Schema home `apps/api/openapi.json` vs colocated in api-client.**
   **Recommendation: apps/api** — producer owns its artifact; turbo outputs must
   be package-local. (Architect Q3.)
4. **`info.version` truthful (churn on bumps) vs pinned constant.**
   **Recommendation: truthful** — one-line diffs; 0.2 TC-B5 already asserts the
   live schema carries `__version__`. (Architect Q4.)
5. **Drift checks inside existing `test` tasks vs dedicated `check:drift`.**
   **Recommendation: inside `test`** — one local gate, exactly what CI runs
   later. (Architect Q5.)
6. **AM1 (contract.test-d.ts, zero-config) — I overruled frontend's
   recommendation to keep `contract.test.ts` + `vitest.config.ts`.** PM may veto
   back to the config-file variant; if so, backend must add `vitest.config.ts`
   to `@budget/api-client#test` turbo inputs. **Recommendation: stand by AM1.**

No blocking questions. Defaults = recommendations; ready for /implement on
PM's go (backend slice first per AM7).
