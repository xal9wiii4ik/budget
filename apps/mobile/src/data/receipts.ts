// Receipts data layer (mobile-catchup-2). Two writes and one read:
//
//   POST /receipts        -> id + presigned PUT     (api-client)
//   PUT  <presigned url>  -> the picked JPEG        (RAW fetch)
//   GET  /receipts/{id}   -> the row, incl. view_url (api-client)
//
// Copy of web data/receipts.ts MINUS the parse mutation and the poll: attaching a
// photo to an operation is not scanning it (there is no OCR flow on mobile), so
// nothing here calls the parser and the app works with no AI key at all.
//
// The PUT is the ONE call that does not go through the generated client, and
// deliberately so: it targets external object storage, not our API — no bearer
// (the signature IS the credential; an Authorization header would be a leak), no
// 401->refresh retry, and no path in the OpenAPI document to type it against.
import type { components } from '@budget/api-client';
import { ApiError, throwOnError } from '@budget/api-client';
import { useMutation, useQuery } from '@tanstack/react-query';

import { apiClient } from '../lib/api';
import { qk } from './queryKeys';

type PresignedUpload = components['schemas']['PresignedUpload'];
export type ReceiptRead = components['schemas']['ReceiptRead'];

/**
 * The server's cap on an uploaded file (`receipt_max_bytes`). Checked on the
 * device BEFORE the upload starts: a phone photo can be several megabytes, and
 * finding out after a slow mobile upload that storage refused it is the worst
 * possible place to learn it.
 */
export const RECEIPT_MAX_BYTES = 5_000_000;

export function useCreateReceipt() {
  return useMutation({
    mutationFn: () => throwOnError(apiClient.POST('/receipts', {})),
  });
}

/**
 * Raw PUT of the image to the presigned URL. `upload.headers` is a plain
 * string->string map on the contract, so it is passed to fetch as-is — no cast,
 * nothing added. It is ADVISORY: storage signs the host only, so a mismatch
 * cannot 403 here; the real size gate is the server's own check.
 *
 * A non-2xx becomes an ApiError with no body — storage returns XML, not our
 * {detail: CODE} envelope, so there is nothing honest to decode from it, and the
 * caller shows its generic "upload failed, try again".
 */
export async function uploadToPresigned(upload: PresignedUpload, blob: Blob): Promise<void> {
  const response = await fetch(upload.url, {
    method: upload.method,
    headers: upload.headers,
    body: blob,
  });
  if (!response.ok) {
    throw new ApiError(response.status, undefined);
  }
}

/**
 * One receipt, read once: the transaction form shows what is attached to the row
 * being edited — its `view_url` is a per-read presigned GET (TTL 300 s), which is
 * why this is fetched fresh rather than remembered.
 *
 * `null` (the row has no photo) disables the query rather than firing a request
 * with a guessed id. An error is NOT the user's problem: the link is stored on
 * the transaction either way, so the field degrades to a "photo attached" line.
 */
export function useReceipt(receiptId: string | null) {
  return useQuery<ReceiptRead>({
    queryKey: qk.receipt(receiptId ?? ''),
    queryFn: () =>
      throwOnError(
        apiClient.GET('/receipts/{receipt_id}', {
          // Non-null by construction: the query only runs while enabled.
          params: { path: { receipt_id: receiptId ?? '' } },
        }),
      ),
    enabled: receiptId !== null,
    // Shorter than the 300 s URL TTL, so a form left open re-reads the row (and
    // with it a fresh view_url) instead of rendering an expired link.
    staleTime: 120_000,
  });
}
