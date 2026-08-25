/**
 * The one tool that is NOT generated from the contract.
 *
 * Every other tool is a thin wrapper over a single API call, built from
 * `openapi.json`. Uploading a receipt is three steps — create the row, PUT the
 * bytes straight to object storage, read the result back — and, crucially, it
 * touches the local filesystem. That is why it lives here as a hand-written
 * tool instead of an allowlist entry.
 *
 * WHY A PATH AND NOT THE BYTES. The scope was originally refused with "binary
 * flow, pointless over stdio", and for a naive design that is true: pushing an
 * image through the conversation costs context and money for nothing. But this
 * server is a LOCAL process on the user's machine — it can read the file
 * itself, and the model never sees a single byte. It sends a path and gets an
 * id back.
 *
 * WHY THE PATH IS FENCED. A tool that opens an arbitrary path is a new attack
 * surface: the server runs as the user, so it can read whatever the user can,
 * and a model that is confused — or that picked up an instruction from someone
 * else's document — could hand over `~/.ssh/id_rsa` just as easily as a
 * receipt. Three gates below, in order of how much they can be lied to:
 *
 *   1. the tool does not exist unless BUDGET_UPLOAD_DIR is configured, so the
 *      default posture is "no filesystem access at all";
 *   2. the resolved real path must sit inside that directory — resolved, so a
 *      symlink pointing outside is caught rather than followed;
 *   3. the CONTENT must be a JPEG. Extensions are trivially forged; the magic
 *      bytes are what the file actually is.
 */

import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

import { describeApiError, type ApiConfig } from './http.js';
import type { ToolInputSchema } from './tools.js';

/** The API stores one object per receipt as `.jpg` and advertises image/jpeg. */
const JPEG_MEDIA_TYPE = 'image/jpeg';

/**
 * 10 MB. Large enough for any phone photo of a receipt, small enough that a
 * mistaken path (a disk image, a database dump) is refused rather than pushed
 * into object storage.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export interface UploadConfig {
  /** Absolute, symlink-resolved. `null` disables the tool entirely. */
  readonly dir: string | null;
}

export async function readUploadConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<UploadConfig> {
  const raw = env.BUDGET_UPLOAD_DIR?.trim();
  if (raw === undefined || raw === '') return { dir: null };
  if (!isAbsolute(raw)) {
    throw new Error(
      `BUDGET_UPLOAD_DIR must be an absolute path, got "${raw}". ` +
        'A relative path would depend on where the client happened to launch this server.',
    );
  }
  // Resolve the directory ONCE at startup so that every later containment check
  // compares two real paths. Without this, a symlinked upload dir would make
  // every legitimate file look like it is outside the fence.
  const dir = await realpath(raw).catch(() => {
    throw new Error(`BUDGET_UPLOAD_DIR points at "${raw}", which does not exist.`);
  });
  return { dir };
}

/** JPEG starts FF D8 FF; nothing else this server accepts does. */
export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * True when `candidate` is the directory itself or sits underneath it. The
 * separator matters: without it `/home/user/uploads-evil` passes a naive
 * `startsWith('/home/user/uploads')`.
 */
export function isInside(dir: string, candidate: string): boolean {
  return candidate === dir || candidate.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

export type PathResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly message: string };

/**
 * Resolve the model's path against the fence. Returns a message the assistant
 * can read out loud rather than throwing: a refused path is a normal answer
 * ("that file is outside the folder you allowed"), not a server fault.
 */
export async function resolveUploadPath(dir: string, input: string): Promise<PathResult> {
  const requested = isAbsolute(input) ? input : resolve(dir, input);
  // realpath collapses `..` AND follows symlinks, so both escape routes end up
  // compared against the fence rather than the string the model supplied.
  const real = await realpath(requested).catch(() => null);
  if (real === null) {
    return { ok: false, message: `No file at "${input}".` };
  }
  if (!isInside(dir, real)) {
    return {
      ok: false,
      message:
        `"${input}" resolves outside the allowed upload folder (${dir}). ` +
        'Move the file there, or ask the user to widen BUDGET_UPLOAD_DIR.',
    };
  }
  return { ok: true, path: real };
}

export const UPLOAD_TOOL_NAME = 'upload_receipt';

export const UPLOAD_TOOL_INPUT_SCHEMA: ToolInputSchema = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description:
        'Path to a JPEG file the USER pointed at — a photo or screenshot of a receipt. ' +
        'Take it from what the user actually said; never guess a path, never walk the ' +
        'filesystem looking for one. Relative paths resolve inside the allowed upload folder.',
    },
  },
  required: ['path'],
  additionalProperties: false,
};

