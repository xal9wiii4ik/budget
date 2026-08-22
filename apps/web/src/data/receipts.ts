// Receipts data layer (S5). Three writes and one poll:
//
//   POST /receipts            -> id + presigned PUT           (api-client)
//   PUT  <presigned url>      -> the downscaled JPEG          (RAW fetch)
//   POST /receipts/{id}/parse -> 202, status=processing       (api-client)
//   GET  /receipts/{id}       -> polled until terminal        (api-client)
//
// The PUT is the ONE call that does not go through the generated client, and
// deliberately so: it targets external object storage, not our API — no bearer
// (the signature IS the credential; an Authorization header would be a leak), no
// 401->refresh retry, and no path in the OpenAPI document to type it against.
//
// The receipt row IS server state, so the poll is a real query and never a
// fetch-in-useEffect loop; the ~60s give-up lives in the pure `pollInterval`
// (shared with the flow hook's derivation so both agree on when time is up).
import type { components } from '@budget/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { pollInterval } from '../features/receipts/pollInterval';
import { apiClient } from '../lib/api';
import { ApiError, throwOnError } from '../lib/query';
import { qk } from './queryKeys';

type PresignedUpload = components['schemas']['PresignedUpload'];
export type ReceiptRead = components['schemas']['ReceiptRead'];

export function useCreateReceipt() {
  return useMutation({
    mutationFn: () => throwOnError(apiClient.POST('/receipts', {})),
  });
}

/**
 * Raw PUT of the JPEG to the presigned URL. `upload.headers` is a plain
 * string->string map on the contract (R7a), so it is passed to fetch as-is —
 * no cast. It is ADVISORY: storage signs the host only (senior-lead V1), so a
 * mismatch cannot 403 here; the real size gate is the server's parse-time HEAD.
 *
 * A non-2xx becomes an ApiError with no body, which `describeReceiptError` maps
 * to the generic message — storage returns XML, not our {detail: CODE} envelope,
 * so there is nothing honest to decode from it.
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

export function useParseReceipt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (receiptId: string) =>
      throwOnError(
        apiClient.POST('/receipts/{receipt_id}/parse', {
          params: { path: { receipt_id: receiptId } },
        }),
      ),
    // Seed the poll cache from the 202 body so the first polling render already
    // has a status instead of flashing an empty panel.
    onSuccess: (receipt) => {
      queryClient.setQueryData(qk.receipt(receipt.id), receipt);
    },
  });
}

/**
 * One receipt, read once (transaction-details-and-i18n S3): the transaction form
 * shows what is attached to the row being edited. Same `['receipts', id]` entry
 * the capture flow polls — deliberately, so opening the form right after an
 * upload is a cache hit — but WITHOUT the poll's zero staleTime: a receipt this
 * form looks at is already terminal, and re-fetching it on every render of the
 * modal would buy nothing.
 *
 * `null` (the row has no photo) disables the query rather than firing a request
 * with a guessed id.
 */
export function useReceipt(receiptId: string | null) {
  return useQuery<ReceiptRead>({
    queryKey: qk.receipt(receiptId ?? ''),
    queryFn: () =>
      throwOnError(
        apiClient.GET('/receipts/{receipt_id}', {
          params: { path: { receipt_id: receiptId ?? '' } },
        }),
      ),
    enabled: receiptId !== null,
    staleTime: 60_000,
  });
}

/**
 * The poll. `receiptId === null` disables it (the hook calls this
 * unconditionally, as hooks require). `startedAt` is when polling began — the
 * deadline is measured from there, not from the component mount.
 */
export function useReceiptPoll(receiptId: string | null, startedAt: number) {
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
    // A poll must never serve a cached row as fresh, and the entry is worthless
    // the moment the modal closes (which also removes it explicitly).
    staleTime: 0,
    gcTime: 30_000,
    refetchInterval: (query) =>
      // An errored poll stops: the flow surfaces the failure with its own retry,
      // and a query that keeps firing behind an error message is a lie.
      query.state.status === 'error'
        ? false
        : pollInterval(query.state.data?.status, Date.now() - startedAt),
  });
}
