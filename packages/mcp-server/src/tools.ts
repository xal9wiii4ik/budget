/**
 * Generator: one flat MCP input schema per allowlist entry, built from the
 * openapi operation (path/query parameters + JSON request body).
 *
 * Flat on purpose: a model fills `{transaction_id, amount_minor}` far more
 * reliably than `{transaction_id, body: {...}}`, and the only real risk of
 * flattening — a body property colliding with a parameter name — is caught at
 * startup rather than silently shadowing one of them.
 *
 * Every problem found while building is COLLECTED, not thrown on the spot: a
 * contract drift usually breaks several tools at once and the operator wants the
 * whole list in one go.
 */

import {
  getOperation,
  isJsonObject,
  OpenApiError,
  resolveRef,
  type JsonObject,
  type OpenApiDocument,
} from './openapi.js';
import type { ManagedBodyValue, ToolScope, ToolSpec } from './allowlist.js';

export interface ToolInputSchema extends JsonObject {
  type: 'object';
  properties: JsonObject;
  required: string[];
  additionalProperties: false;
}

export interface BuiltTool {
  readonly name: string;
  readonly description: string;
  readonly scope: ToolScope;
  readonly method: string;
  readonly path: string;
  readonly inputSchema: ToolInputSchema;
  /** Filled into the `{placeholders}` of `path`. */
  readonly pathParams: readonly string[];
  /** Serialised into the query string. */
  readonly queryParams: readonly string[];
  /** Serialised into the JSON request body, taken from the model's arguments. */
  readonly bodyProps: readonly string[];
  /**
   * Body properties kept OUT of `inputSchema` and filled by the package itself
   * (`ToolSpec.managedBody`): property name → how `http.ts` produces the value.
   * They exist here and nowhere else, so the call layer never needs to know
   * which tool it is serving.
   */
  readonly managedBody: Readonly<Record<string, ManagedBodyValue>>;
}

/** Allowlist ↔ contract drift. Carries every failure, not just the first. */
export class ToolBuildError extends Error {
  override readonly name = 'ToolBuildError';
  readonly errors: readonly string[];

  constructor(errors: readonly string[]) {
    super(
      'the tool allowlist is out of sync with openapi.json — regenerate the contract ' +
        '(`pnpm openapi` at the repo root) and rebuild:\n' +
        errors.map((line) => `  - ${line}`).join('\n'),
    );
    this.errors = errors;
  }
}

const JSON_CONTENT_TYPE = 'application/json';

function omit(source: JsonObject, keys: readonly string[]): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(source)) {
    if (!keys.includes(key)) result[key] = value;
  }
  return result;
}

function isNullBranch(branch: unknown): boolean {
  return isJsonObject(branch) && branch.type === 'null';
}

/**
 * Inline `$ref`s and simplify the schema for a model audience.
 *
 * - `title` goes away (pydantic emits "Amount Minor" for every field — noise);
 * - a component's own `title`/`description` describe the COMPONENT, not the
 *   field that references it, so they are dropped on inlining;
 * - `anyOf: [X, {type: 'null'}]` collapses to `X`. [TRADE-OFF, plan S3.2] this
 *   also removes the ability to send an explicit `null`, i.e. to CLEAR a field
 *   in PATCH; in v1 omit = keep and there is no clearing through MCP.
 *
 * `format`, `pattern`, `enum`, `minimum`, `maximum` and `default` survive — they
 * are the only machine-readable hints the model gets.
 */
