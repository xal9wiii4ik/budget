/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Deliberately a path import, not `@budget/shared`: the config file is bundled by
// esbuild, which INLINES relative sources but externalises bare specifiers — and
// Node cannot then load the workspace package, whose entry is TypeScript.
import { renderPaletteCss } from '../../packages/shared/src/paletteCss';
import {
  MANIFEST_PATH,
  OFFLINE_PATH,
  renderManifest,
  renderOfflineHtml,
  themeColorMetas,
} from './pwa';

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

/** The install surface that carries a colour — manifest, offline page, theme-color
 * metas — rendered from the shared palette (see pwa.ts for why each exists).
 *
 * Emitted as real files at build time, and answered by a middleware in dev so that
 * `vite dev` and the built site serve the same thing at the same paths. Nothing
 * generated is committed. */
function pwaAssets(): Plugin {
  const files: Readonly<Record<string, { type: string; render: () => string }>> = {
    [MANIFEST_PATH]: { type: 'application/manifest+json', render: renderManifest },
    [OFFLINE_PATH]: { type: 'text/html; charset=utf-8', render: renderOfflineHtml },
  };
  return {
    name: 'budget-pwa-assets',
    transformIndexHtml: () =>
      themeColorMetas().map((meta) => ({
        tag: 'meta',
        attrs: { name: 'theme-color', media: meta.media, content: meta.content },
        injectTo: 'head' as const,
      })),
    generateBundle() {
      for (const [path, file] of Object.entries(files)) {
        this.emitFile({ type: 'asset', fileName: path.slice(1), source: file.render() });
      }
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const file = files[(request.url ?? '').split('?')[0] ?? ''];
        if (file === undefined) return next();
        response.setHeader('Content-Type', file.type);
        response.end(file.render());
      });
    },
  };
}

export default defineConfig({
  plugins: [paletteCss(), pwaAssets(), react()],
  test: { environment: 'node' },
});
