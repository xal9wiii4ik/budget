import { SUPPORTED_CURRENCIES } from '@budget/shared';

/**
 * The currency picker's option list (D7): the convertible set, plus one
 * out-of-set code when the flow already has one in hand — the receipts confirm
 * mode passes the parsed receipt currency so a JPY receipt stays selectable (and
 * preselected). An extra that is already supported (or null) changes nothing.
 *
 * Gating lives HERE, never in validation: the API is format-only and the shared
 * form schema accepts any ^[A-Z]{3}$ code (WD-2), so the picker is the only place
 * that narrows the set — and the only place that can make an exception.
 *
 * (Own module rather than CurrencySelect.tsx: react-refresh/only-export-components
 * forbids exporting a non-component from a component file.)
 */
export function currencyOptions(extraCurrency?: string | null): string[] {
  const options: string[] = [...SUPPORTED_CURRENCIES];
  if (extraCurrency && !options.includes(extraCurrency)) options.push(extraCurrency);
  return options;
}
