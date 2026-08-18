// The ONE place a budget's state is decided (WR-5 / R4). Pure: no React, no
// formatting, no fetching — a `LimitItem` plus the response's base currency in,
// a discriminated union out, so the JSX only renders what this file decided.
//
// Two rules it exists to enforce:
//
//  1. THE COMPARISON GATE. `limit_minor` is stamped with its own
//     `limit_currency` (D15) while `spent_minor` is in the response's current
//     base `currency`. When the two differ — the user switched base after
//     setting the budget — there is NO ratio, NO remaining and NO over/under:
//     comparing 30 000 RUB against 30 000 USD is exactly the silent guess this
//     project forbids. The mismatch arm carries both numbers so the render can
//     show each in its own currency, side by side, and say why.
//  2. OVER IS STRICT `>`. Spending EXACTLY your budget is not an overrun.
//
// `remainingMinor` is one subtraction of two SAME-currency server integers,
// which D18 sanctions explicitly; it is negative when over (the render takes its
// magnitude for "over by …"). `ratio` is presentation geometry clamped to [0,1]
// for a CSS width — the shipped GoalCard rule — never a number shown to anyone.
import type { LimitItem } from '../../data/limits';

/** The two amounts, each carrying the currency it is denominated in (AM-5). */
export interface LimitAmounts {
  limitMinor: number;
  limitCurrency: string;
  spentMinor: number;
  currency: string;
}

export type LimitProgress =
  | ({ status: 'mismatch' } & LimitAmounts)
  | ({ status: 'under' | 'over'; ratio: number; remainingMinor: number } & LimitAmounts);

export function limitProgress(item: LimitItem, currency: string): LimitProgress {
  const amounts: LimitAmounts = {
    limitMinor: item.limit_minor,
    limitCurrency: item.limit_currency,
    spentMinor: item.spent_minor,
    currency,
  };

  if (item.limit_currency !== currency) {
    return { status: 'mismatch', ...amounts };
  }

  // The server guarantees `limit_minor >= 1`; the guard keeps a hypothetical 0
  // from producing a NaN width rather than encoding a business rule.
  const ratio =
    item.limit_minor > 0
      ? Math.max(0, Math.min(1, item.spent_minor / item.limit_minor))
      : 0;

  return {
    status: item.spent_minor > item.limit_minor ? 'over' : 'under',
    ratio,
    remainingMinor: item.limit_minor - item.spent_minor,
    ...amounts,
  };
}
