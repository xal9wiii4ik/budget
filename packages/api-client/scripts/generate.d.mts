// Ambient declaration for the untyped node-only generator script. Co-located so
// src/drift.test.ts's `import { generateSchema } from "../scripts/generate.mjs"`
// type-resolves under tsc / vitest --typecheck without adding the .mjs to the
// program. The module's entire public surface is this one function; keep it so.
export function generateSchema(): Promise<string>;