function normalizeSchema(doc: OpenApiDocument, schema: unknown, seenRefs: ReadonlySet<string>): JsonObject {
  if (!isJsonObject(schema)) {
    throw new OpenApiError(`expected a schema object, got ${JSON.stringify(schema)}`);
  }
  let current = schema;
  let seen = seenRefs;

  const ref = current.$ref;
  if (typeof ref === 'string') {
    if (seen.has(ref)) {
      throw new OpenApiError(`circular $ref "${ref}" cannot be flattened into a tool schema`);
    }
    seen = new Set(seen).add(ref);
    current = { ...omit(resolveRef(doc, ref), ['title', 'description']), ...omit(current, ['$ref']) };
  }

  const anyOf = current.anyOf;
  if (Array.isArray(anyOf)) {
    const branches = anyOf.filter((branch) => !isNullBranch(branch));
    if (branches.length === 1) {
      current = { ...omit(current, ['anyOf']), ...normalizeSchema(doc, branches[0], seen) };
    } else if (branches.length !== anyOf.length) {
      current = { ...current, anyOf: branches.map((branch) => normalizeSchema(doc, branch, seen)) };
    }
  }

  if (isJsonObject(current.properties)) {
    const properties: JsonObject = {};
    for (const [name, property] of Object.entries(current.properties)) {
      properties[name] = normalizeSchema(doc, property, seen);
    }
    current = { ...current, properties };
  }
  if (current.items !== undefined) {
    current = { ...current, items: normalizeSchema(doc, current.items, seen) };
  }

  return omit(current, ['title']);
}

/**
 * A managed property must be something the package can actually produce: the
 * check is what turns "the contract retyped client_id" from a silent 422 on the
 * user's first write into a startup error next to every other drift.
 */
