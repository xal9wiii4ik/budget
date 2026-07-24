# Implementation Plan (mobile): apps/mobile Expo scaffold

Slice of `setup-monorepo-scaffold` (roadmap 0.1). Planned strictly WITHIN
`architecture.md`. Deviations/disagreements are called out explicitly below.

## Approach

Scaffold `apps/mobile` with the **official `create-expo-app` default template**
(it already ships expo-router + TypeScript — the config the Expo team actually
maintains), then **trim** it down to a single placeholder route. This follows
architecture open-question-5 (generators, then trim) and section 5 (mobile
extends `expo/tsconfig.base`, not the root base). We do NOT hand-roll expo-router
wiring — hand-written Expo configs rot against SDK bumps.

Two things this slice must actively *prove* (they are the reason mobile is in the
0.1 scaffold at all, not just a `hello world`):
1. **Metro resolves a workspace package across the monorepo** — so we wire
   `@budget/shared` (`workspace:*`) NOW, import it in the placeholder screen, and
   assert its output in the smoke test. See "Data layer" for the justification.
2. **pnpm + Expo coexist** — the classic trap. Handled via a root `.npmrc`
   (`node-linker=hoisted`) + monorepo-aware `metro.config.js`.

Everything heavier (jest-expo, RN Testing Library, real screens, native modules)
is explicitly deferred to roadmap 1.8 per architecture section 6.

## SDK / template baseline

- **Expo SDK line:** SDK 54 is the current stable line (RN 0.81 / React 19) as of
  mid-2025. At implementation time run `npx create-expo-app@latest` and take
  whatever stable SDK it prints (54, or 55 if it has shipped). Pin the exact
  versions the generator writes — do not float `latest` in `package.json`.
- **Template:** default (`npx create-expo-app@latest apps/mobile`) — includes
  expo-router, TypeScript, tabs example, ESLint. NOT `blank-typescript` (that
  needs manual expo-router install + `_layout` wiring + `main` entry + plugin
  config — more hand-written surface to rot, contradicts open-question-5).

### What the generator emits vs what we TRIM

Generator (SDK 54 default) emits roughly:
```
app/(tabs)/…            app/_layout.tsx   app/+not-found.tsx
components/  constants/  hooks/  scripts/reset-project.js
assets/images/*         app.json  tsconfig.json  expo-env.d.ts
package.json  eslint.config.js  .gitignore
```
TRIM to reach the target tree:
- DELETE `app/(tabs)/`, `app/+not-found.tsx`, `components/`, `constants/`,
  `hooks/`, `scripts/`.
- REPLACE `app/_layout.tsx` with a minimal `Stack`.
- ADD `app/index.tsx` placeholder screen.
- DELETE the per-app `eslint.config.js` — lint comes from the ROOT flat config
  (architecture section 3). See "Lint".
- KEEP `assets/images/` (icon, splash-icon, adaptive-icon, favicon) — required by
  `app.json`; do not hand-shrink these, keep Expo's defaults.
- KEEP `expo-env.d.ts`, `app.json`, generated `.gitignore` merged into root
  ignore (root already covers `.expo/`).

Target final tree:
```
apps/mobile/
├── package.json
├── app.json
├── metro.config.js
├── tsconfig.json
├── vitest.config.ts
├── expo-env.d.ts
├── app/
│   ├── _layout.tsx        # Stack root
│   └── index.tsx          # placeholder screen, imports @budget/shared
├── src/
│   └── wiring.test.ts     # vitest smoke test (pure TS only)
└── assets/images/…        # icon / splash / adaptive-icon / favicon (kept)
```

## Screens / navigation

- `apps/mobile/app/_layout.tsx` — root `Stack` from expo-router, single screen,
  header hidden or default. Deep-link-safe by construction (index has no params).
- `apps/mobile/app/index.tsx` — placeholder screen inside
  `SafeAreaView`/`SafeAreaProvider`, renders a `<Text>` that includes a value
  returned from `@budget/shared` (proves the workspace import renders at runtime,
  not just compiles). No data fetching, no forms — TanStack Query/Zustand arrive
  with real features, not the scaffold.

