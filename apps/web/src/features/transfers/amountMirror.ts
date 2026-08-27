/**
 * When both legs of a transfer are denominated in the same currency, the second
 * amount is not a second number — it is the first one restated. Typing it twice
 * is an invitation to typo, so the form mirrors it.
 *
 * The whole difficulty is knowing WHEN the mirror is allowed to write, and the
 * answer is one rule: it may overwrite an empty field, or the value it itself
 * wrote last, and nothing else. Whatever else sits in that field belongs to
 * someone — the user who typed it, or the transfer being edited, whose stored
 * counter amount came from the server.
 *
 * That rule is here, as a pure function, because deriving it from the form
 * library's "has this field been touched" flag cost two shipped defects. A form
 * opened on an EXISTING transfer has touched nothing, so "untouched" read as
 * "free to overwrite": opening a saved 100 USD -> 330.50 BYN transfer wiped the
 * 330.50 before the user could see it, and with it the ability to edit the
 * transfer's date or note at all.
 */

export interface MirrorState {
  /** Both legs denominated alike. False while either account is unknown. */
  readonly sameCurrency: boolean;
  /** The amount leaving the source account, as typed. */
  readonly sentAmount: string;
  /** What is in the received-amount field right now. */
  readonly counterAmount: string;
  /** The last value the mirror wrote, or null if it has written nothing yet. */
  readonly mirrored: string | null;
}

/**
 * The value the received-amount field should be set to, or `null` for "leave it
 * alone" — which is the answer for every field the mirror does not own.
 */
export function mirrorDecision({
  sameCurrency,
  sentAmount,
  counterAmount,
  mirrored,
}: MirrorState): string | null {
  // An empty field is nobody's; anything else is the mirror's only if the
  // mirror put it there.
  const ours = counterAmount === '' || counterAmount === mirrored;
  if (!ours) return null;

  // Currencies that differ make the two amounts genuinely independent — the
  // bank's rate lives between them — so the mirror not only stops filling, it
  // takes back what it filled: 100 EUR received for 100 USD sent is a number
  // nobody typed and nobody meant.
  const next = sameCurrency ? sentAmount : '';
  return next === counterAmount ? null : next;
}
