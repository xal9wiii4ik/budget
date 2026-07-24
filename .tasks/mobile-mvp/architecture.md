# Architecture Plan: mobile-mvp (1.8) — reuse-boundary memo

## Context

Mobile MVP is the second consumer of every client-side discipline web proved in
1.5–1.6. Per-module ruling: what physically moves to a package vs what mobile
re-implements as a copied pattern. Grounded in the files at HEAD (all read, not
assumed): `apps/web/src/lib/{patch,errors,query}.ts`,
`apps/web/src/data/{queryKeys,categories,transactions}.ts`,
`packages/shared/src/{schemas,index}.ts`, `packages/api-client/src/{index,auth,client}.ts`,
`apps/web/src/features/categories/CategoryFormModal.tsx`, both package.json files.

Current dependency edges (verified): `shared` → zod only; `api-client` →
openapi-fetch only; **no edge exists between shared and api-client in either
direction**; web → {shared, api-client}; mobile → shared (adds api-client this
task).

**Decision principle used throughout** (this is the rule Q5 asks for):

- **Wire-facing discipline** (what goes on the wire / how the server's envelope is
  read) → promote, because drift is server-visible and cross-client: both apps hit
  the same backend. Home: `@budget/api-client`.
- **Domain/value logic** (money, dates, form schemas, validation patterns) → home:
  `@budget/shared`.
- **App-local shape** (cache keys, QueryClient policy, user-facing copy,
  navigation) → APP-OWNED copy-with-conformance, because web and mobile run
  separate QueryClient caches and separate UIs; there is no runtime artifact that
  can drift between them — only the invariants bind, and the obligations checklist
  gates those.

## Verdict table

| Module | Verdict | Destination | New dependency edges | Web side executed by |
|---|---|---|---|---|
| `lib/patch.ts` (`buildCategoryPatch`, `buildTransactionPatch`, `emptyToNull`) + `patch.test.ts` | **PROMOTE** | `@budget/api-client` (`src/patch.ts`) | `api-client → shared` (type-only) | frontend-engineer: delete `apps/web/src/lib/patch.ts`, re-point imports |
| `""` empty sentinel | **Shared-schema convention** — mobile MUST reproduce it | already in `@budget/shared` form-value types | none | n/a |
| `data/queryKeys.ts` (`qk`, `TxListFilters`) | **COPY-with-conformance** | `apps/mobile` (app-owned) | none | none |
| `lib/errors.ts`: `getValidationIssues`, `locTailField`, `routeIssue`, `ValidationIssue`, `FieldError<F>` | **PROMOTE** | `@budget/api-client` (next to `getErrorCode`) | covered by the same edge above | frontend-engineer: re-point imports |
| `lib/errors.ts`: `describe*Error`, copy tables, field lists | **APP-OWNED** (O7) | each app | none | none (imports only) |
| `lib/query.ts`: `ApiError`, `throwOnError` | **PROMOTE** | `@budget/api-client` | none new | frontend-engineer: re-export from `lib/query.ts` (zero call-site churn) |
| `lib/query.ts`: `queryClient` config (staleTime/retry policy) | **APP-OWNED** | each app | none | none |
| `HEX_COLOR_PATTERN` | **PROMOTE** (AM-hex confirmed) | export from `@budget/shared` (`schemas.ts:75` → barrel) | none (already lives there) | frontend-engineer: delete local copy `CategoryFormModal.tsx:36`, import from shared |
| `data/categories.ts`, `data/transactions.ts` hooks + invalidation logic | **APP-OWNED**, copy the pattern | `apps/mobile` | none | none |

**FLAGGED OPEN QUESTION (PM/senior-lead, do not treat as settled):** the two
PROMOTE-to-api-client verdicts collide with S1's literal wording
("`packages/api-client` byte-identical"). See Q1 reasoning. Everything else in
this memo stands regardless of the answer.

## Q1 — patch.ts

**Verdict: PROMOTE to `@budget/api-client` as `src/patch.ts`, with the new
`api-client → shared` type-only edge. Reject shared as destination. Reject copy.**

Why promote at all: W1 is a *contract* discipline — omit-vs-null drift between the
clients is server-visible (a mobile copy that sends `""` instead of `null` corrupts
stored data for both clients). This is exactly the case where physical sharing pays
and copy-with-conformance is the weaker gate. The module is verified platform-free:
its only imports are `type components` from api-client and
`type {CategoryFormValues, TransactionFormValues}` from shared.

