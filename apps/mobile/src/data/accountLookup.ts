// Pure account helpers (accounts-and-transfers MOB). Everything here is data
// SELECTION — which account a picker may offer, which one a fresh form starts on,
// what order the list is drawn in. Nothing here does money arithmetic: balances
// are server-computed (§2) and are only ever read off the row.
//
// Node-testable on purpose (docs/mobile.md: no RN/expo import may enter the test
// graph), so the fallback chain of `pickDefaultAccount` is pinned by vitest
// instead of being read off a screen.
import type { components } from '@budget/api-client';

type AccountRead = components['schemas']['AccountRead'];
type TransactionRead = components['schemas']['TransactionRead'];

/** id -> account, for the row/list joins (transfer legs, form prefills). */
export function buildAccountIndex(accounts: AccountRead[]): Map<string, AccountRead> {
  const index = new Map<string, AccountRead>();
  for (const account of accounts) index.set(account.id, account);
  return index;
}

/**
 * "account id -> its currency", the lookup `transferFormSchema` parses each leg's
 * exponent with. Built over the WHOLE list (archived included): an archived
 * account can still be one side of a transfer being edited, and an id the list
 * does not know returns `undefined`, which the shared schema turns into a field
 * error instead of a guessed exponent (AM-5).
 */
export function accountCurrencyLookup(
  accounts: AccountRead[],
): (accountId: string) => string | undefined {
  const index = new Map(accounts.map((account) => [account.id, account.currency]));
  return (accountId: string) => index.get(accountId);
}

/**
 * What one picker may offer: every non-archived account, plus the currently
 * selected one even when it is archived (the categories precedent — otherwise
 * editing an old row would force the user to MOVE it to another account just to
 * change its note, and the PATCH diff would carry an account change nobody asked
 * for). Input order is preserved; a still-present archived current account is not
 * duplicated.
 */
export function selectableAccounts(
  accounts: AccountRead[],
  currentId: string | null | undefined,
): AccountRead[] {
  return accounts.filter(
    (account) => !account.archived || (currentId != null && account.id === currentId),
  );
}

// The single place the Hermes-Intl fallback lives (the W11 argument in
// categoryLookup.ts, verbatim): prefer Intl.Collator, degrade to localeCompare.
function makeNameComparator(locale?: string): (a: string, b: string) => number {
  if (typeof Intl !== 'undefined' && typeof Intl.Collator === 'function') {
    const collator = new Intl.Collator(locale, { sensitivity: 'base' });
    return (a, b) => collator.compare(a, b);
  }
  return (a, b) => a.localeCompare(b, locale, { sensitivity: 'base' });
}

/**
 * A NEW array: live accounts first, archived ones last, locale-aware by name
 * within each group. Does not mutate the input. (The server's ORDER BY is
 * determinism only, not a display order — same rule as categories.)
 */
export function sortForDisplay(accounts: AccountRead[], locale?: string): AccountRead[] {
  const compareName = makeNameComparator(locale);
  return [...accounts].sort((a, b) => {
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    return compareName(a.name, b.name);
  });
}

/**
 * The account a fresh form starts on.
 *
 *   1. the account of the most recent CACHED transaction, when that account is
 *      still usable (present and not archived);
 *   2. otherwise the only non-archived account, if there is exactly one;
 *   3. otherwise "" — the user picks, and an empty selection is what the schema's
 *      "Choose an account." rejects.
 *
 * `transactions` is whatever the month list already holds in the Query cache, in
 * the server's occurred_at-DESC order; this function reads it, it never fetches.
 * A cold start with an empty cache therefore lands on rule 2 or 3 — deliberate
 * (PM, OQ-M1): NO on-device persistence is added for this preference, so nothing
 * survives a restart and no AsyncStorage enters the app.
 *
 * Rule 2 stops at ONE candidate on purpose: with several accounts, guessing would
 * put money on the wrong one silently, which is the failure this whole scope
 * exists to prevent. Rule 1 scans past rows whose account was archived rather than
 * giving up on the first one — an archived account takes no new operations.
 */
export function pickDefaultAccount(
  accounts: AccountRead[],
  transactions: TransactionRead[],
): string {
  const usable = accounts.filter((account) => !account.archived);
  const usableIds = new Set(usable.map((account) => account.id));

  for (const transaction of transactions) {
    if (usableIds.has(transaction.account_id)) return transaction.account_id;
  }

  return usable.length === 1 ? usable[0].id : '';
}
