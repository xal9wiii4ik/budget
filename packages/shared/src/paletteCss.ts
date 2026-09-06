// Renders the shared palette as raw CSS custom properties for the web client.
// Sole consumer: `apps/web/vite.config.ts`, whose `paletteCss()` plugin serves the
// output as the virtual module `virtual:palette.css` (imported by `main.tsx` before
// `styles/tokens.css`, which remaps these onto the semantic `--color-*` tokens).
// Nothing is written to disk: there is no generated file to commit or to drift.

import { DARK_PALETTE, LIGHT_PALETTE, PALETTE_KEYS, type PaletteKey } from './palette';

/** `surfaceRaised` -> `surface-raised` (the spelling web's `--l-*` / `--d-*` use). */
export function paletteCssName(key: PaletteKey): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** The `:root` block with every light (`--l-*`) then every dark (`--d-*`) value. */
export function renderPaletteCss(): string {
  const lines = [
    ...PALETTE_KEYS.map((key) => `  --l-${paletteCssName(key)}: ${LIGHT_PALETTE[key]};`),
    ...PALETTE_KEYS.map((key) => `  --d-${paletteCssName(key)}: ${DARK_PALETTE[key]};`),
  ];
  return `:root {\n${lines.join('\n')}\n}\n`;
}
