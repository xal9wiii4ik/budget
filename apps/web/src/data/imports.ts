// Statement imports data layer (statement-import S4).
//
// A preview session is server state from the first byte: the upload PARSES the
// file server-side (cp1251 decoding, matching, category suggestions — none of it
// reproducible in a browser), and every decision the user makes is a PATCH whose
// response is the new truth about that row. So nothing here is mirrored into
// component state, and no number on the screen is ever computed from another —
// the counters, the money and the report all arrive as server fields.
//
// Two shapes of write, two invalidation strategies, and the difference matters
// at a thousand rows:
//
//   * PATCH one row answers with the UPDATED row (§10.3). It is written into the
//     cached pages IN PLACE and the rows query is NOT invalidated — invalidating
//     an infinite query refetches every page that has been loaded, which on a
//     year's statement would be five requests per click. Only the SESSION is
//     invalidated: its counters (what apply will do) are the one thing a row
//     patch really moves and the one thing the client may not recompute.
//   * bulk-decision moves every row of one match status at once and answers with
//     the SESSION. There is no per-row response to write back, so this one does
//     invalidate the whole rows family of that import — one refetch for one
//     deliberate action, instead of a thousand clicks.
//
// apply/replace are batch MONEY writes: they go through
// `invalidateAfterBulkTxWrite` (data/transactions.ts) so the key grammar of the
// transaction families keeps living in one file, plus the import's own family
// because the session's status and counters moved with them.
import type { components } from '@budget/api-client';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';

import { apiClient } from '../lib/api';
import { ApiError, throwOnError } from '../lib/query';
import { invalidateAfterBulkTxWrite } from './transactions';
import { qk } from './queryKeys';

export type StatementImportRead = components['schemas']['StatementImportRead'];
export type StatementRowRead = components['schemas']['StatementRowRead'];
export type StatementRowList = components['schemas']['StatementRowList'];
export type StatementRowCandidate = components['schemas']['StatementRowCandidate'];
export type StatementRowDecision = components['schemas']['StatementRowDecision'];
export type StatementRowMatchStatus = components['schemas']['StatementRowMatchStatus'];
export type StatementRowPatch = components['schemas']['StatementRowPatch'];
export type StatementApplyReport = components['schemas']['StatementApplyReport'];
export type StatementReplaceReport = components['schemas']['StatementReplaceReport'];
export type StatementReplacePreview = components['schemas']['StatementReplacePreview'];
export type StatementImportStatus = components['schemas']['StatementImportStatus'];
export type StatementFormatsRead = components['schemas']['StatementFormatsRead'];

/**
 * The formats the SERVER can parse (bank-format-from-server). The parser registry
 * is the single source of truth for this list (architecture §8), so a new bank
 * appears in the picker without a client release — which is the whole point of
 * reading it instead of hardcoding one id here, as this module used to.
 *
 * A static dictionary, not session state: it changes only when the server is
 * deployed, so it is fetched once and never invalidated by a mutation. The key
 * lives beside — not under — an import id precisely so the family's bare
 * `['imports', id]` invalidations and the cancel-time `removeQueries` cannot
 * reach it.
 *
 * `select` unwraps the envelope so callers hold the list itself; the ORDER is the
 * server's registry order and is never re-sorted here (the first entry is what the
 * upload form preselects).
 */
export function useStatementFormats() {
  return useQuery({
    queryKey: qk.importFormats(),
    queryFn: () => throwOnError(apiClient.GET('/statement-imports/formats')),
    select: (data: StatementFormatsRead) => data.formats,
    // A deploy-time constant: re-reading it on every modal open would be a
    // request that cannot answer anything new within a session.
    staleTime: 60 * 60 * 1000,
  });
}

/** The server's own page ceiling for the preview (`_ROWS_MAX_LIMIT`). */
export const IMPORT_ROWS_PAGE_SIZE = 200;

