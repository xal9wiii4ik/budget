/**
 * The thin HTTP layer: turn a BuiltTool + arguments into one Budget API call and
 * turn whatever comes back into something a model can act on.
 *
 * API failures are returned, never thrown: an MCP tool error (`isError: true`)
 * puts the reason in front of the model, which can then fix the call itself. A
 * thrown exception would only surface as a protocol error the model cannot read.
 */

import type { BuiltTool } from './tools.js';

const DEFAULT_API_URL = 'http://localhost:8010';
const TIMEOUT_MS = 30_000;

export interface ApiConfig {
  /** No trailing slash. */
  readonly baseUrl: string;
  readonly token: string;
}

/** Missing or unusable environment — a startup failure, not a tool failure. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export function readApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const token = env.BUDGET_PAT?.trim();
  if (token === undefined || token === '') {
    throw new ConfigError(
      'BUDGET_PAT is not set — issue a personal access token in the web app (Settings; the ' +
        'value is shown exactly once) and pass it to this server as BUDGET_PAT.',
    );
  }
  const baseUrl = (env.BUDGET_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, '');
  return { baseUrl, token };
}

export type ApiResult = { readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly message: string };

/**
 * Detail codes worth translating. Everything else is passed through verbatim —
 * an unknown code is more useful to the model than a guessed paraphrase.
 */
const CODE_MESSAGES: Readonly<Record<string, string>> = {
  TOKEN_INVALID:
    'The API token is invalid or revoked — issue a new token in the web app (Settings) and update BUDGET_PAT.',
  TOKEN_SCOPE_READONLY:
    'This token is read-only — create a `full` token in the web app (Settings) to make changes.',
  TOKEN_ENDPOINT_FORBIDDEN: 'That endpoint is not available to API tokens.',
  RATE_LIMITED: 'Too many API calls — wait a minute before trying again.',
};

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function formatValidationErrors(detail: readonly unknown[]): string | undefined {
  const lines: string[] = [];
  for (const entry of detail) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const record = entry as Record<string, unknown>;
    const msg = record.msg;
    if (typeof msg !== 'string') return undefined;
    const loc = Array.isArray(record.loc) ? record.loc.map((part) => String(part)).join('.') : 'request';
    lines.push(`  - ${loc}: ${msg}`);
  }
  if (lines.length === 0) return undefined;
  return `The Budget API rejected the arguments:\n${lines.join('\n')}`;
}

export function describeApiError(status: number, text: string): string {
  const body = parseJson(text);
  const detail = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).detail : undefined;

  if (typeof detail === 'string') {
    const mapped = CODE_MESSAGES[detail];
    if (mapped !== undefined) return mapped;
    // No-oracle: "not yours" and "does not exist" answer identically on purpose,
    // and this text must not split them apart either.
    if (detail.endsWith('_NOT_FOUND')) return `${detail}: not found (it does not exist, or it is not yours).`;
    return `The Budget API rejected the call (HTTP ${status}): ${detail}`;
  }
  if (Array.isArray(detail)) {
    const formatted = formatValidationErrors(detail);
    if (formatted !== undefined) return formatted;
  }
  if (status === 429) return CODE_MESSAGES.RATE_LIMITED;
  return `The Budget API returned HTTP ${status}: ${text.trim() === '' ? '(empty body)' : text.slice(0, 500)}`;
}

function describeTransportFailure(error: unknown, baseUrl: string): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `The Budget API at ${baseUrl} did not answer within ${TIMEOUT_MS / 1000}s.`;
  }
  return `Cannot reach the Budget API at ${baseUrl} — is the server running?`;
}

async function send(
  config: ApiConfig,
  method: string,
  url: string,
  body: Record<string, unknown> | undefined,
): Promise<ApiResult> {
  let status: number;
  let text: string;
  try {
    const response = await fetch(url, {
      method: method.toUpperCase(),
      headers: {
        authorization: `Bearer ${config.token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = response.status;
    text = await response.text();
  } catch (error) {
    return { ok: false, message: describeTransportFailure(error, config.baseUrl) };
  }

  if (status >= 200 && status < 300) {
    if (text.trim() === '') return { ok: true, data: null };
    const data = parseJson(text);
    if (data === undefined) return { ok: false, message: `The Budget API returned a non-JSON body (HTTP ${status}).` };
    return { ok: true, data };
  }
  return { ok: false, message: describeApiError(status, text) };
}

/** Fill `{placeholders}`, build the query string, split off the JSON body. */
export async function callTool(
  config: ApiConfig,
  tool: BuiltTool,
  args: Readonly<Record<string, unknown>>,
): Promise<ApiResult> {
  let path = tool.path;
  for (const name of tool.pathParams) {
    const value = args[name];
    if (value === undefined || value === null) {
      return { ok: false, message: `Missing required argument "${name}".` };
    }
    path = path.replace(`{${name}}`, encodeURIComponent(String(value)));
  }

  const url = new URL(config.baseUrl + path);
  for (const name of tool.queryParams) {
    const value = args[name];
    if (value === undefined || value === null) continue;
    url.searchParams.set(name, String(value));
  }

  let body: Record<string, unknown> | undefined;
  if (tool.bodyProps.length > 0) {
    body = {};
    for (const name of tool.bodyProps) {
      const value = args[name];
      if (value !== undefined) body[name] = value;
    }
  }

  return send(config, tool.method, url.toString(), body);
}

export type TokenSelf = { readonly id: string; readonly scope: 'read' | 'full' };

/**
 * Startup self-introspection (architecture §4): validates the token AND tells us
 * which tools to publish. The only `/tokens/*` route a token may call.
 */
export async function fetchTokenSelf(config: ApiConfig): Promise<
  { readonly ok: true; readonly self: TokenSelf } | { readonly ok: false; readonly message: string }
> {
  const result = await send(config, 'get', `${config.baseUrl}/tokens/self`, undefined);
  if (!result.ok) return result;

  const data = result.data;
  const record = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
  const { id, scope } = record;
  if (typeof id !== 'string' || (scope !== 'read' && scope !== 'full')) {
    return {
      ok: false,
      message:
        'GET /tokens/self did not answer with {id, scope} — BUDGET_API_URL may point at something ' +
        'other than the Budget API, or the API predates personal access tokens.',
    };
  }
  return { ok: true, self: { id, scope } };
}
