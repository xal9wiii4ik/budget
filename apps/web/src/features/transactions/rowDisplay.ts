// Foreign-row display logic (3.2 W2), pure so the decode discipline is testable.
//
// T8′ (the 1.6 T8 rule, extended): every amount renders with the currency of the
// FIELD it came from. A row's `amount_minor` is in `tx.currency`; the base-currency
// snapshot `base_amount_minor` is in its PAIRED `base_currency` — never the row's
// currency, never the summary's, never a `?? fallback` (AM-5). The DB CHECK keeps
// the pair atomic, so both members are present or neither is.
import type { components } from '@budget/api-client';

type TransactionRead = components['schemas']['TransactionRead'];

export interface BaseEquivalent {
  minor: number;
  currency: string;
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