Why api-client and not shared:

- `shared → api-client` (even type-only) inverts the workspace's base layer.
  shared is currently dependency-free (zod only) and wire-free — `schemas.ts`
  carries an explicit boundary comment ("imports ONLY zod + shared's own money
  helpers"). Coupling shared to the generated wire types means every schema regen
  ripples into the base package and opens the door to a future cycle. Rejected.
- `api-client → shared` is the natural direction: api-client is already "generated
  client + hand-written wire-discipline helpers" (login's form-encoding,
  `getErrorCode`). The patch builders are the same species — form values → wire
  bodies, returning api-client's own `CategoryUpdate`/`TransactionUpdate`. The new
  edge is `import type` only (erased at runtime; `@budget/shared` added to
  api-client's package.json; no cycle possible because shared imports no workspace
  package by rule). Senior-lead greps for non-`type` imports at diff review, same
  as the existing web-globals grep on auth.ts.

`patch.test.ts` relocates with the module (existing tests move; no new ones needed).

**The `""` sentinel is a shared-schema convention, not a web/RHF artifact.** The
shared form-value types themselves declare optional strings as non-nullable
`string` (`CategoryFormValues.icon/color`, `category_id`/`note`) and `schemas.ts`
validates `color` with the `v === ''` escape. Since AM-schemas obliges mobile to
use these exact schemas, `""` is the empty representation mobile gets whether or
not it uses react-hook-form (RN `TextInput` holds `""` naturally anyway). Mobile
MUST reproduce it; `emptyToNull` remains the single `""`→`null` wire bridge for
create bodies on both clients.

