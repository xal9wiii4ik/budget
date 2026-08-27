// The merged name/currency index over accounts AND deposits (deposits W1,
// architecture AMENDMENT §2). Pure, and unit-tested, because it is the single
// answer to a question four screens ask and none of them can answer alone.
//
// The problem it solves: a deposit's ledger account is HIDDEN from
// `GET /accounts` (server-side `type != 'deposit'`), which is exactly what keeps
// deposit money out of every picker and every total. But a transfer to a deposit
// still stores that account's id in `counter_account_id`, so the accounts cache
// alone cannot name the other side of the row — it would render "Card USD → "
// forever, and the /transactions account filter would label a deposit's own
// history "unavailable".
//
// What it is NOT: a source of money. The entries carry no balance and the
// merged map is never summed, compared or converted. Deposits keep their own
// screen for their figures, and the ordinary account pickers keep taking
// `AccountRead[]` — a deposit is topped up through the transfer form's FIXED
// side, never chosen from a dropdown.
//
// The key is the deposit's `account_id`, never its `id`: what a transaction row
// points at is the LEDGER account. Keying by the deposit id would produce an
// index that silently resolves nothing.
import type { DepositRead } from '../../data/deposits';
import type { AccountRead } from '../../data/accounts';
import { namedAccount, type NamedAccount } from '../accounts/accountOptions';

/**
 * Every deposit as its LEDGER account's display entry: the deposit's own name
 * and currency (the server keeps the account's name in step with it), its own
 * archived flag (archiving a deposit archives its account in the same
 * transaction), keyed by `account_id`.
 */
export function depositAccountEntries(deposits: DepositRead[]): NamedAccount[] {
  return deposits.map((deposit) => ({
    id: deposit.account_id,
    name: deposit.name,
    currency: deposit.currency,
    archived: deposit.archived,
    kind: 'deposit',
  }));
}

/**
 * Accounts first, then deposits — the order the /transactions filter lists them
 * in, so the everyday accounts stay at the top of the dropdown where they were.
 */
export function mergedAccountEntries(
  accounts: AccountRead[],
  deposits: DepositRead[],
): NamedAccount[] {
  return [...accounts.map(namedAccount), ...depositAccountEntries(deposits)];
}

/**
 * id -> entry over both lists. The two id spaces are disjoint by construction
 * (a deposit's `account_id` IS an account id, and that account is excluded from
 * `GET /accounts`), so nothing can shadow anything; were the server ever to
 * start returning deposit accounts, the deposit entry — the one that knows it is
 * a deposit — wins.
 */
export function mergedAccountIndex(
  accounts: AccountRead[],
  deposits: DepositRead[],
): Map<string, NamedAccount> {
  return new Map(mergedAccountEntries(accounts, deposits).map((entry) => [entry.id, entry]));
}
