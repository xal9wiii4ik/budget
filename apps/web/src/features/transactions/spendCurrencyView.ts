// What the spend-currency control shows (W: "I thought the currency was fixed").
//
// The control is a real <select> over the currencies this user actually deals in
// plus one "other currency" escape hatch, because the suggestion list is a
// SUGGESTION and not a whitelist (D7): validation is format-only on both sides,
// we only store six FX pairs, and a JPY receipt must stay representable.
//
// The two halves of that are pure and live here, so "an exotic code stays
// selected instead of being silently reset" is vitest-pinned rather than
// something you have to reproduce in a modal.
export const OTHER_CURRENCY_OPTION = '__other__';

/** Any code the API accepts (`^[A-Z]{3}$`); the schema is format-only (WD-2). */
const CODE = /^[A-Z]{3}$/;

export interface SpendCurrencyView {
  /** Real codes to render as <option>s, in the order they were suggested. */
  options: string[];
  /** What the <select> is set to: one of `options`, or the sentinel. */
  selectValue: string;
  /** Whether the free-text code field is on screen (and owns the value). */
  showOther: boolean;
}

/**
 * @param suggestions what the flow proposes (`spendCurrencyOptions`), which
 *   ALREADY contains the current value — that is how an operation stored in an
 *   exotic currency keeps showing it instead of snapping to the account's.
 * @param value the currency currently held by the form. Half-typed codes live
 *   here too while the user is filling the free-text field.
 * @param otherRequested the user picked "other currency" in the select. Sticky:
 *   the typed code becoming a well-formed one must not yank the field away
 *   mid-typing.
 */
export function spendCurrencyView(
  suggestions: readonly string[],
  value: string,
  otherRequested: boolean,
): SpendCurrencyView {
  // A half-typed "J" arrives here through `current`; it must never become an
  // option, or the list grows a junk entry on every keystroke.
  const wellFormed = suggestions.filter(
    (code, index) => CODE.test(code) && suggestions.indexOf(code) === index,
  );
  // Not in the list = nothing in the select could stand for it, so the free-text
  // field is the only honest place for it to be.
  const showOther = otherRequested || !wellFormed.includes(value);

  return {
    // In other mode the typed code is already visible in its own field; leaving
    // it in the list too would read as a second, unselected copy of itself.
    options: showOther ? wellFormed.filter((code) => code !== value) : wellFormed,
    selectValue: showOther ? OTHER_CURRENCY_OPTION : value,
    showOther,
  };
}