export function useImportSession(importId: string) {
  return useQuery<StatementImportRead>({
    queryKey: qk.importSession(importId),
    queryFn: () =>
      throwOnError(
        apiClient.GET('/statement-imports/{import_id}', {
          params: { path: { import_id: importId } },
        }),
      ),
    // The counters move only through this client's own writes, each of which
    // invalidates them explicitly; nothing else touches a preview session.
    staleTime: 30_000,
  });
}

/**
 * The paged preview. `offset` is the pageParam and never a key member
 * (AM-1.6-a); the STATUS filter is data in the key, because a filtered chip is a
 * different set of rows rather than the same one re-read.
 */
export function useImportRows(importId: string, matchStatus: StatementRowMatchStatus | null) {
  return useInfiniteQuery({
    queryKey: qk.importRows(importId, matchStatus),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      throwOnError(
        apiClient.GET('/statement-imports/{import_id}/rows', {
          params: {
            path: { import_id: importId },
            query: {
              offset: pageParam,
              limit: IMPORT_ROWS_PAGE_SIZE,
              // `null` is dropped by the query serializer, so the unfiltered
              // request carries no `match_status` at all.
              match_status: matchStatus,
            },
          },
        }),
      ),
    // has_more is derived, exactly as on the transactions list: loaded vs the
    // total any page reports (the total is the FILTERED count, server-side).
    getNextPageParam: (_lastPage, pages) => {
      const loaded = pages.reduce((count, page) => count + page.items.length, 0);
      const total = pages[0]?.total ?? 0;
      return loaded < total ? loaded : undefined;
    },
  });
}

export interface UploadStatementVariables {
  accountId: string;
  file: File;
  /**
   * A key of the server's parser registry, chosen by the user from
   * `useStatementFormats()`. Never guessed from the file name or extension: two
   * banks export `.csv` and only the server knows which layout it can read.
   */
  format: string;
}

/**
 * The upload: multipart, and the ONLY multipart request this client makes.
 *
 * The file goes up as BYTES — no decoding, no re-encoding, no parsing in the
 * browser. The statement is cp1251 and a client that tried to read it would
 * either mangle it or duplicate a parser that already exists server-side.
 *
 * `bodySerializer` is the documented openapi-fetch hook for a non-JSON body: it
 * receives the TYPED body (so a renamed contract field is a compile error here,
 * not a silent 422) and returns the FormData the browser stamps a boundary on.
 */
export function useUploadStatement() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ accountId, file, format }: UploadStatementVariables) =>
      throwOnError(
        apiClient.POST('/statement-imports', {
          body: { account_id: accountId, file, format },
          bodySerializer(body) {
            const form = new FormData();
            form.append('account_id', body.account_id);
            form.append('format', body.format);
            form.append('file', body.file);
            return form;
          },
        }),
      ),
    onSuccess: (created) => {
      // The screen the caller navigates to reads exactly this object, so seeding
      // it means the preview opens without a round trip it already has the
      // answer to. A 422 writes nothing: no session exists to show.
      queryClient.setQueryData<StatementImportRead>(qk.importSession(created.id), created);
    },
  });
}

/**
 * One row's decision and/or category. The 200 body is the updated row, which is
 * written into every cached page of every status filter — see the module note on
 * why this does NOT invalidate the rows family.
 */
export function usePatchImportRow(importId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ rowId, body }: { rowId: string; body: StatementRowPatch }) =>
      throwOnError(
        apiClient.PATCH('/statement-imports/{import_id}/rows/{row_id}', {
          params: { path: { import_id: importId, row_id: rowId } },
          body,
        }),
      ),
    onSuccess: (updated) => {
      queryClient.setQueriesData<InfiniteData<StatementRowList>>(
        { queryKey: ['imports', importId, 'rows'] },
        (previous) => {
          if (!previous) return previous;
          return {
            ...previous,
            pages: previous.pages.map((page) => {
              if (!page.items.some((row) => row.id === updated.id)) return page;
              return {
                ...page,
                // Untouched rows keep their identity, so a memoized row only
                // re-renders when it is the one that actually changed.
                items: page.items.map((row) => (row.id === updated.id ? updated : row)),
              };
            }),
          };
        },
      );
      void queryClient.invalidateQueries({ queryKey: qk.importSession(importId) });
    },
  });
}

