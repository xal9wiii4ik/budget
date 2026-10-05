// Everything the "add to Home Screen" install needs that carries a COLOUR, rendered
// from the shared palette instead of being typed a second time: the web app
// manifest, the two theme-color metas and the offline page. The palette lives in
// packages/shared/src/palette.ts (one place, shared with the phone); the icons are
// art and are committed as files (scripts/make-icons.py reads the same palette).
//
// Pure functions, no Vite in here: vite.config.ts wires them into the build and
// the dev server.

// A path import for the same reason as in vite.config.ts: the config is bundled
// by esbuild, which inlines relative sources but externalises bare specifiers.
import { DARK_PALETTE, LIGHT_PALETTE } from '../../packages/shared/src/palette';

export const MANIFEST_PATH = '/manifest.webmanifest';
export const OFFLINE_PATH = '/offline.html';

/**
 * The manifest. `display: standalone` is what removes the browser chrome; the
 * 192 and 512 icons are what Chrome asks for before it offers an install, and the
 * maskable one is what Android cuts its own shape out of. A manifest cannot vary
 * by colour scheme, so it carries the LIGHT pair — it only paints the splash
 * screen for the half-second before the app's own theme takes over.
 */
export function renderManifest(): string {
  const manifest = {
    name: 'Budget',
    short_name: 'Budget',
    description: 'Personal budget: spending, accounts, goals.',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: LIGHT_PALETTE.bg,
    theme_color: LIGHT_PALETTE.surface,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export interface ThemeColorMeta {
  readonly media: string;
  readonly content: string;
}

/**
 * The browser-chrome colour per colour scheme: the SURFACE, because that is what
 * the top bar is painted with, so the status bar and the bar under it read as one.
 * src/theme/theme.ts overrides both when the user picks a theme that differs from
 * the OS — a media query cannot know about that pick.
 */
export function themeColorMetas(): readonly ThemeColorMeta[] {
  return [
    { media: '(prefers-color-scheme: light)', content: LIGHT_PALETTE.surface },
    { media: '(prefers-color-scheme: dark)', content: DARK_PALETTE.surface },
  ];
}

/**
 * The page the service worker answers a NAVIGATION with when the network is gone.
 * Self-contained by necessity — no bundle, no stylesheet, no dictionary can be
 * assumed reachable — hence its own two-language copy and inline palette. The
 * installed app would otherwise show the browser's own error page inside a window
 * that has no address bar to recover with.
 */
export function renderOfflineHtml(): string {
  const light = LIGHT_PALETTE;
  const dark = DARK_PALETTE;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>Budget</title>
    <style>
      :root { color-scheme: light dark; --bg: ${light.bg}; --text: ${light.text}; --muted: ${light.textMuted}; --accent: ${light.accent}; --accent-fg: ${light.accentFg}; }
      @media (prefers-color-scheme: dark) {
        :root { --bg: ${dark.bg}; --text: ${dark.text}; --muted: ${dark.textMuted}; --accent: ${dark.accent}; --accent-fg: ${dark.accentFg}; }
      }
      body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; box-sizing: border-box; background: var(--bg); color: var(--text); font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; text-align: center; }
      h1 { margin: 0 0 0.5rem; font-size: 1.25rem; }
      p { margin: 0 0 1.25rem; color: var(--muted); line-height: 1.5; }
      button { font: inherit; font-weight: 600; padding: 0.625rem 1.25rem; border: 0; border-radius: 0.5rem; background: var(--accent); color: var(--accent-fg); cursor: pointer; }
    </style>
  </head>
  <body>
    <main>
      <h1 id="title">No connection</h1>
      <p id="text">Budget keeps nothing on this device, so it needs the network to show your data.</p>
      <button id="retry" type="button">Try again</button>
    </main>
    <script>
      if ((navigator.language || '').toLowerCase().indexOf('ru') === 0) {
        document.documentElement.lang = 'ru';
        document.getElementById('title').textContent = 'Нет соединения';
        document.getElementById('text').textContent =
          'Budget не хранит данные на устройстве, поэтому без сети показать их не может.';
        document.getElementById('retry').textContent = 'Повторить';
      }
      document.getElementById('retry').addEventListener('click', function () {
        location.reload();
      });
    </script>
  </body>
</html>
`;
}
