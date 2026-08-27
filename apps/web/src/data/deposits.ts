// Deposits data layer (deposits W1). ONE archive-inclusive query — `GET /deposits`
// takes no `include_archived` parameter — is the single source for the /deposits
// screen, the transfer form's deposit side and the /transactions account filter
// (the accounts W1 pattern, for the same reasons: the joins read this cache
// reactively, so a rename re-renders those screens without refetching anything).
//
// EVERY money figure on a DepositRead is computed SERVER-SIDE: `balance_minor`
// (the ledger account's balance), `accrued_minor` / `accrued_after_tax_minor`
// (interest as of today, tax applied), and the stored manual anchor
// `accrued_override_minor` with the date the SERVER stamped on it. The client
// therefore never adds, multiplies, prorates or converts anything here — a
// create/PATCH writes the returned row into the cache verbatim, and everything
// that MOVES a body (the three transaction mutations, since a top-up is an
// ordinary transfer) invalidates the whole `['deposits']` family from
// data/transactions.ts instead of patching numbers.
//
// These mutations invalidate nothing OUTSIDE the family, deliberately: a deposit
// account is excluded from `GET /accounts` server-side, its transfers are already
// excluded from every aggregate, and creating or archiving a deposit writes no
// transaction. `['accounts']`, `['stats']`, `['limits']` and the tx lists are
// untouched by construction, not by an opinion held here.
import type { components } from '@budget/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiClient } from '../lib/api';
import { throwOnError } from '../lib/query';
import { qk } from './queryKeys';

export type DepositRead = components['schemas']['DepositRead'];
export type DepositCreate = components['schemas']['DepositCreate'];
export type DepositUpdate = components['schemas']['DepositUpdate'];
export type DepositCapitalization = components['schemas']['DepositCapitalization'];

export function useDeposits() {
  return useQuery<DepositRead[]>({
    queryKey: qk.depositsList(),
    queryFn: () => throwOnError(apiClient.GET('/deposits')),
    // Same 60s as accounts: a deposit changes far more rarely than the transfers
    // recorded on it, and the figures those transfers move are refreshed by the
    // tx mutations' invalidation rather than by polling.
    staleTime: 60_000,
  });
}

export function useCreateDeposit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: DepositCreate) => throwOnError(apiClient.POST('/deposits', { body })),
    onSuccess: (created) => {
      queryClient.setQueryData<DepositRead[]>(qk.depositsList(), (prev) =>
        prev ? [...prev, created] : [created],
      );
      // The server orders the list by name; the append above only keeps the
      // screen honest until the refetch lands with the row in its real place.
      void queryClient.invalidateQueries({ queryKey: ['deposits'] });
    },
  });
}

export function useUpdateDeposit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: DepositUpdate }) =>
      throwOnError(
        apiClient.PATCH('/deposits/{deposit_id}', {
          params: { path: { deposit_id: id } },
          body,
        }),
      ),
    onSuccess: (updated) => {
      // In place, by the id of the RETURNED row — which carries the recomputed
      // interest (a rate, term or override edit moves it) and the stamped
      // `accrued_override_as_of`, neither of which the client could derive.
      queryClient.setQueryData<DepositRead[]>(qk.depositsList(), (prev) =>
        prev ? prev.map((deposit) => (deposit.id === updated.id ? updated : deposit)) : prev,
      );
      void queryClient.invalidateQueries({ queryKey: ['deposits'] });
    },
  });
}
