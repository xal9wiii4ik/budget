// Debts data layer (debts W1). ONE status-inclusive query — `GET /debts` takes no
// `?status=` and answers `{items, summary}` — is the single source for the /debts
// screen, the /transactions deadline widget and the `debt_id` row badge's name
// index (the deposits/accounts pattern, for the same reasons: the joins read this
// cache reactively, so a counterparty rename re-renders those screens without
// refetching anything).
//
// EVERY money figure on a DebtRead is computed SERVER-SIDE: `principal_minor` is
// the opening movement's amount, `repaid_minor` the sum of the repayments,
// `remaining_minor` the difference, `status`/`closed_on` are derived from it, and
// the two `summary` figures are converted debt→base at today's rate with the
// unconverted rows COUNTED rather than silently dropped. The client therefore
// never adds, subtracts or converts anything here, and no mutation patches a
// cached figure by hand: every write answers the whole `DebtDetailRead` and the
// family is invalidated, because the `summary` on the LIST entry is a
// cross-currency aggregate this client must not recompute.
//
// What every debt write invalidates, and why:
//   * bare ['debts']    — remaining / status / closed_on / summary all move;
//   * bare ['accounts'] — a movement moved a balance (a debt movement IS a
//     transaction row on a real account — architecture representation (A));
//   * the tx LISTS      — that row appears in them.
// And what it deliberately does NOT: ['transactions','summary'], ['stats'] and
// ['limits'] (debt rows are excluded from every aggregate at the single
// `tx_totals` point server-side, so no total moved), ['deposits'] (a movement
// cannot land on a deposit ledger — `DEPOSIT_ACCOUNT_TRANSFER_ONLY`) and
// ['goals'] (a debt row carries no `goal_item_id`, by CHECK).
import type { components } from '@budget/api-client';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { apiClient } from '../lib/api';
import { ApiError, throwOnError } from '../lib/query';
import { qk } from './queryKeys';
import { invalidateAccounts, invalidateTxLists } from './transactions';

// The generated contract is the ONLY source of these shapes (the deposits
// pattern). This module is their single home for the whole feature: every
// component and pure helper under `features/debts/` imports the names from here,
// so a contract change lands in one import list.
export type DebtRead = components['schemas']['DebtRead'];
export type DebtDetailRead = components['schemas']['DebtDetailRead'];
export type DebtList = components['schemas']['DebtList'];
export type DebtSummaryRead = components['schemas']['DebtSummaryRead'];
export type DebtRepaymentRead = components['schemas']['DebtRepaymentRead'];
export type DebtDirection = components['schemas']['DebtDirection'];
export type DebtStatus = components['schemas']['DebtStatus'];
export type DebtCreate = components['schemas']['DebtCreate'];
export type DebtUpdate = components['schemas']['DebtUpdate'];
export type DebtRepaymentCreate = components['schemas']['DebtRepaymentCreate'];
export type DebtRepaymentUpdate = components['schemas']['DebtRepaymentUpdate'];

/** Everything one debt write makes stale. See the module header for the why. */
function invalidateAfterDebtWrite(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['debts'] });
  void invalidateAccounts(queryClient);
  void invalidateTxLists(queryClient);
}

export function useDebts() {
  return useQuery<DebtList>({
    queryKey: qk.debtsList(),
    queryFn: () => throwOnError(apiClient.GET('/debts')),
    // Same 60s as accounts and deposits: a debt changes when the user records a
    // movement, and those writes invalidate this entry themselves.
    staleTime: 60_000,
  });
}

/**
 * One debt with its repayments embedded — the history window's read.
 *
 * It is a SEPARATE request rather than a lookup in the cached list because the
 * list row carries only `repayments_count`: the architecture embeds the history
 * in the DETAIL response (a debt has a handful of movements, so one request per
 * screen and no third endpoint).
 */
export function useDebt(debtId: string) {
  return useQuery<DebtDetailRead>({
    queryKey: qk.debt(debtId),
    queryFn: () =>
      throwOnError(
        apiClient.GET('/debts/{debt_id}', { params: { path: { debt_id: debtId } } }),
      ),
  });
}

