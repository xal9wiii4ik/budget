# Implementation Plan (web): 1.8 module promotions (web/packages side only)

Scope: execute the web + package moves the architect ruled (PROMOTE verdicts + AM-hex)
so mobile can reuse the wire-facing discipline. NO mobile work, NO web feature work.
All moves are behavior-preserving refactors gated by S3.

## Approach

Four physical moves, all additive to `@budget/api-client` / `@budget/shared`, all
re-pointing web call sites. The api-client work is bounded by S1 (amended):
`src/generated/**` stays byte-identical, no regen, every EXISTING export unchanged;
only NEW hand-written modules + NEW barrel lines are added, and the new
`api-client → @budget/shared` edge is `import type` only. web's own error copy,
QueryClient policy, and cache logic stay app-owned (not in scope to move).

Two mechanical patterns keep call-site churn near zero:
- `lib/query.ts` becomes a re-export shim (`export { ApiError, throwOnError } from
  '@budget/api-client'`) so its ~10 importers do not change (architect's explicit ask).
- `lib/errors.ts` keeps `describe*Error` and re-points its internal helpers to the
  promoted ones; only the two form modals + `auth/errors.ts` change import specifiers.

## Files affected (exact)

### 1. patch.ts → `packages/api-client/src/patch.ts`
- Move `apps/web/src/lib/patch.ts` verbatim to `packages/api-client/src/patch.ts`
  (`buildCategoryPatch`, `buildTransactionPatch`, `emptyToNull`, private
  `clearableChange`). Its imports are already `import type { components } from
  '@budget/api-client'` (becomes `from './generated/schema'` for the local
  `components` type, matching how `auth.ts` references it) and `import type
  { CategoryFormValues, TransactionFormValues } from '@budget/shared'` — unchanged,
  now the sanctioned type-only edge.
- **DELETE** `apps/web/src/lib/patch.ts`.
- Re-point the 2 call sites, `../../lib/patch` → `@budget/api-client`:
  - `apps/web/src/features/transactions/TransactionFormModal.tsx:23`
  - `apps/web/src/features/categories/CategoryFormModal.tsx:11`
- Barrel: add to `packages/api-client/src/index.ts`
  `export { buildCategoryPatch, buildTransactionPatch, emptyToNull } from "./patch";`

**patch.test.ts relocation (concrete):** move `apps/web/src/lib/patch.test.ts` →
`packages/api-client/src/patch.test.ts` (imports become `from './patch'`; the
`type ...FormValues from '@budget/shared'` import is unchanged). api-client's runner
today is `vitest run --typecheck` (see `src/drift.test.ts`, `src/contract.test-d.ts`);
a plain runtime `.test.ts` runs fine under that config alongside the type tests. It
executes as `@budget/api-client`'s `test` task in turbo — no vitest config change
needed. Resolving `@budget/shared` from within api-client requires the new dependency
(item 5). **DELETE** `apps/web/src/lib/patch.test.ts`.

### 2. errors.ts split
Promote to api-client (new file `packages/api-client/src/errors.ts`, platform-free
header copied from `auth.ts`): `getValidationIssues`, `locTailField`, **`routeIssue`
(newly exported — currently private)**, and the `ValidationIssue` + `FieldError<F>`
types. Verbatim move; no logic change.
- Barrel adds:
  `export { getValidationIssues, locTailField, routeIssue } from "./errors";`
  `export type { ValidationIssue, FieldError } from "./errors";`
- **STAYS in `apps/web/src/lib/errors.ts`** (O7, app-owned copy): `describeCategoryError`,
  `describeTransactionError`, `NETWORK_MESSAGE`/`GENERIC_MESSAGE`, `CategoryField`/
  `TransactionField` + the field lists. Delete the moved helpers/types from this file;
  import them instead: `import { getValidationIssues, routeIssue, type FieldError,
  type ValidationIssue } from '@budget/api-client'` (and `ApiError` continues from
  `./query`).
- Re-point `apps/web/src/auth/errors.ts:3` from `../lib/errors` →
  `@budget/api-client` for `getValidationIssues`, `locTailField` (it already imports
  `getErrorCode` from `@budget/api-client`, so this consolidates onto one specifier).

**errors.test.ts split (which case goes where):**
- To `packages/api-client/src/errors.test.ts`: the `describe('getValidationIssues —
  runtime narrow of the 422 body')` block (all 3 cases — string-code arm,
  ValidationError[] arm, object-detail arm). These test the promoted envelope narrow.
- Stays in `apps/web/src/lib/errors.test.ts`: the `describe('describeCategoryError')`
  and `describe('describeTransactionError')` blocks (name-conflict routing,
  CATEGORY_ARCHIVED routing, AMOUNT_REQUIRED fallback). These test app-owned copy
  routing and keep constructing `new ApiError(...)` (works via the re-export shim).

### 3. ApiError + throwOnError → api-client
- Move the `ApiError` class and `throwOnError` from `apps/web/src/lib/query.ts` into
  `packages/api-client/src/errors.ts` (same new file as item 2 — one cohesive,
  platform-free error module: result-unwrapping + envelope-narrowing). The local
  `FetchResult<T>` helper type moves with `throwOnError`.
- Barrel adds: `export { ApiError, throwOnError } from "./errors";`
- `apps/web/src/lib/query.ts` KEEPS `queryClient` (its `retry` closure still does
  `error instanceof ApiError`, now the imported class) and adds
  `export { ApiError, throwOnError } from '@budget/api-client';`. **Zero churn** for
  its importers: `main.tsx`, `auth/{errors,useMe,useAuthListener,useAuth,coordinator}.ts`,
  `data/{categories,transactions}.ts` all keep importing from `../lib/query`.

**instanceof-soundness (verified claim):** `@budget/api-client` is a single
`workspace:*` package resolved to one physical location; pnpm symlinks it once and
Vite dedupes the workspace module, so there is exactly one `ApiError` class identity
in the web build. Every `new ApiError(...)` (in `auth/coordinator.ts:185`,
`auth/useAuth.ts:46`, `data/transactions.ts:133`) and every `instanceof ApiError`
check (retry policy, `describe*Error`, `data/transactions.ts:116/146`,
`auth/errors.ts:24`) — whether reached directly or through the `lib/query` value
re-export — resolves to that same class object. `instanceof` stays sound.

### 4. AM-hex → export `HEX_COLOR_PATTERN` from `@budget/shared`
- `packages/shared/src/schemas.ts:75`: `const HEX_COLOR_PATTERN` →
  `export const HEX_COLOR_PATTERN` (already used at :97 by `categoryFormSchema`;
  no logic change).
- `packages/shared/src/index.ts`: add `HEX_COLOR_PATTERN` to the `./schemas` export
  block.
- `apps/web/src/features/categories/CategoryFormModal.tsx`: DELETE the local copy at
  L36; add `HEX_COLOR_PATTERN` to the existing `import { categoryFormSchema,
  type CategoryFormValues } from '@budget/shared'` (L2). Usage at L187 unchanged.
- No new dependency edge (web already depends on `@budget/shared`).

### 5. `packages/api-client/package.json` — new dependency
Add `"@budget/shared": "workspace:*"` to **`dependencies`** (not devDependencies).

Ruling on dep kind (asked to be precise): `patch.ts` imports `@budget/shared`
**type-only** — `emptyToNull`, `clearableChange`, and both builders reference NO
shared *value* at runtime (they touch only `''`, the passed form objects, and
api-client's own `components` types). So the runtime module graph has no
api-client→shared edge; the import is erased. Despite being runtime-erased, the
shared types appear in api-client's **public exported signatures**
(`buildCategoryPatch(values: CategoryFormValues, …)`), so they are part of the
consumer-facing type contract. That is the "types in public API" case → belongs in
`dependencies`, not `devDependencies`: a consumer resolving api-client's source must
be able to resolve `CategoryFormValues` transitively even if it installed prod deps
only. `workspace:*` means zero runtime weight regardless. (A devDependency would
technically satisfy api-client's own `tsc` since pnpm installs devDeps locally, but
it would misrepresent the contract and is the wrong call.)

### 6. api-client barrel (`src/index.ts`) — additive only
Existing lines (`createApiClient`, `ApiClient`, `paths`/`components`,
`login/refresh/logout/register/getErrorCode`, `TokenPair`/`UserRead`/`ErrorModel`,
`HealthResponse`) stay byte-for-byte. Append the three new export lines from items
1–3. New files only: `src/patch.ts`, `src/errors.ts`, `src/patch.test.ts`,
`src/errors.test.ts`. `src/generated/**`, `client.ts`, `auth.ts` untouched
(`getErrorCode` stays in `auth.ts`; barrel keeps exporting it from `./auth`).

## Data layer
No API endpoints, query keys, cache policy, or invalidation logic change. All moved
code is pure (patch builders, envelope narrowers, the `ApiError` carrier). `queryClient`
config stays web-app-owned in `lib/query.ts`.

## UI states
No UI change. No screen, no loading/empty/error state, no copy is touched. The two
form modals change only import specifiers; `describe*Error` copy tables and the
`CategoryFormModal` swatch guard behave identically (same regex, now imported).

## Zero-behavior-change assertion & proof
No web user-visible change: no component render output, no error copy, no validation,
no cache behavior is altered — only symbol homes and import paths. Proof = **S3
regression gate**: full turbo `typecheck` + `lint` + `test` green across
`@budget/api-client`, `@budget/shared`, and `@budget/web`. web-qa is NOT invoked;
the existing suites are the gate:
- api-client: `vitest run --typecheck` now also runs the moved `patch.test.ts` +
  the promoted-narrow cases in `errors.test.ts`.
- web: `vitest run` runs the retained `describe*Error` cases against the re-exported
  `ApiError`; TypeScript compiles every re-pointed import site.
Green across all three = the refactor preserved every tested behavior.

## Disagreements with the architect's verdicts
None blocking — I own the web side and the four moves are sound as ruled. Two calibrations:
- **`FieldError<F>` promotion:** its `field: F | 'form'` union carries a mild UI
  flavor (`'form'` = "surface at form root"), but `routeIssue` only ever returns a
  concrete field, and both apps' `describe*` reuse the same return shape — so it is
  generic enough. Agree; noting the `'form'` sentinel as the one app-ish edge, harmless.
- **patch.test.ts relocation friction:** minimal. api-client's `--typecheck` runner
  already mixes runtime and type tests, and the only new requirement is the
  `@budget/shared` dep (item 5), which we add anyway. No circular-import hazard: shared
  imports nothing from the workspace (Q5 rule 1), the new edge is type-only and
  runtime-erased, so no cycle exists in either the type or runtime graph.

## Open questions
None blocking. The S1 literal-wording collision the architect flagged is already
resolved by senior-lead's amended S1 (additive hand-written modules allowed;
`src/generated/**` byte-identical; type-only edge grepped) — no PM action needed.
File naming inside api-client (`src/patch.ts`, single `src/errors.ts` for
carrier + narrow) was left to me by the architect ("exact barrel ordering / file
naming … not decided"); recommendation is above, flag if senior-lead prefers
splitting the carrier and the narrow into separate files.

## Risks
- **Re-export shim correctness:** `lib/query.ts` must `export { ApiError, throwOnError
  }` as *values* (not `export type`) since call sites do `new ApiError` and
  `throwOnError(...)`. Verify at diff review.
- **Type-only edge discipline:** the `api-client → @budget/shared` import in
  `patch.ts` must stay `import type`; senior-lead greps for non-`type` imports at
  review (same gate as the `auth.ts` web-globals grep).
- **Test resolution:** confirm `@budget/shared` resolves inside api-client's vitest
  after adding the dep (pnpm install to materialize the symlink); the S3 turbo test
  run is the check.
- **Missed import site:** grep confirms the only movers are the 2 form modals
  (patch), `auth/errors.ts` + `lib/errors.ts` (narrow helpers), and the CategoryFormModal
  hex copy; every `ApiError`/`throwOnError`/`queryClient` importer stays on
  `../lib/query` via the shim. A repeat grep after edits is the backstop.
