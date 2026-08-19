// The "which account is preselected" rule (plan-web, "Дефолт счёта в формах").
//
// The last account a user recorded something on is a CLIENT PREFERENCE, not
// server state: it belongs to neither the Query cache (nothing on the wire says
// it) nor Zustand (it must survive a reload). One localStorage key, read through
// a PURE function so the fallback chain is testable without a DOM.
//
// Deliberately NOT derived from the transaction cache: "the account I used last"
// is not "the account on the most recent occurred_at" — a back-dated entry would
// silently change the default of the next one.
import type { AccountRead } from '../../data/accounts';

const LAST_ACCOUNT_KEY = 'budget.lastAccountId';

/**
 * The account a fresh form should start on:
 *   1. the remembered one, if it is still in the list and not archived;
 *   2. otherwise the only non-archived account, if there is exactly one;
 *   3. otherwise nothing — the user picks, and an empty selection is what the
 *      schema's "Choose an account." rejects.
 *
 * Rule 2 stops at ONE candidate on purpose: with several accounts, guessing
 * would put money on the wrong one silently, which is the failure this whole
 * scope exists to prevent.
 */
export function pickDefaultAccount(
  accounts: AccountRead[],
  storedId: string | null,
): string {
  const usable = accounts.filter((account) => !account.archived);
  if (storedId !== null && usable.some((account) => account.id === storedId)) {
    return storedId;
  }
  return usable.length === 1 ? usable[0].id : '';
}

/** The remembered id, or `null` (never written, cleared, or storage unavailable). */
export function readLastAccountId(): string | null {
  try {
    return window.localStorage.getItem(LAST_ACCOUNT_KEY);
  } catch {
    // Private-mode / disabled storage: a missing preference is not an error.
    return null;
  }
}

/** Remember the account a successful create used (a transfer remembers its SOURCE). */
export function rememberLastAccountId(accountId: string): void {
  try {
    window.localStorage.setItem(LAST_ACCOUNT_KEY, accountId);
  } catch {
    // A preference that cannot be stored is not worth failing a save over.
  }
}