export function useCreateDebt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: DebtCreate) => throwOnError(apiClient.POST('/debts', { body })),
    onSuccess: () => invalidateAfterDebtWrite(queryClient),
  });
}

export function useUpdateDebt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: DebtUpdate }) =>
      throwOnError(
        apiClient.PATCH('/debts/{debt_id}', { params: { path: { debt_id: id } }, body }),
      ),
    onSuccess: () => invalidateAfterDebtWrite(queryClient),
    // 404 DEBT_NOT_FOUND: it is gone (another tab, another device) — refetch so
    // the row leaves the screen behind the message (the T6/T9 precedent). Its
    // movements went with it, so the balances are stale too.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) {
        invalidateAfterDebtWrite(queryClient);
      }
    },
  });
}

export function useDeleteDebt() {
  const queryClient = useQueryClient();
  return useMutation({
    // 204 No Content: openapi-fetch resolves `data: undefined`, which throwOnError
    // treats as a failure — unwrap by hand (the limits/tokens precedent).
    mutationFn: async (id: string) => {
      const { error, response } = await apiClient.DELETE('/debts/{debt_id}', {
        params: { path: { debt_id: id } },
      });
      if (!response.ok || error !== undefined) {
        throw new ApiError(response.status, error);
      }
    },
    onSuccess: (_result, id) => {
      // The family is gone, so its detail entry is not merely stale: a refetch
      // would only 404. Removed, then the rest invalidated.
      queryClient.removeQueries({ queryKey: qk.debt(id) });
      invalidateAfterDebtWrite(queryClient);
    },
    onError: (error, id) => {
      if (error instanceof ApiError && error.status === 404) {
        queryClient.removeQueries({ queryKey: qk.debt(id) });
        invalidateAfterDebtWrite(queryClient);
      }
    },
  });
}

export function useCreateRepayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ debtId, body }: { debtId: string; body: DebtRepaymentCreate }) =>
      throwOnError(
        apiClient.POST('/debts/{debt_id}/repayments', {
          params: { path: { debt_id: debtId } },
          body,
        }),
      ),
    onSuccess: () => invalidateAfterDebtWrite(queryClient),
  });
}

export function useUpdateRepayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      debtId,
      repaymentId,
      body,
    }: {
      debtId: string;
      repaymentId: string;
      body: DebtRepaymentUpdate;
    }) =>
      throwOnError(
        apiClient.PATCH('/debts/{debt_id}/repayments/{repayment_id}', {
          params: { path: { debt_id: debtId, repayment_id: repaymentId } },
          body,
        }),
      ),
    onSuccess: () => invalidateAfterDebtWrite(queryClient),
    // Both levels answer the same `DEBT_NOT_FOUND` (the no-oracle 404), so the
    // honest response is the same: refetch the family behind the message.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) {
        invalidateAfterDebtWrite(queryClient);
      }
    },
  });
}

export function useDeleteRepayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ debtId, repaymentId }: { debtId: string; repaymentId: string }) => {
      const { error, response } = await apiClient.DELETE(
        '/debts/{debt_id}/repayments/{repayment_id}',
        { params: { path: { debt_id: debtId, repayment_id: repaymentId } } },
      );
      if (!response.ok || error !== undefined) {
        throw new ApiError(response.status, error);
      }
    },
    onSuccess: () => invalidateAfterDebtWrite(queryClient),
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) {
        invalidateAfterDebtWrite(queryClient);
      }
    },
  });
}

/**
 * counterparty by debt id, for the `debt_id` badge on a transaction row.
 *
 * A name index rather than the rows themselves: the badge needs ONE string, and
 * an empty map (the list still loading, or that read failed) is the honest
 * name-less arm — the badge must never block or delay a row.
 */
export function debtNameIndex(debts: DebtRead[] | undefined): Map<string, string> {
  return new Map((debts ?? []).map((debt) => [debt.id, debt.counterparty]));
}
