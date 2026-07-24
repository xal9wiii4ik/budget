// PLATFORM-FREE MODULE — do NOT reference web/DOM globals here (AM-2, mobile
// constraint 1). No `window`, `document`, `localStorage`, `sessionStorage`,
// `navigator`, or any DOM/browser API may appear in this file. These helpers
// operate ONLY on plain arguments and returned values so the React Native client
// (task 1.8, which has none of those globals) reuses them unchanged. This is the
// cohesive, platform-free error module: result-unwrapping (`ApiError` +
// `throwOnError`) plus envelope-narrowing (`getValidationIssues`/`locTailField`/
// `routeIssue`). The senior greps this file at diff review — any web global here
// is an automatic send-back.

/**
 * Error thrown by `throwOnError` when an openapi-fetch call resolves to a non-2xx
 * response. openapi-fetch does NOT throw on HTTP errors (it returns
 * `{ data, error, response }`), so query/mutation functions funnel through
 * `throwOnError` to give TanStack Query a real thrown error carrying the status
 * and the parsed error body (for `getErrorCode`).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`API request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

type FetchResult<T> = {
  data?: T;
  error?: unknown;
  response: Response;
};

/**
 * Unwrap an openapi-fetch result: return `data` on success, else throw an
 * `ApiError` carrying the status + parsed error body.
 */
export async function throwOnError<T>(promise: Promise<FetchResult<T>>): Promise<T> {
  const { data, error, response } = await promise;
  if (!response.ok || error !== undefined || data === undefined) {
    throw new ApiError(response.status, error);
  }
  return data;
}

export interface ValidationIssue {
  loc: (string | number)[];
  msg: string;
}

/** Where a mutation error should surface: a named form field, or the form root. */
export type FieldError<F extends string> = { field: F | 'form'; message: string };

/**
 * Runtime narrow of a parsed error body to FastAPI's ValidationError[] arm.
 * Returns the issues when `detail` is a non-empty array of `{loc, msg}`; returns
 * `undefined` for the string-code arm, an object detail, or a non-object body.
 */
export function getValidationIssues(body: unknown): ValidationIssue[] | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const detail = (body as { detail?: unknown }).detail;
  if (!Array.isArray(detail)) return undefined;

  const issues: ValidationIssue[] = [];
  for (const raw of detail) {
    if (typeof raw !== 'object' || raw === null) continue;
    const loc = (raw as { loc?: unknown }).loc;
    const msg = (raw as { msg?: unknown }).msg;
    if (Array.isArray(loc) && typeof msg === 'string') {
      const cleanLoc = loc.filter(
        (p): p is string | number => typeof p === 'string' || typeof p === 'number',
      );
      issues.push({ loc: cleanLoc, msg });
    }
  }
  return issues.length > 0 ? issues : undefined;
}

/**
 * The trailing STRING segment of a ValidationError `loc` (the field name), ignoring
 * the leading `"body"` wrapper FastAPI prepends. Returns `undefined` when the loc
 * carries no field-level segment (e.g. a whole-body error).
 */
export function locTailField(loc: (string | number)[]): string | undefined {
  for (let i = loc.length - 1; i >= 0; i -= 1) {
    const part = loc[i];
    if (typeof part === 'string' && part !== 'body') return part;
  }
  return undefined;
}

// Finds the first issue whose loc tail maps to one of `fields`, returning the
// mapped field + its server message.
export function routeIssue<F extends string>(
  issues: ValidationIssue[],
  fields: readonly F[],
): FieldError<F> | undefined {
  for (const issue of issues) {
    const tail = locTailField(issue.loc);
    if (tail && (fields as readonly string[]).includes(tail)) {
      return { field: tail as F, message: issue.msg };
    }
  }
  return undefined;
}