## New components / hooks

None. Scaffold stage ships one route file + one layout file only. No shared
components, no hooks — adding them now would be speculative.

## Data layer

No API, no TanStack Query, no `@budget/api-client` usage at this stage (client is
a shell — architecture note). The only "data-layer" work is **proving Metro's
monorepo resolution**:

- Add `"@budget/shared": "workspace:*"` to `apps/mobile/package.json` NOW.
- `app/index.tsx` imports one trivial pure export from `@budget/shared` (whatever
  placeholder `packages/shared/src/index.ts` exposes — coordinate the exact name
  with whoever scaffolds shared; a version string or a `hello()`/identity helper
  is enough) and renders it.
- `src/wiring.test.ts` imports the same helper and asserts its concrete value.

**Decision: wire `@budget/shared` now, do NOT defer.** Justification: the task
brief and architecture section 4 make Metro monorepo wiring the *entire point* of
including mobile in 0.1. A scaffold that boots but never imports a workspace
package leaves the single riskiest integration (Metro + pnpm symlinks +
`watchFolders` + `nodeModulesPaths`) unproven until 1.8, exactly when we'd be
context-switched onto UI. Importing shared both at runtime (screen) and in the
test converts "green typecheck" into a real end-to-end resolution proof. Cost is
one import line; if `packages/shared` weren't ready we'd fall back to a
mobile-local pure helper, but it is in-scope for this same task so we use it.

## Platform concerns

- **pnpm × Expo (the classic trap).** Expo/Metro do not reliably resolve pnpm's
  default strictly-isolated symlink layout — duplicate `react`/`react-native`
  copies surface as "Invalid hook call" / redbox at runtime even when install and
  typecheck pass. Mitigation (matches current Expo "Work with monorepos" guidance
  for pnpm, applies to SDK 52–54):
  - **Root `.npmrc`** (repo-level, not mobile-only):
    ```
    node-linker=hoisted
    ```
    This flattens `node_modules` so Metro sees single copies of React/RN.
    NOTE — cross-cutting: `node-linker=hoisted` is a **repo-wide** pnpm setting
    that changes install layout for web/api-client/shared too. It's the safe,
    Expo-documented default and harmless for the other workspaces, but it is a
    root-tooling decision. Flagged to senior-lead/architect below as it lives in
    root `.npmrc`, which is outside `apps/mobile` — I will not create it silently
    without confirmation that the root-tooling owner is fine with it.
  - `metro.config.js` still required regardless of linker (below) — hoisting
    alone is not sufficient; Metro must watch the repo root for source-consumed
    workspace packages.
- **What Expo auto-detects now vs why we pin.** SDK 52+ `getDefaultConfig`
  auto-detects a monorepo and can set `watchFolders`/`nodeModulesPaths` itself in
  many layouts. We still write `metro.config.js` explicitly (architecture
  section 4 mandates it) because auto-detection is best-effort and silently
  breaks on non-standard layouts; an explicit config is a documented contract and
  the failure mode (module-not-found for `@budget/shared`) is otherwise cryptic.
- **Safe areas:** placeholder uses `react-native-safe-area-context` (ships with
  the template) so the baseline is correct from day one.
- **iOS vs Android:** none meaningful for a static placeholder. `app.json` keeps
  the generated `scheme` (needed by expo-router for deep links) and adaptive-icon
  for Android.
- **Native modules touched:** none. No modules added — stays Expo Go / dev client
  compatible.

## Files & content sketches

### `apps/mobile/package.json`
```jsonc
{
  "name": "@budget/mobile",
  "private": true,
  "version": "0.0.0",
  "main": "expo-router/entry",
  "scripts": {
    "dev": "expo start",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@budget/shared": "workspace:*",
    "expo": "<generator>",
    "expo-router": "<generator>",
    "expo-status-bar": "<generator>",
    "react": "<generator>",
    "react-native": "<generator>",
    "react-native-safe-area-context": "<generator>",
    "react-native-screens": "<generator>"
    // keep only what a single Stack + index needs; drop tabs-only deps
  },
  "devDependencies": {
    "typescript": "<generator>",
    "@types/react": "<generator>",
    "vitest": "<root pin>"
    // eslint + config come from the ROOT workspace, not duplicated here
  }
}
```
- `main: "expo-router/entry"` is required by expo-router (generator sets it).
- `dev` = `expo start` per brief. `test` = `vitest run` (non-watch for CI/turbo).

