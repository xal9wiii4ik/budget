# Implementation Plan (web): monorepo scaffold — apps/web + packages/shared + packages/api-client

## Approach

Scaffold `apps/web` from the official `create-vite react-ts` template, then trim it down
to match architecture.md's source-consumption + single-root-tooling model (decisions 3, 4, 5).
The generator gives us upstream-correct `vite.config.ts` / `index.html` / entry wiring; we
throw away the parts that duplicate root tooling (per-package eslint config, per-package
`.gitignore`, README) and the demo styling/assets. `packages/shared` and `packages/api-client`
are hand-written — a few lines each — and consumed as raw TS via an `exports` map, no build step.

Every placeholder is a **real wiring smoke test**, not a tautology (owner policy + senior-lead
override of the `expect(true)` example). The web test renders `<App/>` (which imports a const
from `@budget/shared`) and asserts on the output — one test proving, simultaneously: the jsx
transform, the web tsconfig, and cross-package source resolution under Vite. `shared` asserts on
its own real export. `api-client` is an empty shell with **no test file and no `test` script**
(nothing non-vacuous to assert; turbo skips workspaces that lack the task — see Data layer).

This stays within architecture.md. Two deviations from the generator's defaults, both consistent
with the architect's decisions, are called out inline (collapsed tsconfig; centralized eslint).

## Screens / components affected

None (greenfield). No feature screens are created — scaffold only.

## New files / structure (my slice)

```
apps/web/
├── index.html                 # KEEP from generator (title → "Budget")
├── package.json               # REWRITE → @budget/web, scripts, deps below
├── tsconfig.json              # REPLACE generator's split with ONE config extending base
├── vite.config.ts             # KEEP + add vitest `test` block
├── src/
│   ├── main.tsx               # KEEP, trim `import './index.css'`
│   ├── App.tsx                # SIMPLIFY → imports PACKAGE_NAME from @budget/shared
│   ├── App.test.tsx           # NEW → render smoke test
│   └── vite-env.d.ts          # KEEP
packages/shared/
├── package.json               # @budget/shared, exports map, scripts
├── tsconfig.json              # extends ../../tsconfig.base.json
└── src/
    ├── index.ts               # export const PACKAGE_NAME = '@budget/shared'
    └── index.test.ts          # asserts on PACKAGE_NAME
packages/api-client/
├── package.json               # @budget/api-client, exports map, lint+typecheck only
├── tsconfig.json              # extends ../../tsconfig.base.json
└── src/index.ts               # export {}
```

### create-vite react-ts output → trim decisions

Generator emits: `index.html`, `package.json`, `tsconfig.json` + `tsconfig.app.json` +
`tsconfig.node.json`, `vite.config.ts`, `eslint.config.js`, `.gitignore`, `public/vite.svg`,
`src/{main.tsx, App.tsx, App.css, index.css, vite-env.d.ts, assets/react.svg}`, `README.md`.

- **KEEP (modified):** `index.html`, `package.json`, `vite.config.ts`, `src/main.tsx`,
  `src/App.tsx`, `src/vite-env.d.ts`.
- **DELETE:** `eslint.config.js` (root `eslint.config.mjs` is the single source — decision 3),
  `.gitignore` (root `.gitignore` covers all workspaces — decision, arch. layout),
  `src/App.css`, `src/index.css`, `src/assets/react.svg`, `public/vite.svg` (demo cruft),
  `README.md` (root README documents layout).
- **COLLAPSE:** the 3-file tsconfig split → a single `apps/web/tsconfig.json` extending the base.
  Rationale: architecture.md decision 5 specifies "web tsconfig.json **extends
  ../../tsconfig.base.json**, adds jsx/DOM/vite types" — a single config. The generator's
  app/node split exists to separate node-typed config files from DOM-typed app code; at scaffold
  size that split is more files than value. We add `"node"` to `types` so `vite.config.ts`
  typechecks under the one config. If a stricter app/node boundary is ever wanted, reintroducing
  the split is local and cheap.

## Data layer

No API endpoints consumed (scaffold). Relevant contract detail is **cross-package resolution**:

- `apps/web` depends on `@budget/shared` via `"@budget/shared": "workspace:*"` (pnpm links the
  local package). Item-4 confirmation: `@budget/shared`'s `exports["."]` maps `"types"` and
  `"default"` to `./src/index.ts`. Under `moduleResolution: "bundler"` (base tsconfig) `tsc`
  resolves the `types` condition to the raw `.ts` for typecheck; Vite follows the pnpm symlink
  and runs the `.ts` through its esbuild transform pipeline (linked workspace packages whose
  `exports` point at source are treated as source, not pre-bundled). Both paths hit source — no
  build step. **Confirmed working with `"@budget/shared": "workspace:*"` as the exact dep entry.**
- `@budget/api-client` is NOT added to web deps yet (empty shell, nothing to import). It gets
  wired into web in task 0.3 when the client is generated.
