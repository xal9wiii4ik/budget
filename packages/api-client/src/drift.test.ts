import { readFileSync } from "node:fs";

import { describe, it, expect } from "vitest";

import { generateSchema } from "../scripts/generate.mjs";

// Edge-2 drift check: the committed generated file must be byte-identical to a
// fresh regeneration of apps/api/openapi.json. `generateSchema()` is the same
// function the CLI writer uses, so writer and checker cannot disagree.
describe("generated client is not stale", () => {
  it("matches a fresh regeneration of apps/api/openapi.json", async () => {
    const committed = readFileSync(
      new URL("./generated/schema.d.ts", import.meta.url),
      "utf8",
    );
    const fresh = await generateSchema();

    expect(
      fresh,
      "schema.d.ts is out of date — run `pnpm openapi` and commit both " +
        "apps/api/openapi.json and packages/api-client/src/generated/schema.d.ts",
    ).toBe(committed);
  });
});
