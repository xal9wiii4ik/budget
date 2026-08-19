// The per-account display rule for one transaction row (architecture A3), shared
// by the web and mobile clients so both read an account's history identically.
//
// What this does is pick a LEG and a SIGN. What it deliberately does NOT do is
// arithmetic on money: nothing here adds, subtracts, converts or divides two
// amounts, and `transfer_rate` (the only ratio a transfer has) is a SERVER string
// this file never touches. Each leg's magnitude is returned with the currency of
// THAT leg, read verbatim off the row — addendum A5 puts `counter_currency` on
// `TransactionRead` precisely so the second leg needs no account lookup and no
// `?? tx.currency` fallback (which AM-5 forbids: it would render a BYN amount
// labelled USD).

/**
 * The row shape this rule needs. Structural on purpose: `TransactionRead` from
 * the generated client satisfies it, and @budget/shared does not depend on the
 * api-client package (nor may it re-declare server types).
 */
export interface TransactionLeg {
  kind: 'expense' | 'income' | 'transfer';
  account_id: string;
  amount_minor: number;
  currency: string;
  counter_account_id: string | null;
  counter_amount_minor: number | null;
  counter_currency: string | null;
}

export interface SignedLeg {
  /**
   * The stored magnitude with the direction applied: negative = money left the
   * account being viewed, positive = money arrived on it. The sign is a
   * DIRECTION marker (the ledger convention `signedAmountMinor` uses for goal
   * contributions), not a computed value.
   */
  signedMinor: number;
  /** The currency of the chosen leg — never the other leg's, never a fallback. */
  currency: string;
}

/**
 * How one row reads in the history of ONE account (A3):
 *
 *   expense  on that account  -> minus, in the row's currency
 *   income   on that account  -> plus,  in the row's currency
 *   transfer, account is the SOURCE -> minus `amount_minor`, in `currency`
 *   transfer, account is the TARGET -> plus `counter_amount_minor`, in
 *                                      `counter_currency`
 *   anything else (the row is not this account's) -> null
 *
 * A transfer matches BOTH legs server-side, so a filtered list contains it from
 * either side; this is what decides which side the reader is looking at. `null`
 * also covers the type-level case of a transfer whose counter pair is absent:
 * there is no honest amount to show for the target leg then, and inventing one
 * from the source leg would relabel money.
 */
export function signedLegFor(tx: TransactionLeg, accountId: string): SignedLeg | null {
  if (tx.kind === 'transfer') {
    if (tx.account_id === accountId) {
      return { signedMinor: -tx.amount_minor, currency: tx.currency };
    }
    if (tx.counter_account_id === accountId) {
      if (tx.counter_amount_minor === null || tx.counter_currency === null) return null;
      return { signedMinor: tx.counter_amount_minor, currency: tx.counter_currency };
    }
    return null;
  }

  if (tx.account_id !== accountId) return null;
  return {
    signedMinor: tx.kind === 'expense' ? -tx.amount_minor : tx.amount_minor,
    currency: tx.currency,
  };
}