### `apps/mobile/metro.config.js` (exact monorepo config, architecture §4)
```js
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Watch the whole monorepo so edits in packages/* trigger Metro rebuilds.
config.watchFolders = [workspaceRoot];

// Resolve app-local first, then hoisted root node_modules.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = config;
```
(No `disableHierarchicalLookup` — with `node-linker=hoisted` the default lookup
plus these two paths is correct and simplest.)

### `apps/mobile/tsconfig.json` (architecture §5 — extends Expo base, NOT root)
```jsonc
{
  "extends": "expo/tsconfig.base",
  "compilerOptions": {
    "strict": true              // re-assert; Expo base is loose on some flags
  },
  "include": [
    "**/*.ts",
    "**/*.tsx",
    ".expo/types/**/*.ts",
    "expo-env.d.ts"
  ]
}
```
- Deliberately does NOT extend `../../tsconfig.base.json` — Expo's base sets its
  own `jsx`, `moduleResolution`, `paths` that conflict. Shared strictness is a
  convention here, not inheritance. (Architecture §5 — documented in root README
  so nobody "fixes" it.)
- `@budget/shared` resolves via the hoisted `node_modules` symlink + the package's
  `"types"` export; no `paths` entry needed.

### `apps/mobile/vitest.config.ts`
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],   // pure TS only
    exclude: ['app/**', 'node_modules/**'],
  },
});
```
- `exclude: ['app/**']` is load-bearing: it keeps vitest from ever pulling a file
  that imports `react-native`, which vitest cannot transform without jest-expo.

### `apps/mobile/src/wiring.test.ts` (smoke test — NOT a tautology)
```ts
import { describe, it, expect } from 'vitest';
import { <helper> } from '@budget/shared';

describe('monorepo wiring', () => {
  it('resolves and executes @budget/shared across the workspace', () => {
    expect(<helper>(...)).toBe(<known concrete value>);
  });
});
```
- Per senior-lead override: this asserts a real value from a real cross-package
  import, proving Metro-independent TS resolution + the workspace link. No
  `expect(true).toBe(true)`.

### `apps/mobile/app/_layout.tsx`
```tsx
import { Stack } from 'expo-router';
export default function RootLayout() {
  return <Stack />;
}
```

### `apps/mobile/app/index.tsx`
```tsx
import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { <helper> } from '@budget/shared';

