// Which codes the base-currency control offers (catch-up 3, line B).
//
// VERBATIM COPY of apps/web/src/features/settings/currencyOptions.ts — same rule,
// and web's own vitest file already pins it.
//
// The offer is `SUPPORTED_CURRENCIES` — the codes the rate providers cover, and
// the exact set the server's PATCH arm accepts. One extra rule: if the STORED base
// is outside that set, it is prepended, so the screen can never render a chip row
// in which NOTHING is selected — which would quietly claim the user has no base
// currency, and make the next tap write a currency they never intended.
import { SUPPORTED_CURRENCIES } from '@budget/shared';

/**
 * The option codes, in display order, guaranteed to contain `current` exactly
 * once. Bare ISO codes: they are not translated, like the language section's
 * self-named options.
 */
export function currencyOptions(current: string): string[] {
  const supported = [...SUPPORTED_CURRENCIES];
  return supported.includes(current as (typeof SUPPORTED_CURRENCIES)[number])
    ? supported
    : [current, ...supported];
}
