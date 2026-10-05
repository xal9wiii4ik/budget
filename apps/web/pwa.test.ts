import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { renderManifest, themeColorMetas } from './pwa';

describe('install surface', () => {
  it('names only icons that exist, in the sizes an install needs', () => {
    // The manifest is generated, the icons are committed files: the one way the
    // two drift is an icon renamed or dropped while the manifest still points
    // at it — and a missing 192/512 is what makes Chrome withdraw the install.
    const manifest = JSON.parse(renderManifest()) as {
      icons: { src: string; sizes: string; purpose: string }[];
    };
    for (const icon of manifest.icons) {
      expect(existsSync(join(__dirname, 'public', icon.src)), icon.src).toBe(true);
    }
    const anySizes = manifest.icons.filter((i) => i.purpose === 'any').map((i) => i.sizes);
    expect(anySizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });

  it('gives each colour scheme its own theme-color', () => {
    const metas = themeColorMetas();
    expect(metas.map((m) => m.media)).toEqual([
      '(prefers-color-scheme: light)',
      '(prefers-color-scheme: dark)',
    ]);
    expect(metas[0]?.content).not.toBe(metas[1]?.content);
  });
});