**S1 collision (the flagged open question):** S1 reads "`packages/api-client`
byte-identical." This promotion leaves `src/generated/**`, the schema, and every
existing export byte-identical, but adds `src/patch.ts` (+ Q3's error module) and
barrel lines. My ruling is that S1's intent is contract-untouched, and its wording
should be amended to "`src/generated/**` byte-identical; existing export surface
unchanged; no schema regeneration; `apps/api` untouched." If senior-lead holds the
literal line instead: the fallback is COPY-with-conformance for these modules in
1.8 and a follow-up promotion task — do NOT put them in shared and do NOT create a
new package to dodge the gate (that would be structure driven by process, and O1's
spirit argues against a package invented to route around a review rule).

## Q2 — queryKeys.ts

**Verdict: COPY-with-conformance, app-owned in `apps/mobile`.**

The decisive fact: web and mobile run separate QueryClient instances in separate
runtimes. There is no shared cache, so key-shape drift between the two apps cannot
break anything *cross-client* at runtime — unlike patch.ts, nothing here reaches
the wire. What binds both clients is the invariants (AM-1.6-a: offset is pageParam
not key member; AM-1.6-b: single archived-inclusive categories cache; W8:
`key[1] !== 'summary'` list-only predicate), and those are enforced per-app by the
Phase-4 obligations checklist — the right gate for a 25-line table. A unit test
that re-asserts the key literals would be vacuous; the checklist review is the
conformance mechanism.

Physical sharing also has no good home: shared would need the api-client
`TransactionKind` type (the rejected inversion), and api-client is the wire layer,
not the cache layer. Mobile copies `qk` + `TxListFilters` verbatim into its data
layer, with AM-1.6-a/b cited in `plan-mobile.md`.

## Q3 — errors.ts split and the error carrier

**Verdict: split exactly along the wire boundary.**

- **PROMOTE** `getValidationIssues`, `locTailField`, `routeIssue` (currently
  private — export it), plus the `ValidationIssue` and `FieldError<F>` types, into
  `@budget/api-client` next to `getErrorCode`. They narrow the same FastAPI
  envelope `getErrorCode` already narrows (W2 is a contract fact); they are
  verified platform-free and generic. Same S1 caveat/fallback as Q1.
- **APP-OWNED** per O7: `describeCategoryError`/`describeTransactionError`, the
  code→copy tables, `NETWORK_MESSAGE`/`GENERIC_MESSAGE`, and the field lists.
  Mobile writes its own, and per O7 its network-failure arm plus a visible
  retryable affordance are mandatory, not optional polish.
- **Error carrier: PROMOTE `ApiError` + `throwOnError` to `@budget/api-client`.**
  This is the clean answer to the coupling question. Both are platform-free, and
  they encode a property of api-client's own library choice (openapi-fetch
  resolves instead of throwing on HTTP errors) — that knowledge belongs beside the
  client, not re-derived per app. With the carrier shared, mobile's `describe*`
  copies check `instanceof ApiError` against the same class the web ones do, and
  the "minimal shared error-carrier type" question dissolves. Web-side move is
  cheap: `lib/query.ts` keeps `export { ApiError, throwOnError } from
  '@budget/api-client'` so no call site changes (a single module instance in the
  workspace keeps `instanceof` sound across the re-export); direct-import cleanup
  is frontend-engineer's discretion. The `queryClient` construction and its
  staleTime/retry policy stay app-owned — mobile sets its own (likely
  network-tolerant, per O7's flaky-network stance). Note for mobile-engineer:
  web's `useDeleteTransaction` shows the 204 case where `throwOnError` cannot be
  used (data is legitimately `undefined`) — copy that unwrap pattern, it does not
  promote.

`errors.test.ts` splits with the code: envelope-narrow tests move to api-client,
copy-table tests stay in web.

## Q4 — AM-hex

**Confirmed, no challenge.** The second consumer is real: mobile's category form
needs the same live-preview guard (an in-progress value must not reach the swatch
style before submit-time validation — the identical hazard exists with RN's
`backgroundColor`). Execution: add `HEX_COLOR_PATTERN` to the export list in
`packages/shared/src/schemas.ts` (it is already defined at line 75) and to the
barrel `packages/shared/src/index.ts`; frontend-engineer deletes the local copy at
`apps/web/src/features/categories/CategoryFormModal.tsx:36` and imports from
`@budget/shared` in the same task. No new dependency edges (web already depends on
shared). Both this and the patch/errors moves land under S3's regression gate
(web's suite green).

## Q5 — sanctioned edge set after this task

```
zod ──▶ @budget/shared ◀── (type-only) @budget/api-client ◀── openapi-fetch
              ▲                        ▲
              │                        │
        apps/web ──────────────────────┤
        apps/mobile ───────────────────┘
```

Rules, so future promotions have a rule instead of a debate:

1. `@budget/shared` imports nothing from the workspace. Ever. It is the base
   layer: platform-free AND wire-free.
2. `@budget/api-client` may import `@budget/shared` **type-only** (`import type`;
   grepped at review). It never imports apps. `src/generated/**` is machine-owned.
3. Apps import both packages. Apps never import each other. Packages never import
   apps.
4. No new packages unless two real consumers exist at creation time (S5). None is
   created in this task; O1 stands — the auth coordinator is copy-the-pattern into
   `apps/mobile/src/auth/`, reusing only `login/refresh/logout/register`,
   `getErrorCode`, and the shared form schemas.
5. Placement rule for future promotions: wire-facing discipline → api-client;
   domain/value logic → shared; cache-shape/copy/navigation → app-owned.

## Q6 — data/{categories,transactions}.ts

**Verdict: APP-OWNED; copy the pattern, promote nothing.**

Every hook imports the app-owned `apiClient` singleton (`../lib/api`, wrapping the
app's authFetch — which O1 mandates each app builds itself) and binds to the app's
QueryClient. Promoting them would require injecting the client and query-client —
exactly the compatibility layer the standard forbids. The valuable content is the
*pattern*, which the file comments already document: single archived-inclusive
categories cache updated in-place from mutation responses (AM-1.6-b), infinite
list with derived `has_more` (W6/AM-1.6-a), list-vs-summary invalidation split
with the both-months date-move case (W8), and 404-triggered list refetch. Mobile
re-implements these against the promoted `ApiError`/`throwOnError` and its copied
`qk`. `affectedMonth` (a 2-line `slice(0, 7)`) is copied, not promoted.

## What this does NOT decide

- Mobile's form library (RHF vs controlled state) — only that form values conform
  to the shared schemas and their `""` convention.
- Mobile's QueryClient defaults (staleTime, retry, AppState-aware refetch).
- The authFetch/coordinator internals (governed by O1–O6, not this memo).
- Test-runner story (S4), jest-expo vs vitest split — mobile-engineer decides in
  plan-mobile.md; only note here: the promoted modules stay vitest-tested inside
  their packages, unaffected by mobile's runner choice.
- Exact barrel ordering / file naming inside api-client for the promoted modules.
