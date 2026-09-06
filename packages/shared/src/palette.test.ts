import { describe, expect, it } from 'vitest';

import { DARK_PALETTE, LIGHT_PALETTE, type Palette, type PaletteKey } from './palette';

// The contrast table of .tasks/web-redesign/plan-web.md, pinned as thresholds for
// both palettes: text on its background >= 4.5:1 (WCAG 2.1 AA), border-strong (a UI
// outline, not text) >= 3:1. Only the THRESHOLD is the invariant — the exact ratios
// are free to move, a pair dropping under is what a "small colour tweak" breaks.

type Rgba = { r: number; g: number; b: number; a: number };

function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff, a: 1 };
  }
  const rgba = /^rgba?\(([^)]+)\)$/i.exec(value);
  if (rgba) {
    const parts = rgba[1].split(',').map((part) => Number.parseFloat(part.trim()));
    if (parts.length >= 3 && parts.slice(0, 3).every((part) => Number.isFinite(part))) {
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    }
  }
  throw new Error(`unsupported colour: ${value}`);
}

/** Source-over composite: a translucent colour is only ever seen over its surface. */
function over(fg: Rgba, bg: Rgba): Rgba {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

function relativeLuminance({ r, g, b }: Rgba): number {
  const channel = (raw: number): number => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(palette: Palette, fgKey: PaletteKey, bgKey: PaletteKey): number {
  const bg = parseColor(palette[bgKey]);
  if (bg.a !== 1) throw new Error(`background ${bgKey} must be opaque`);
  const fg = over(parseColor(palette[fgKey]), bg);
  const [light, dark] = [relativeLuminance(fg), relativeLuminance(bg)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

const TEXT_PAIRS: ReadonlyArray<readonly [PaletteKey, PaletteKey]> = [
  ['text', 'bg'],
  ['text', 'surface'],
  ['textMuted', 'surface'],
  ['textSubtle', 'surface'],
  ['accent', 'surface'],
  ['accentFg', 'accent'],
  ['accentSoftFg', 'accentSoft'],
  ['dangerFg', 'danger'],
  ['dangerSoftFg', 'dangerSoft'],
  ['successSoftFg', 'successSoft'],
  ['warningSoftFg', 'warningSoft'],
  ['expense', 'surface'],
  ['income', 'surface'],
  ['transfer', 'surface'],
];

describe.each([
  ['light', LIGHT_PALETTE],
  ['dark', DARK_PALETTE],
])('%s palette contrast', (_name, palette) => {
  it.each(TEXT_PAIRS)('%s on %s is at least 4.5:1', (fg, bg) => {
    expect(contrast(palette, fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('borderStrong on surface is at least 3:1 (UI outline, not text)', () => {
    expect(contrast(palette, 'borderStrong', 'surface')).toBeGreaterThanOrEqual(3);
  });
});
