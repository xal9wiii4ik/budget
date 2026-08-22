// Foreign-row display logic (3.2 W2), pure so the decode discipline is testable.
//
// T8′ (the 1.6 T8 rule, extended): every amount renders with the currency of the
// FIELD it came from. A row's `amount_minor` is in `tx.currency`; the base-currency
// snapshot `base_amount_minor` is in its PAIRED `base_currency` — never the row's
// currency, never the summary's, never a `?? fallback` (AM-5). The DB CHECK keeps
// the pair atomic, so both members are present or neither is.
import type { components } from '@budget/api-client';

type CategoryRead = components['schemas']['CategoryRead'];
type TransactionRead = components['schemas']['TransactionRead'];

export interface BaseEquivalent {
  minor: number;
  currency: string;
}

export interface RowMoney {
  /** A magnitude; the row applies the sign from `kind` (T4/T8). */
  minor: number;
  currency: string;
}

export interface RowAmounts {
  /** The big line: what the operation COST, in the currency it was paid in. */
  primary: RowMoney;
  /**
   * The muted second line, or null. `kind` says what it means, because the two
   * cannot be told apart from the numbers alone:
   *   'charged' — what the account was actually charged for a foreign purchase;
   *   'base'    — the stored base-currency snapshot (the "≈" line).
   */
  secondary: (RowMoney & { kind: 'charged' | 'base' }) | null;
}

/**
 * The "≈ x base" secondary line for a row, or `null` when there is nothing
 * honest to show:
 *
 * - a row already in the summary's currency has no equivalent to display;
 * - a row with no snapshot (no rate existed at write time) shows nothing — the
 *   summary's unconverted banner carries that story once, instead of nagging
 *   per row;
 * - a STALE-BASE snapshot (its `base_currency` is no longer the profile base,
 *   the D5 base-change bypass) is hidden: the stored number is a real amount in
 *   a currency that is no longer the base, so presenting it beside base-currency
 *   totals would be a quiet lie.
 */
export function baseEquivalent(
  tx: TransactionRead,
  summaryCurrency: string,
): BaseEquivalent | null {
  if (tx.currency === summaryCurrency) return null;

  const minor = tx.base_amount_minor;
  const currency = tx.base_currency;
  if (minor === null || currency === null) return null;
  if (currency !== summaryCurrency) return null;

  return { minor, currency };
}

/**
 * The money lines of one row — at most TWO (transaction-details-and-i18n S1).
 *
 * With an original (spent) pair the row leads with what the user SPENT, because
 * that is the number they remember ("50 EUR at the bakery"), and shows what the
 * account was charged underneath. The "≈ base" line is deliberately DROPPED
 * there: three amounts on one line stops being information and becomes noise,
 * and of the two candidates the charge is the one that reconciles with a bank
 * statement.
 *
 * The charge line is not optional garnish, though — it is the only thing that
 * explains why the month's total does not equal the sum of the primary column,
 * so callers must render it as visible text, never behind a hover.
 *
 * Without a pair, the shipped behaviour is unchanged: own amount + the "≈" line
 * (see `baseEquivalent` for when that one is honest).
 */
export function primaryAmount(
  tx: TransactionRead,
  summaryCurrency: string | undefined,
): RowAmounts {
  const originalMinor = tx.original_amount_minor;
  const originalCurrency = tx.original_currency;

  if (originalMinor !== null && originalCurrency !== null) {
    return {
      primary: { minor: originalMinor, currency: originalCurrency },
      secondary: { minor: tx.amount_minor, currency: tx.currency, kind: 'charged' },
    };
  }

  const equivalent =
    summaryCurrency === undefined ? null : baseEquivalent(tx, summaryCurrency);

  return {
    primary: { minor: tx.amount_minor, currency: tx.currency },
    secondary: equivalent === null ? null : { ...equivalent, kind: 'base' },
  };
}

/**
 * The row's title (transaction-details-and-i18n S4).
 *
 * `merchant` is the field the user now fills in as "name / place", so when it is
 * there it IS the name of the operation — a list of "Groceries, Groceries,
 * Groceries" tells nobody which shop that was. The category stays visible as the
 * row's icon, and the note keeps its own secondary line.
 *
 * Falls back to the category name, then to "Uncategorized" for a row that really
 * has no category — never to "Unknown category" unless the row DOES name a
 * category the loaded index has not got (a genuinely different, honest state).
 */
export function rowTitle(tx: TransactionRead, category: CategoryRead | undefined): string {
  if (tx.merchant !== null && tx.merchant !== '') return tx.merchant;
  if (tx.category_id === null) return 'Uncategorized';
  return category?.name ?? 'Unknown category';
}
