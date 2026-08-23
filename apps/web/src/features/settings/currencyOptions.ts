// Which codes the base-currency <select> offers (base-currency-and-goal-basis W1).
//
// The offer is `SUPPORTED_CURRENCIES` — the four codes the rate providers cover,
// and the exact set the server's PATCH arm accepts (its python twin is pinned by
// apps/api/tests/test_currency_exponents_sync.py). One extra rule: if the STORED
// base is outside that set, it is prepended.
//
// That rule is not hypothetical politeness. A controlled <select> whose `value`
// matches no <option> renders BLANK in every browser — the screen would quietly
// claim the user has no base currency, or worse, look like it has the first
// option selected, and the next `change` would write a currency the user never
// intended. Today's server default (RUB) is inside the set, so this is one
// hand-written DB row (or one future provider change) away, and the failure mode
// is a lie about a money setting. Hence a pure module with a test rather than an
// inline `.includes()` in the JSX.
import { SUPPORTED_CURRENCIES } from '@budget/shared';

/**
 * The option codes, in display order, guaranteed to contain `current` exactly
 * once. Returns bare ISO codes: they are not translated (OQ-3), like the
 * language section's self-named options.
 */
export function currencyOptions(current: string): string[] {
  const supported = [...SUPPORTED_CURRENCIES];
  return supported.includes(current as (typeof SUPPORTED_CURRENCIES)[number])
    ? supported
    : [current, ...supported];
}