- **turbo `test` across all workspaces:** `api-client` intentionally declares **no `test`
  script**. `turbo run test` includes only workspaces that define the task, so api-client is
  silently (and correctly) absent from the test graph — `web` and `shared` still run. This is
  why a no-op `test` script or a fake test is unnecessary and undesirable there.

## UI states

N/A — no screens. `App.tsx` renders a single static heading (`Budget — {PACKAGE_NAME}`) purely
so the smoke test has real rendered output to assert on. No loading/empty/error surfaces exist
until feature tasks (roadmap 1.x).

## Content sketches

**apps/web/package.json**
```jsonc
{
  "name": "@budget/web",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",          // present but NOT wired into turbo (arch. defers build to 1.7)
    "preview": "vite preview",
    "lint": "eslint .",             // resolves root eslint.config.mjs via flat-config ancestor lookup
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "<current stable>",
    "react-dom": "<current stable>",
    "@budget/shared": "workspace:*"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "<stable>",
    "vite": "<stable>",
    "vitest": "<stable>",
    "typescript": "<pin, same across workspaces>",
    "@types/react": "<stable>",
    "@types/react-dom": "<stable>",
    "@types/node": "<stable>"        // for vite.config.ts
  }
}
```

**apps/web/tsconfig.json** — deltas over `../../tsconfig.base.json`:
```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client", "node"]
  },
  "include": ["src", "vite.config.ts"]
}
```
(base already supplies `strict`, `moduleResolution: bundler`, `module: esnext`, `target: es2022`,
`noEmit`, `isolatedModules`, `skipLibCheck`, `forceConsistentCasingInFileNames`.)

**apps/web/vite.config.ts**
```ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: { environment: 'node' },   // no jsdom — see test decision below
});
```

**apps/web/src/App.tsx**
```tsx
import { PACKAGE_NAME } from '@budget/shared';

export default function App() {
  return <h1>Budget — {PACKAGE_NAME}</h1>;
}
```

**apps/web/src/App.test.tsx** — smoke test (no jsdom, no @testing-library):
```tsx
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import App from './App';

describe('App', () => {
  it('renders and pulls a value from @budget/shared', () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('@budget/shared');
  });
});
```

**packages/shared/package.json**
```jsonc
{
  "name": "@budget/shared",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "exports": { ".": { "types": "./src/index.ts", "default": "./src/index.ts" } },
  "scripts": { "lint": "eslint .", "typecheck": "tsc --noEmit", "test": "vitest run" },
  "devDependencies": { "vitest": "<stable>", "typescript": "<pin>" }
}
```
**packages/shared/src/index.ts**
```ts
export const PACKAGE_NAME = '@budget/shared';
```
**packages/shared/src/index.test.ts**
```ts
import { describe, it, expect } from 'vitest';
import { PACKAGE_NAME } from './index';

describe('@budget/shared', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@budget/shared');
  });
});
```
**packages/shared/tsconfig.json**
```jsonc
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

**packages/api-client/package.json**
```jsonc
{
  "name": "@budget/api-client",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "exports": { ".": { "types": "./src/index.ts", "default": "./src/index.ts" } },
  "scripts": { "lint": "eslint .", "typecheck": "tsc --noEmit" },
  "devDependencies": { "typescript": "<pin>" }
}
```
**packages/api-client/src/index.ts**
```ts
export {};
```
**packages/api-client/tsconfig.json**
```jsonc
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

## Key decisions (asked in the task)

1. **Web smoke test: NO jsdom, NO @testing-library/react.** Recommended minimal option:
   server-render via `react-dom/server` `renderToStaticMarkup` in a `node` vitest environment
   and assert on the HTML string. This executes the jsx transform end-to-end and proves the
   tsconfig + cross-package resolution, with **zero extra deps** (`react-dom` is already present).
   jsdom + Testing Library add an `environment: 'jsdom'`, a `jest-dom` setup file, and 3+ deps
   whose only payoff — querying/interacting with a live DOM — has nothing to exercise at scaffold
   stage. They come in with the first real component test (roadmap 1.x). A bare
   `expect(typeof App).toBe('function')` would also avoid jsdom but is weaker; rendering is barely
   more code and genuinely fails if the transform or the `@budget/shared` link breaks.
2. **No vitest setup file** at scaffold (setup files exist for jest-dom matchers / global mocks —
   none needed with the node/server-render approach). `globals: false` (vitest default) → explicit
   `vitest` imports, so no `vitest/globals` entry in tsconfig `types`.
3. **`packages/shared/src/index.ts` = one neutral const** (`PACKAGE_NAME`), not `export {}`.
   Justification vs the smoke-test constraint: an empty export gives both shared's own test and
   web's import test nothing real to assert on, forcing a vacuous test (owner policy forbids). A
   single package-name const is the smallest thing that keeps both tests genuine wiring smokes
   without pre-empting task 0.4's real API surface (money/date helpers, zod schemas).