export const UPLOAD_TOOL_DESCRIPTION =
  'Upload a receipt image (JPEG) from a local file and return its receipt id. ' +
  'The file is read by this server and sent straight to storage — the image never ' +
  'passes through the conversation. Use the returned id as `receipt_id` when creating ' +
  'or updating a transaction, which is what attaches the photo to a spend. ' +
  'This tool does NOT read the receipt: extracting a total or a merchant from the image ' +
  'happens in the app, not here, so do not claim to have read what it says. ' +
  'Only JPEG is accepted, because that is the single format the receipt storage keeps.';

export type UploadResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly message: string };

interface CreatedReceipt {
  readonly id: string;
  readonly upload: { readonly url: string; readonly headers?: Record<string, string> };
}

function isCreatedReceipt(value: unknown): value is CreatedReceipt {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as { id?: unknown; upload?: { url?: unknown } };
  return typeof row.id === 'string' && typeof row.upload?.url === 'string';
}

/**
 * Create the receipt row, push the bytes, hand back what the API says about it.
 *
 * The order is the API's own: the row is durable before a URL is signed, so a
 * failed PUT leaves a `pending` receipt rather than a signed URL with nothing
 * behind it. A pending receipt attached to nothing is harmless — which is why
 * this flow needs no retry bookkeeping.
 */
export async function uploadReceipt(
  config: ApiConfig,
  upload: UploadConfig,
  rawPath: unknown,
): Promise<UploadResult> {
  if (upload.dir === null) {
    return {
      ok: false,
      message:
        'Receipt upload is switched off: BUDGET_UPLOAD_DIR is not set. ' +
        'The user has to name a folder this server may read from before files can be uploaded.',
    };
  }
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    return { ok: false, message: 'Give the path to a JPEG file.' };
  }

  const resolved = await resolveUploadPath(upload.dir, rawPath.trim());
  if (!resolved.ok) return resolved;

  const info = await stat(resolved.path);
  if (!info.isFile()) {
    return { ok: false, message: `"${rawPath}" is not a file.` };
  }
  if (info.size > MAX_UPLOAD_BYTES) {
    const mb = (info.size / (1024 * 1024)).toFixed(1);
    return {
      ok: false,
      message: `That file is ${mb} MB; receipts are capped at ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`,
    };
  }

  const bytes = await readFile(resolved.path);
  if (!isJpeg(bytes)) {
    return {
      ok: false,
      message:
        `"${rawPath}" is not a JPEG (checked its contents, not its name). ` +
        'Save the photo as JPEG and try again.',
    };
  }

  const created = await fetchJson(config, 'POST', '/receipts');
  if (!created.ok) return created;
  if (!isCreatedReceipt(created.data)) {
    return { ok: false, message: 'The API did not return an upload target for this receipt.' };
  }

  const put = await fetch(created.data.upload.url, {
    method: 'PUT',
    // Content-Type here is advisory — the presigned signature covers the host
    // only (see services/storage.py) — but sending what the API advertised
    // keeps the stored object honest about itself.
    headers: { 'Content-Type': created.data.upload.headers?.['Content-Type'] ?? JPEG_MEDIA_TYPE },
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(60_000),
  }).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));

  if (put instanceof Error) {
    return { ok: false, message: `Could not upload the image to storage: ${put.message}` };
  }
  if (!put.ok) {
    return {
      ok: false,
      message: `Storage refused the upload (HTTP ${put.status}). The receipt row exists but has no image.`,
    };
  }

  // Read the row back so the assistant reports what the server knows, not what
  // this function hopes happened.
  const read = await fetchJson(config, 'GET', `/receipts/${created.data.id}`);
  return read.ok ? { ok: true, data: read.data } : { ok: true, data: { id: created.data.id } };
}

async function fetchJson(
  config: ApiConfig,
  method: string,
  path: string,
): Promise<UploadResult> {
  const response = await fetch(`${config.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  }).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));

  if (response instanceof Error) {
    return { ok: false, message: `The Budget API at ${config.baseUrl} did not answer: ${response.message}` };
  }
  const text = await response.text();
  if (!response.ok) {
    return { ok: false, message: describeApiError(response.status, text) };
  }
  try {
    return { ok: true, data: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, message: 'The Budget API returned a body that is not JSON.' };
  }
}
