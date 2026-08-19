/**
 * Loading and $ref resolution for the committed `apps/api/openapi.json`.
 *
 * The contract is read at RUNTIME (architecture §5): a build-time codegen step
 * would create a SECOND generated artifact to keep in sync with the first one,
 * and this repo already pays that price once (openapi.json ↔ schema.d.ts).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** A parsed JSON object. The openapi document is validated lazily, on access. */
export type JsonObject = Record<string, unknown>;

/** Anything wrong with the contract file: missing, malformed, unresolvable $ref. */
export class OpenApiError extends Error {
  override readonly name = 'OpenApiError';
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface OpenApiDocument {
  /** Where the document came from — quoted in every error message. */
  readonly source: string;
  readonly paths: JsonObject;
  readonly schemas: JsonObject;
}

/**
 * Default location of the contract, relative to the COMPILED module.
 *
 * The `../` count is tied to `outDir: dist` (tsconfig.build.json): this module
 * ships as `packages/mcp-server/dist/openapi.js`, so three levels up is the repo
 * root. Moving the package or changing `outDir` breaks this path — which is why
 * `BUDGET_OPENAPI_PATH` exists and why a missing file fails loudly at startup.
 * Running from `src/` resolves identically (same depth).
 */
const DEFAULT_OPENAPI_URL = new URL('../../../apps/api/openapi.json', import.meta.url);

export function resolveOpenApiPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.BUDGET_OPENAPI_PATH;
  return override !== undefined && override !== '' ? override : fileURLToPath(DEFAULT_OPENAPI_URL);
}

/** Parse + validate the top-level shape. Deeper nodes are checked where used. */
export function parseOpenApiDocument(text: string, source: string): OpenApiDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new OpenApiError(`${source} is not valid JSON: ${reason}`);
  }
  if (!isJsonObject(parsed)) {
    throw new OpenApiError(`${source} does not contain an OpenAPI document`);
  }
  const paths = parsed.paths;
  if (!isJsonObject(paths)) {
    throw new OpenApiError(`${source} has no "paths" object`);
  }
  const components = parsed.components;
  const schemas = isJsonObject(components) && isJsonObject(components.schemas) ? components.schemas : {};
  return { source, paths, schemas };
}

export function loadOpenApiDocument(env: NodeJS.ProcessEnv = process.env): OpenApiDocument {
  const path = resolveOpenApiPath(env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new OpenApiError(
      `cannot read the API contract at ${path} (${reason}) — run \`pnpm openapi\` at the repo root, ` +
        'or point BUDGET_OPENAPI_PATH at apps/api/openapi.json',
    );
  }
  return parseOpenApiDocument(text, path);
}

const SCHEMA_REF_PREFIX = '#/components/schemas/';

/** Only local component schemas are resolvable — nothing else is emitted by FastAPI. */
export function resolveRef(doc: OpenApiDocument, ref: string): JsonObject {
  if (!ref.startsWith(SCHEMA_REF_PREFIX)) {
    throw new OpenApiError(`unsupported $ref "${ref}" (only ${SCHEMA_REF_PREFIX}* is resolvable)`);
  }
  const name = ref.slice(SCHEMA_REF_PREFIX.length);
  const target = doc.schemas[name];
  if (!isJsonObject(target)) {
    throw new OpenApiError(`unknown $ref "${ref}" — schema "${name}" is not in ${doc.source}`);
  }
  return target;
}

/** The operation object for a (path, method) pair, or `undefined` if absent. */
export function getOperation(doc: OpenApiDocument, path: string, method: string): JsonObject | undefined {
  const item = doc.paths[path];
  if (!isJsonObject(item)) return undefined;
  const operation = item[method.toLowerCase()];
  return isJsonObject(operation) ? operation : undefined;
}
