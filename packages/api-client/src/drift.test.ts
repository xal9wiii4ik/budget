import { readFileSync } from 'node:fs';

import { describe, it, expect } from 'vitest';

import { generateSchema } from '../scripts/generate.mjs';

// Edge-2 drift check: the committed generated file must be byte-identical to a
// fresh regeneration of apps/api/openapi.json. `generateSchema()` is the same
// function the CLI writer uses, so writer and checker cannot disagree.
// The 30 s timeout: a full regeneration of the grown spec took over vitest's
// default 5 s on a shared CI runner (ci-js on bc76001) — slow, not stale.
describe('generated client is not stale', () => {
  it('matches a fresh regeneration of apps/api/openapi.json', { timeout: 30_000 }, async () => {
    const committed = readFileSync(new URL('./generated/schema.d.ts', import.meta.url), 'utf8');
    const fresh = await generateSchema();

    expect(
      fresh,
      'schema.d.ts is out of date — run `pnpm openapi` and commit both ' +
        'apps/api/openapi.json and packages/api-client/src/generated/schema.d.ts',
    ).toBe(committed);
  });
});
