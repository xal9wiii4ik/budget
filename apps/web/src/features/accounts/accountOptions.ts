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
 * The four fields a DISPLAY join needs off an account: its id, what to call it,
 * which currency it is denominated in, and whether it is still in use.
 *
 * It exists (deposits W1) because a transfer leg may point at a deposit's hidden
 * ledger account, which `GET /accounts` deliberately does not return — so the
 * name/currency join is fed by accounts PLUS deposits (features/deposits/
 * depositAccounts.ts). Everything that MOVES money keeps taking `AccountRead[]`
 * instead: a deposit is topped up through the transfer form's fixed side, never
 * offered in an ordinary account picker, and the type is what enforces that.
 *
 * It carries no balance, on purpose — this is a labelling type, and the two
 * sources measure money differently (an account's `balance_minor` vs a deposit's
 * body plus its accrued interest).
 */
export interface NamedAccount {
  id: string;
  name: string;
  currency: string;
  archived: boolean;
  /** Which list the row came from — the only thing a label may say about it. */
  kind: 'account' | 'deposit';
}

/** id -> account, for the row/list joins (transfer legs, form prefills). */
export function accountIndex(accounts: AccountRead[]): Map<string, NamedAccount> {
  return new Map(accounts.map((account) => [account.id, namedAccount(account)]));
}

/** One account as the display shape above. */
export function namedAccount(account: AccountRead): NamedAccount {
  return {
    id: account.id,
    name: account.name,
    currency: account.currency,
    archived: account.archived,
    kind: 'account',
  };
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