function managedValueProblem(kind: ManagedBodyValue, schema: JsonObject): string | undefined {
  if (kind === 'uuid' && schema.type !== 'string') {
    return `is filled with a generated uuid, but the contract types it as ${JSON.stringify(schema.type)}`;
  }
  return undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

interface Accumulator {
  readonly properties: JsonObject;
  readonly required: string[];
  /** Property name → where it came from, for the collision message. */
  readonly origins: Map<string, string>;
  readonly pathParams: string[];
  readonly queryParams: string[];
  readonly bodyProps: string[];
}

function buildOne(doc: OpenApiDocument, spec: ToolSpec, errors: string[]): BuiltTool | undefined {
  const label = `${spec.name} (${spec.method.toUpperCase()} ${spec.path})`;
  const operation = getOperation(doc, spec.path, spec.method);
  if (operation === undefined) {
    errors.push(`${label}: no such path+method in the contract`);
    return undefined;
  }

  const acc: Accumulator = {
    properties: {},
    required: [],
    origins: new Map(),
    pathParams: [],
    queryParams: [],
    bodyProps: [],
  };
  let failed = false;
  const managedBody = spec.managedBody ?? {};
  /** Managed names actually found in the body — the rest are drift (below). */
  const managedFound = new Set<string>();

  const add = (name: string, schema: JsonObject, required: boolean, origin: string): void => {
    const previous = acc.origins.get(name);
    if (previous !== undefined) {
      errors.push(`${label}: "${name}" is both a ${previous} and a ${origin} — flattening would shadow one of them`);
      failed = true;
      return;
    }
    acc.origins.set(name, origin);
    acc.properties[name] = schema;
    if (required) acc.required.push(name);
  };

  try {
    const parameters = operation.parameters;
    if (Array.isArray(parameters)) {
      for (const parameter of parameters) {
        if (!isJsonObject(parameter) || typeof parameter.name !== 'string' || typeof parameter.in !== 'string') {
          errors.push(`${label}: malformed parameter entry ${JSON.stringify(parameter)}`);
          failed = true;
          continue;
        }
        const name = parameter.name;
        if (parameter.in !== 'path' && parameter.in !== 'query') {
          // A header/cookie parameter would need a value the model cannot know;
          // losing it silently would send a broken request. Fail instead.
          errors.push(`${label}: unsupported "${parameter.in}" parameter "${name}" — only path and query are supported`);
          failed = true;
          continue;
        }
        const schema = normalizeSchema(doc, parameter.schema ?? {}, new Set());
        if (typeof parameter.description === 'string' && schema.description === undefined) {
          schema.description = parameter.description;
        }
        add(name, schema, parameter.required === true, `${parameter.in} parameter`);
        if (parameter.in === 'path') acc.pathParams.push(name);
        else acc.queryParams.push(name);
      }
    }

    const requestBody = operation.requestBody;
    if (isJsonObject(requestBody)) {
      const content = requestBody.content;
      const media = isJsonObject(content) ? content[JSON_CONTENT_TYPE] : undefined;
      if (!isJsonObject(media) || media.schema === undefined) {
        errors.push(`${label}: request body has no ${JSON_CONTENT_TYPE} schema`);
        failed = true;
      } else {
        const body = normalizeSchema(doc, media.schema, new Set());
        if (!isJsonObject(body.properties)) {
          errors.push(`${label}: request body is not an object schema with properties`);
          failed = true;
        } else {
          const bodyRequired = new Set(readStringArray(body.required));
          for (const [name, property] of Object.entries(body.properties)) {
            if (!isJsonObject(property)) {
              errors.push(`${label}: body property "${name}" is not a schema object`);
              failed = true;
              continue;
            }
            const managed = managedBody[name];
            if (managed !== undefined) {
              // Deliberately NOT added to the schema: a property the package
              // fills must be invisible to the model, or the model can forge it.
              managedFound.add(name);
              const problem = managedValueProblem(managed, property);
              if (problem !== undefined) {
                errors.push(`${label}: managed body property "${name}" ${problem}`);
                failed = true;
              }
              continue;
            }
            add(name, property, bodyRequired.has(name), 'body property');
            acc.bodyProps.push(name);
          }
        }
      }
    }
  } catch (error) {
    if (!(error instanceof OpenApiError)) throw error;
    errors.push(`${label}: ${error.message}`);
    return undefined;
  }

  for (const name of Object.keys(managedBody)) {
    if (managedFound.has(name)) continue;
    errors.push(`${label}: managed body property "${name}", which the request body does not have`);
    failed = true;
  }

  for (const [name, description] of Object.entries(spec.params ?? {})) {
    const schema = acc.properties[name];
    if (!isJsonObject(schema)) {
      errors.push(`${label}: curated description for "${name}", which the operation does not accept`);
      failed = true;
      continue;
    }
    schema.description = description;
  }

  if (failed) return undefined;

  return {
    name: spec.name,
    description: spec.description,
    scope: spec.scope,
    method: spec.method,
    path: spec.path,
    inputSchema: {
      type: 'object',
      properties: acc.properties,
      required: acc.required,
      additionalProperties: false,
    },
    pathParams: acc.pathParams,
    queryParams: acc.queryParams,
    bodyProps: acc.bodyProps,
    managedBody,
  };
}

/** The scope of the PAT this process is running with (`GET /tokens/self`). */
export type TokenScope = 'read' | 'full';

/**
 * What a token of this scope may see. A read token is never shown a write tool
 * — including `delete_transaction`: the server would refuse the call anyway (it
 * is the only enforcement), but an advertised tool teaches the model to loop on
 * something that cannot succeed.
 */
export function toolsForScope(tools: readonly BuiltTool[], scope: TokenScope): BuiltTool[] {
  return tools.filter((tool) => scope === 'full' || tool.scope === 'read');
}

/** Build every tool or throw ONE error listing everything that is wrong. */
export function buildTools(doc: OpenApiDocument, specs: readonly ToolSpec[]): BuiltTool[] {
  const errors: string[] = [];
  const tools: BuiltTool[] = [];
  const names = new Set<string>();

  for (const spec of specs) {
    if (names.has(spec.name)) {
      errors.push(`${spec.name}: duplicate tool name in the allowlist`);
      continue;
    }
    names.add(spec.name);
    const tool = buildOne(doc, spec, errors);
    if (tool !== undefined) tools.push(tool);
  }

  if (errors.length > 0) throw new ToolBuildError(errors);
  return tools;
}