/**
 * One decision for every row of one match status (§10.8). The response IS the
 * session, so the counters are exact without a second read; the rows family is
 * invalidated wholesale because no per-row body came back to write in place —
 * one refetch for one deliberate action.
 */
export function useBulkDecideImportRows(importId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: components['schemas']['StatementBulkDecision']) =>
      throwOnError(
        apiClient.POST('/statement-imports/{import_id}/rows/bulk-decision', {
          params: { path: { import_id: importId } },
          body,
        }),
      ),
    onSuccess: (session) => {
      queryClient.setQueryData<StatementImportRead>(qk.importSession(importId), session);
      void queryClient.invalidateQueries({ queryKey: ['imports', importId, 'rows'] });
    },
  });
}

export function useApplyImport(importId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      throwOnError(
        apiClient.POST('/statement-imports/{import_id}/apply', {
          params: { path: { import_id: importId } },
        }),
      ),
    onSuccess: () => {
      invalidateAfterBulkTxWrite(queryClient);
      // The session moved to `applied` and its rows are now history: both are
      // read from the server rather than patched from the report body.
      void queryClient.invalidateQueries({ queryKey: ['imports', importId] });
    },
  });
}

/**
 * What `POST /replace` would destroy, counted by the SERVER with the very
 * predicate the delete runs. `from` is `null` until the user has picked a date
 * inside the statement's period; the query is disabled there, and its key is
 * fully parameterised, so moving the date is a new entry rather than an
 * invalidation of the old answer.
 */
export function useReplacePreview(importId: string, from: string | null) {
  return useQuery<StatementReplacePreview>({
    queryKey: qk.importReplacePreview(importId, from ?? ''),
    queryFn: () =>
      throwOnError(
        apiClient.GET('/statement-imports/{import_id}/replace-preview', {
          // `from` is non-null whenever the query runs (see `enabled`).
          params: { path: { import_id: importId }, query: { from: from ?? '' } },
        }),
      ),
    enabled: from !== null,
    // The numbers may legitimately move between reads (the user can book
    // something in another tab), which is exactly why the POST re-checks them.
    staleTime: 0,
  });
}

export function useReplaceImport(importId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: components['schemas']['StatementReplaceRequest']) =>
      throwOnError(
        apiClient.POST('/statement-imports/{import_id}/replace', {
          params: { path: { import_id: importId } },
          body,
        }),
      ),
    onSuccess: () => {
      invalidateAfterBulkTxWrite(queryClient);
      void queryClient.invalidateQueries({ queryKey: ['imports', importId] });
    },
    onError: () => {
      // REPLACE_CONFIRMATION_MISMATCH means the world moved under the preview:
      // whatever number is on screen is stale by definition, so every cached
      // preview of this import is dropped and the flow re-reads it. Harmless for
      // the other failures — a preview is a cheap GET.
      void queryClient.invalidateQueries({
        queryKey: ['imports', importId, 'replace-preview'],
      });
    },
  });
}

/**
 * Cancel a preview. 204 No Content, so the result is unwrapped by hand (the
 * limits/tokens precedent — `throwOnError` treats `data: undefined` as failure).
 * The whole family is REMOVED rather than invalidated: the session is gone, and
 * refetching it would only produce a 404.
 */
export function useCancelImport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (importId: string) => {
      const { error, response } = await apiClient.DELETE('/statement-imports/{import_id}', {
        params: { path: { import_id: importId } },
      });
      if (!response.ok || error !== undefined) {
        throw new ApiError(response.status, error);
      }
    },
    onSuccess: (_result, importId) => {
      queryClient.removeQueries({ queryKey: ['imports', importId] });
    },
  });
}
