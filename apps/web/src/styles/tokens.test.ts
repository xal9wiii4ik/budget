import { readFileSync } from 'node:fs';

import { PALETTE_KEYS, paletteCssName, renderPaletteCss } from '@budget/shared';
import { describe, expect, it } from 'vitest';

// tokens.css is CSS: nothing typechecks it. These two checks pin what can actually
// break now that the raw palette lives in @budget/shared and arrives as
// `virtual:palette.css` — a renamed or dropped palette key would leave a `var(--l-x)`
// resolving to nothing (transparent), and a semantic token forgotten in one of the
// three theme blocks would show as a light patch in dark mode.

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

/** The body of the rule that starts at `selector`, braces balanced. */
function block(selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`no such block in tokens.css: ${selector}`);
  const from = css.indexOf('{', start) + 1;
  let depth = 1;
  let i = from;
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') depth -= 1;
    i += 1;
  }
  return css.slice(from, i - 1);
}

function names(source: string, pattern: RegExp): Set<string> {
  return new Set([...source.matchAll(pattern)].map((match) => match[1]));
}

describe('tokens.css', () => {
  it('only reads raw palette variables that the shared renderer declares', () => {
    const declared = names(renderPaletteCss(), /(--[ld]-[a-z0-9-]+):/g);
    // The shadows are CSS syntax, not palette colours: tokens.css declares them itself.
    for (const own of names(css, /^\s*(--[ld]-[a-z0-9-]+):/gm)) declared.add(own);

    const referenced = [...names(css, /var\((--[ld]-[a-z0-9-]+)\)/g)];

    expect(referenced.filter((name) => !declared.has(name))).toEqual([]);
    expect(referenced.length).toBeGreaterThan(0);
  });

  it('remaps every palette key in all three theme blocks', () => {
    const expected = PALETTE_KEYS.map((key) => `--color-${paletteCssName(key)}`).sort();

    for (const selector of [':root {', "[data-theme='dark']", ":root:not([data-theme='light'])"]) {
      const declared = names(block(selector), /^\s*(--color-[a-z0-9-]+):/gm);
      expect([...declared].filter((name) => expected.includes(name)).sort()).toEqual(expected);
    }
  });
});
