// Chart formatting shared by every Recharts surface (WS-9). Extracted from
// GoalProgressChart when the stats monthly chart became its second consumer —
// the first/second-consumer rule this codebase applies everywhere.
import { formatAmount } from '@budget/shared';

/**
 * Y-axis tick labels. Recharts derives "nice" tick values from the data domain
 * and they are not guaranteed to be integers, while the shared money helpers
 * reject a non-integer minor value outright (correctly — money is integer minor
 * units). Rounding here affects an axis GRIDLINE LABEL only; no stored or
 * displayed amount ever goes through this path.
 *
 * The currency is always the one the OWNING RESPONSE is denominated in (AM-5) —
 * the caller passes `goal.currency` / `monthly.currency`, never a default.
 */
export function moneyTickFormatter(currency: string) {
  return (value: number) => formatAmount(Math.round(value), currency);
}