4. **`packages/api-client`: no test file, no `test` script** (senior-lead's preferred branch).
   An `export {}` shell has nothing non-vacuous to test; turbo skips workspaces lacking the task,
   so `turbo run test` stays green without a no-op. Real tests arrive with generation in 0.3.
5. **shared/api-client need no vitest config file** — vitest defaults (node env, `**/*.test.ts`
   discovery) are sufficient; omitting the config keeps them lean.

## Cross-workspace coordination (flag to senior-lead / backend engineer)

- **Root `eslint.config.mjs` is backend's slice**, but `apps/web` needs a web-scoped override.
  Requested block (my workspace-specific lint override, for backend to drop into the root flat
  config), plus root devDeps `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`:
  ```js
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  }
  ```
  `apps/web`'s `lint: "eslint ."` relies on ESLint 9 flat-config ancestor lookup finding the root
  `eslint.config.mjs`. This must exist (backend) before `turbo lint` is green for web.
- **`tsconfig.base.json` is backend's slice.** My workspace configs assume it sets: `strict`,
  `moduleResolution: "bundler"`, `module: "esnext"`, `target: "es2022"`, `noEmit`,
  `isolatedModules`, `skipLibCheck`, `forceConsistentCasingInFileNames` (per arch. decision 5).
  If `noEmit` is NOT in the base, add it to each package's config (typecheck-only, source
  consumption).
- **`typescript` version** should be pinned identically across web/shared/api-client (declared
  per-workspace to stay pnpm-strict-clean and avoid phantom-dependency breakage on `tsc`).

## Ordered steps

1. (Backend prereq) root `package.json`, `pnpm-workspace.yaml` (`apps/*`, `packages/*`),
   `turbo.json`, `tsconfig.base.json`, `eslint.config.mjs`, `.prettierrc`, `.gitignore` exist.
2. `pnpm create vite apps/web --template react-ts` (or scaffold into a temp dir and move).
3. Trim per the DELETE/COLLAPSE list; rewrite `package.json`, `tsconfig.json`, `vite.config.ts`.
4. Write `src/App.tsx`, `src/App.test.tsx`; trim `main.tsx` (drop css import).
5. Hand-write `packages/shared` (package.json, tsconfig.json, src/index.ts, src/index.test.ts).
6. Hand-write `packages/api-client` (package.json, tsconfig.json, src/index.ts).
7. `pnpm install` at root.
8. Run `pnpm turbo run lint typecheck test`; run `pnpm --filter @budget/web dev`.

## Acceptance criteria

- `pnpm install` succeeds; `@budget/shared` links into `apps/web` (workspace:*).
- `pnpm turbo run lint` green for `@budget/web`, `@budget/shared`, `@budget/api-client`.
- `pnpm turbo run typecheck` green for all three.
- `pnpm turbo run test` green for `@budget/web` and `@budget/shared`; `@budget/api-client`
  absent from the test graph (no `test` task) — not a failure.
- `pnpm --filter @budget/web dev` starts the Vite dev server; page shows "Budget — @budget/shared".

## Risks / notes

- **Vite serving workspace `.ts` source:** relies on pnpm symlink + Vite treating linked packages
  as source. Standard, but if Vite ever tries to pre-bundle it, add
  `optimizeDeps: { exclude: ['@budget/shared'] }`. Verify the dev server renders the shared value
  (acceptance step) — that's the real confirmation of item 4.
- **create-vite template drift:** the exact emitted file set (esp. the tsconfig split and whether
  a flat `eslint.config.js` ships) can change between Vite majors. The trim list is by intent —
  reconcile against whatever the generator actually emits at implementation time; goal state is
  the file tree above.
- **ESLint flat-config resolution:** if root-config ancestor lookup misbehaves for a workspace,
  fall back to a 2-line `apps/web/eslint.config.mjs` that re-exports the root config. Prefer the
  single root config first.
- **Phantom deps under pnpm strictness:** every `import`/binary a workspace uses is declared in
  that workspace (react-dom, vitest, typescript). Don't rely on root hoisting for workspace
  scripts.

## Open questions (with recommendations)

1. **`build`/`preview` scripts in `@budget/web` now, or defer with the turbo `build` task to
   1.7?** Recommendation: **keep the local scripts, do NOT add `build` to `turbo.json`.** The
   scripts are free and useful for manual checks; not wiring them into turbo keeps the scaffold
   consistent with architecture.md decision 7 (no `build` task yet). Confirm you're fine with the
   scripts existing un-orchestrated.
2. **Add `@budget/api-client: "workspace:*"` to `apps/web` deps now (unused) to pre-prove the
   second cross-package link, or wait for 0.3?** Recommendation: **wait for 0.3.** An unused dep
   pointing at an `export {}` shell proves nothing and would need a throwaway import to exercise.
   The shared link already proves the mechanism.
3. Everything else (exact React/Vite/vitest/typescript versions) is deferred to implementation-time
   "current stable" per architecture.md — no decision needed now.
