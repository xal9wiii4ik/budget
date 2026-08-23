/**
 * What the base-currency switch hands to the declared-income field (Amendment
 * W-A1-UX).
 *
 * A confirmed base switch CLEARS `monthly_income_minor` server-side, so the user
 * would otherwise be left in front of an empty field wondering what happened.
 * Instead the switch passes what it knew BEFORE the PATCH, converted by the
 * server, and the income section prefills it as an editable DRAFT — saved only by
 * an explicit Save.
 *
 * `convertedMinor === null` is the honest degraded state: no rate for the pair,
 * or the conversion request failed. The field is then simply empty and focused —
 * a number is never invented client-side (the money invariant), and the warning
 * copy already told the user the income has to be re-entered.
 */
export interface IncomeHandoff {
  /** Distinguishes two switches in a row, so the field re-prefills and re-focuses. */
  seq: number;
  /** The base currency the old income was denominated in. */
  from: string;
  /** The old income expressed in the NEW base by `GET /fx/convert`, or null. */
  convertedMinor: number | null;
}
