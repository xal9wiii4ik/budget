# Grooming Review (Phase 4) — setup-monorepo-scaffold

Senior-lead critical review of architecture.md, plan.md (backend: root + api),
plan-web.md (web + packages), plan-mobile.md (Expo). Verdict: **plans accepted with
the resolutions below.** No plan is sent back for rewrite; the resolutions are binding
amendments the implementers follow.

## 1. Conflicts resolved

### 1.1 Root file ownership — single owner: backend-engineer

backend-engineer owns and creates ALL repo-root files, incorporating the other slices'
requests. Nobody else touches root files. Final root inventory and origin:

| File | Owner | Amendments folded in |
|---|---|---|
| `.gitignore`, `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.editorconfig`, `.nvmrc`, `.prettierrc.json`, `.prettierignore`, `README.md` | backend | — |
| `eslint.config.mjs` | backend | + web's override block (react-hooks, react-refresh); see 1.5 for the glob amendment |
| root devDeps | backend | + `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh` (requested by web) |
| **`.npmrc`** (`node-linker=hoisted`) | **backend** | requested by mobile; mobile correctly refused to create it unilaterally. Backend adds it in step 2 of plan.md, BEFORE any `pnpm install`. |

Trade-off accepted with `.npmrc node-linker=hoisted`: repo-wide flat `node_modules`
means pnpm's strict phantom-dependency isolation is lost for all workspaces. This is
the Expo-documented monorepo setting and the alternative (isolated linker +
`public-hoist-pattern` + metro `disableHierarchicalLookup`) is strictly messier.
Accepted; web's "declare every dep per workspace" discipline remains as convention
(and keeps us safe if we ever revert the linker).

Consequence I verified: workspace `lint` scripts rely on the root-installed eslint
binary via PATH walk-up — works under the hoisted layout; web's own risk note about
strict isolation is superseded by this linker decision.

### 1.2 packages/shared export contract — `PACKAGE_NAME` const, nothing else

Web plans `export const PACKAGE_NAME = '@budget/shared'`; mobile sketched an
unspecified pure `<helper>()`. **Resolution: the contract is exactly one export —
`PACKAGE_NAME`.** No throwaway helper function: it would be invented only to be
deleted in 0.4, and a const import proves module resolution/execution just as well.

Binding on mobile: `src/wiring.test.ts` imports `PACKAGE_NAME` from `@budget/shared`
and asserts `'@budget/shared'`; `app/index.tsx` renders it in the `<Text>`. Same
value as web's/shared's tests is fine — each test proves a *different workspace's*
resolution path (shared's own runner, Vite/web tsconfig, mobile tsconfig + workspace
link), not the value itself.

### 1.3 pytest smoke test vs pytest-conventions no-import-smoke-test rule — override STANDS

The convention bans import-smoke tests because in a codebase with real code they are
vacuous — something else already imports the module. At scaffold stage that premise
does not hold: this is the ONLY test, and it is the only thing that verifies the
uv + build-backend + src-layout + pytest chain end-to-end (plus pins `__version__`).
`passWithNoTests` semantics would leave that chain unverified — rejected by architect
and me for the same reason.

**Scaffold-lifetime rule (binding, applies to ALL placeholders):** every placeholder
smoke test (api `test_placeholder.py`, web `App.test.tsx`, shared `index.test.ts`,
mobile `wiring.test.ts`) is scaffold-lifetime only. The task that lands the first
real tests in a workspace (0.2 for api, 0.4 for shared, 1.x for web/mobile) MUST
delete or absorb that workspace's placeholder. This reconciles the override with the
convention: the smoke test exists exactly as long as it is non-redundant. Recorded
here so later groomings treat it as a required step, not an option.

### 1.4 api-client test script — web engineer wins over architecture.md

architecture.md §6 said "every workspace gets a placeholder test"; web's plan gives
`@budget/api-client` NO test file and NO `test` script (turbo includes only
workspaces that define the task). **Resolution: side with the web plan.** A test
against `export {}` can only be a tautology — exactly what the owner's policy
forbids. The shell's wiring is still verified by `lint` + `typecheck` (tsc proves
tsconfig + exports map). Accepted deviation from architecture.md, noted here;
real tests arrive with generation in 0.3.

### 1.5 react-hooks lint coverage for mobile (conflict the plans didn't see)

Mobile's plan assumes "the root flat config already provides TS + react/react-hooks
rules" — **false** as sketched: backend's baseline has no react plugins, and web's
override block is scoped to `apps/web/**` only. Mobile files would get plain TS lint
with no hooks rules, silently.

**Resolution:** in root `eslint.config.mjs`, the react-hooks block covers
`apps/{web,mobile}/**/*.{ts,tsx}`; the react-refresh rule stays in a web-only block
(`apps/web/**` — it is a Vite HMR concern, meaningless for Metro). Hooks-rule
violations are equally real bugs in React Native. `eslint-config-expo` remains
deferred to 1.8 per mobile's own recommendation — this amendment does not change that.

## 2. Gaps found (union of plans vs task scope)

