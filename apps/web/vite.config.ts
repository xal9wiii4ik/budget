/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Deliberately a path import, not `@budget/shared`: the config file is bundled by
// esbuild, which INLINES relative sources but externalises bare specifiers — and
// Node cannot then load the workspace package, whose entry is TypeScript.
import { renderPaletteCss } from '../../packages/shared/src/paletteCss';

/** The raw `--l-*` / `--d-*` palette, served straight from the shared palette module.
 *
 * `main.tsx` imports `virtual:palette.css` before `styles/tokens.css`; the colour
 * values themselves live in `packages/shared/src/palette.ts` (the one place they are
 * written, shared with the phone) and nothing generated is committed. The resolved id
 * is the plain `virtual:palette.css` — no `\0` marker: the `.css` suffix is what puts
 * it through Vite's CSS pipeline, and this spelling is the one verified in both `vite
 * build` and the dev server. */
function paletteCss(): Plugin {
  const id = 'virtual:palette.css';
  return {
    name: 'budget-palette-css',
    resolveId: (source) => (source === id ? id : undefined),
    load: (loaded) => (loaded === id ? renderPaletteCss() : undefined),
  };
}

export default defineConfig({
  plugins: [paletteCss(), react()],
  test: { environment: 'node' },
});
