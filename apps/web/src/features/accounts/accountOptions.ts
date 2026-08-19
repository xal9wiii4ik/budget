// What an account <select> may offer, and the lookup the transfer schema needs.
// Pure, and separate from the control so both can be used without rendering it.
import type { AccountRead } from '../../data/accounts';
import type { QueryPhase } from '../../lib/queryPhase';

/**
 * The options for one selector: every non-archived account, plus the currently
 * selected one even when it is archived (the categories precedent — otherwise
 * editing an old row would force the user to MOVE it to another account just to
 * change its note, and the PATCH diff would carry an account change nobody asked
 * for).
 *
 * Input order is preserved (the server returns accounts in a stable order), and
 * a still-present archived current account is not duplicated.
 */
export function selectableAccounts(
  accounts: AccountRead[],
  currentId: string | null | undefined,
): AccountRead[] {
  return accounts.filter(
    (account) => !account.archived || (currentId != null && account.id === currentId),
  );
}

/**
 * "account id -> its currency", the lookup `transferFormSchema` parses each leg's
 * exponent with. Built over the WHOLE list (archived included): an archived
 * account can still be one side of a transfer being edited, and an id the list
 * does not know returns `undefined`, which the schema turns into a field error
 * instead of a guessed exponent (AM-5).
 */
export function accountCurrencyLookup(
  accounts: AccountRead[],
): (accountId: string) => string | undefined {
  const index = new Map(accounts.map((account) => [account.id, account.currency]));
  return (accountId: string) => index.get(accountId);
}

/** id -> account, for the row/list joins (transfer legs, form prefills). */
export function accountIndex(accounts: AccountRead[]): Map<string, AccountRead> {
  return new Map(accounts.map((account) => [account.id, account]));
}

/**
 * Whether a money form has nothing valid to submit: the account list never
 * arrived, or it arrived with no account the field could offer. Both are
 * Save-disabling — the first because an account id cannot be diffed against a
 * list we do not have, the second because `account_id` is required server-side.
 * `AccountField` renders WHY on screen; this only answers the button's question.
 */
export function accountFieldBlocked(
  phase: QueryPhase,
  accounts: AccountRead[],
  currentId?: string | null,
): boolean {
  return phase !== 'ready' || selectableAccounts(accounts, currentId).length === 0;
}