Scope coverage check: git init ✓ (plan.md step 1) · root .gitignore ✓ · pnpm
workspaces + turbo ✓ · all five scaffolds ✓ (api in plan.md; web/shared/api-client in
plan-web.md; mobile in plan-mobile.md) · turbo pipelines lint/typecheck/test/dev ✓ ·
base tsconfig ✓ · editorconfig ✓ · prettier/eslint baseline ✓ · README ✓ · empty
suites pass ✓ (acceptance criteria in all three plans) · env prereqs surfaced ✓
(uv + pnpm not installed — plan.md prerequisites). Remaining gaps, all minor, fixed
by amendment:

1. **Per-app generated `.gitignore` files:** web explicitly deletes theirs; mobile's
   wording ("merged into root ignore") was ambiguous. Amendment: DELETE
   `apps/mobile/.gitignore` after generation; root `.gitignore` is the only one in
   the repo. (`expo-env.d.ts` stays committed per Expo convention — mobile's tree
   already keeps it.)
2. **README completeness:** backend's outline says web/mobile/packages "arrive in
   the frontend slice" — stale once all slices land. Amendment: README is written
   LAST, documents all five workspaces, and includes two "do not fix this" notes:
   (a) mobile tsconfig intentionally does not extend the root base (architecture §5),
   (b) `.npmrc node-linker=hoisted` exists for Expo/Metro — do not remove it.
3. **Implementation ordering across slices** (implied but never stated in one
   place): backend (root files + `.npmrc` + api) → web slice (packages/shared +
   api-client + apps/web) → mobile (needs `@budget/shared` to exist). Single
   `pnpm install` + full `turbo lint typecheck test` at the end; mobile's
   `expo start` boot check last.
4. **TypeScript version pin:** web asks for an identical pin across workspaces;
   backend also installs typescript at root. Amendment: one exact version string
   everywhere, resolved at implementation time (no catalog machinery — overkill
   at this size).

## 3. Decisions made by senior-lead (PM may veto, no answer required)

- Generators-then-trim for web and mobile scaffolds (architect Q5 — both engineer
  plans already assume it; agreed).
- Placeholder tests are wiring smoke tests, never tautologies, with the
  scaffold-lifetime deletion rule (§1.3). Supersedes architect Q3.
- Mobile tests on plain vitest now; jest-expo deferred to 1.8 (architect Q4,
  mobile Q3 — agreed with both).
- Wire `@budget/shared` into mobile NOW (mobile Q2 — agreed; proving Metro monorepo
  resolution is the point of including mobile in 0.1).
- `@budget/api-client` not added to web deps until 0.3 (web Q2 — agreed; an unused
  dep on an empty shell proves nothing).
- Root file ownership consolidated under backend-engineer (§1.1).
- shared export contract = `PACKAGE_NAME` only (§1.2).
- api-client: no test script (§1.4).
- react-hooks glob covers mobile (§1.5).

## 4. Open questions for the PM (answers needed before /implement)

1. **Environment bootstrap** — `uv` and `pnpm` are NOT installed on this machine
   (node v24.7.0 + corepack present). May the implementer run
   `brew install uv` (or the astral.sh install script) and `corepack enable pnpm`?
   **Recommendation: yes, run both** — nothing else in the task can proceed without
   them.
2. **ESLint 9 + Prettier vs Biome.** **Recommendation: ESLint + Prettier** —
   Expo/react-hooks ecosystem still assumes ESLint; repo too small for Biome's speed
   to matter.
3. **Node line: pin 22 LTS vs 24.** Machine currently runs 24, which satisfies
   `engines >=22` either way. **Recommendation: `.nvmrc` = 22** (active LTS, best
   Expo-tooling compatibility); developing on 24 locally remains fine, bump later is
   one line.
4. **Repo-wide `.npmrc node-linker=hoisted`.** Required for Expo+pnpm; cost: loses
   pnpm strict dependency isolation for web/packages too (§1.1).
   **Recommendation: adopt it** — Expo-documented path; the isolated-linker
   workaround is messier and this is reversible if mobile ever leaves the monorepo.
5. **Ruff rule set at scaffold: minimal `["E","F","I"]`,** expand alongside real
   code + the mypy-vs-pyright decision in 0.2. **Recommendation: confirm minimal.**
6. **`build`/`preview` scripts in `@budget/web` exist but are NOT wired into turbo**
   (no turbo `build` task until 1.7 per architecture §7).
   **Recommendation: keep them un-orchestrated** — free for manual checks, keeps the
   pipeline honest.

## 5. QA note

qa-engineer / web-qa / mobile-qa remain NOT invoked: no endpoints, no UI journeys.
Verification is the acceptance-criteria command set in the three plans (install,
turbo lint/typecheck/test, uv run pytest, vite dev boot, expo start boot), gated by
senior-lead at implementation review.

## 6. PM post-implementation note (accepted deviation from amendment 2.1)

`apps/mobile/.gitignore` was NOT deleted despite amendment 2.1. PM decision: keep it.
Reason: the file is `@generated expo-cli sync` — Expo SDK 57 auto-recreates it on
`expo start`, so deleting it produces permanent untracked-file churn. The amendment's
intent (root .gitignore is the single hand-maintained ignore file) still holds; this
one is tool-owned, like a lockfile. Slipped through senior-lead's gate — noted for
process: implementation reports must check off each binding amendment explicitly.
