// Accounts data layer (accounts-and-transfers MOB). ONE archived-inclusive query
// is the single source for the accounts tab, every form's account picker, the
// list's account filter and the transfer row's "A → B" name join — the categories
// AM-1.6-b pattern, for the same reasons: there is no single-account GET, and the
// joins read this cache reactively, so a rename or an archive re-renders those
// screens without refetching any transaction data.
//
// `balance_minor` is COMPUTED SERVER-SIDE (architecture §2) and arrives on every
// AccountRead, including the one a mutation returns. The client therefore never
// adds, subtracts or converts a balance: a create/update writes the returned row
// into the cache verbatim, and everything that MOVES a balance (the three
// transaction mutations, transfers included) invalidates the whole ['accounts']
// family from data/transactions.ts instead of patching numbers here.
//
// Archive is a PATCH {archived}; there is NO DELETE for accounts (§9) — deleting
// one would take its transactions with it.
// Copied from web data/accounts.ts (only the api/query import paths differ).
import type { components } from '@budget/api-client';
import { throwOnError } from '@budget/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiClient } from '../lib/api';
import { qk } from './queryKeys';

export type AccountRead = components['schemas']['AccountRead'];
export type AccountType = components['schemas']['AccountType'];
type AccountCreate = components['schemas']['AccountCreate'];
type AccountUpdate = components['schemas']['AccountUpdate'];

export function useAccounts() {
  return useQuery<AccountRead[]>({
    queryKey: qk.accounts(),
    queryFn: () =>
      throwOnError(
        apiClient.GET('/accounts', { params: { query: { include_archived: true } } }),
      ),
    // Accounts change far more rarely than the transactions written on them; the
    // balances they carry are refreshed by the tx mutations' invalidation, not by
    // polling.
    staleTime: 60_000,
  });
}

export function useCreateAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AccountCreate) => throwOnError(apiClient.POST('/accounts', { body })),
    onSuccess: (created) => {
      queryClient.setQueryData<AccountRead[]>(qk.accounts(), (prev) =>
        prev ? [...prev, created] : [created],
      );
    },
  });
}

export function useUpdateAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: AccountUpdate }) =>
      throwOnError(
        apiClient.PATCH('/accounts/{account_id}', {
          params: { path: { account_id: id } },
          body,
        }),
      ),
    onSuccess: (updated) => {
      // In-place by the id of the RETURNED row (which carries the recomputed
      // `balance_minor` — a starting-balance edit moves it).
      queryClient.setQueryData<AccountRead[]>(qk.accounts(), (prev) =>
        prev ? prev.map((account) => (account.id === updated.id ? updated : account)) : prev,
      );
    },
  });
}