export default function Index() {
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Text>Budget — mobile scaffold ({<helper>(...)})</Text>
      </View>
    </SafeAreaView>
  );
}
```

## Lint

**Recommendation: root ESLint flat config only — do NOT add `eslint-config-expo`
at scaffold.** Justification (aligns with architecture §3 "one root
`eslint.config.mjs` … react-hooks override for web/mobile", and "keep lean"):
- The root flat config already provides TS + `react`/`react-hooks` rules; a single
  static placeholder screen gets full value from those.
- `eslint-config-expo` adds RN/Expo-specific rules (import ordering, RN globals)
  whose payoff only appears once real screens/native APIs land — that's roadmap
  1.8. Adding it now means a second config surface for zero current benefit.
- We DELETE the generator's `apps/mobile/eslint.config.js` so lint has one source
  of truth. Mobile is linted by the root config globbing `apps/mobile/**`.
- Revisit in 1.8: fold `eslint-config-expo` into the mobile override block when RN
  UI work begins. Noted as a follow-up, not silent debt.

## UI states

Placeholder screen has exactly one state (static content) — no loading/empty/error
because there is no async data at scaffold stage. The loading/empty/error/offline
discipline arrives with the first real data screen (post-0.1). Explicitly out of
scope here; noted so it isn't mistaken as forgotten.

## Ordered steps

1. Ensure repo-root scaffold exists (`pnpm-workspace.yaml` globs `apps/*`,
   `packages/*`; `packages/shared` present with a pure export). Coordinate with
   senior-lead if shared isn't ready.
2. Add **root `.npmrc`** with `node-linker=hoisted` (flag to root-tooling owner —
   see Risks; this file is outside my slice).
3. `npx create-expo-app@latest apps/mobile` (default template, current stable SDK).
4. Trim: delete `app/(tabs)/`, `app/+not-found.tsx`, `components/`, `constants/`,
   `hooks/`, `scripts/`, and the per-app `eslint.config.js`.
5. Write `app/_layout.tsx`, `app/index.tsx`, `metro.config.js`, `tsconfig.json`,
   `vitest.config.ts`, `src/wiring.test.ts` as sketched.
6. Edit `package.json`: name/private/version/main, scripts (dev/lint/typecheck/
   test), add `@budget/shared` `workspace:*`, add `vitest` dev dep, prune tabs-only
   deps, remove duplicated eslint deps (root owns them).
7. `pnpm install` at repo root.
8. Run acceptance checks (below). Fix wiring (not by hand-editing generated Expo
   files — re-run/adjust config) until green.

## Acceptance criteria

- `pnpm install` at root completes; `apps/mobile/node_modules` links `@budget/shared`.
- `pnpm --filter @budget/mobile typecheck` (tsc --noEmit) → 0 errors.
- `pnpm --filter @budget/mobile lint` (root eslint over mobile) → 0 errors.
- `pnpm --filter @budget/mobile test` (vitest run) → the wiring smoke test passes.
- `turbo lint typecheck test` includes `@budget/mobile` and is green.
- `cd apps/mobile && npx expo start` boots Metro with no redbox; `app/index.tsx`
  renders in Expo Go / iOS simulator showing the `@budget/shared` value (proves
  Metro monorepo resolution + pnpm layout end-to-end). This step is verified once
  at scaffold time; device/E2E matrix is mobile-qa's job, not mine.

## Risks / notes

- **Root `.npmrc` is outside my slice.** `node-linker=hoisted` is repo-wide and
  the correct fix for the pnpm+Expo trap, but it belongs to root tooling. I'll
  surface it to senior-lead rather than create it unilaterally. If the root owner
  prefers pnpm's default isolated linker, the fallback is
  `public-hoist-pattern[]=*react*`/`*react-native*` in `.npmrc` plus possibly
  `config.resolver.disableHierarchicalLookup = true` in metro — messier; hoisted
  is the recommended path.
- **SDK version drift.** Plan targets SDK 54; if create-expo-app emits a newer
  line, take its versions verbatim and re-verify the metro recipe (the
  `watchFolders`/`nodeModulesPaths` shape has been stable across 52–54).
- **vitest cannot import RN.** Enforced by `vitest.config.ts` excludes. Any future
  test that renders a component needs jest-expo (roadmap 1.8) — a separate runner,
  not vitest. Boundary stated so nobody adds an RN import to `src/*.test.ts`.
- **Metro `watchFolders` = repo root** widens the file-watch set; negligible at
  this repo size, standard for Expo monorepos.
- **`expo start` verification is scaffold-time smoke only** — real device coverage
  (Android back button, iOS swipe-back, notch) is deferred; nothing here exercises
  those yet.

## Open questions (with recommendations)

1. **`.npmrc node-linker=hoisted` at repo root** — my slice needs it but the file
   is root tooling. Recommend: add it, it's the Expo-blessed pnpm-monorepo
   setting and benign for web/api. Confirm the root-tooling owner (whoever does the
   pnpm-workspace slice) will include it, so mobile isn't left broken at runtime.
2. **Wire `@budget/shared` into mobile now** (vs defer to 1.8). Recommend: wire
   now — proving Metro monorepo resolution is the reason mobile is in 0.1;
   deferring leaves the riskiest integration untested. Needs `packages/shared` to
   expose a pure export in this same task (it does, per architecture §5/§0.4 shell).
3. **`eslint-config-expo` now vs 1.8.** Recommend: defer to 1.8 — root flat config
   covers a static placeholder; Expo-specific lint rules pay off only with real RN
   UI. Keeps the config surface single-source at scaffold stage.
```
