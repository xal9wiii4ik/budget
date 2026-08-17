// The ONE place any arithmetic on stats numbers is allowed (WS-4). PURE: no
// React, no formatting, no currency — just the two presentation quantities D4
// deliberately does not ship ("delta/percent rendering is presentation").
//
// Everything else stays forbidden and is nowhere in this feature: summing
// `by_category[]` to get a total (the server ships `income_minor`/`expense_minor`),
// accumulating / gap-filling / clamping / re-ordering a server series, computing
// any conversion or free balance, and deriving a period's bounds or its previous
// period client-side.

export type Comparison =
  /** Both periods are zero — there is nothing to compare, not a 0 % change. */
  | { kind: 'both-zero' }
  /** `previous <= 0`: an absolute movement only, no percentage. */
  | { kind: 'no-base'; deltaMinor: number }
  | { kind: 'ratio'; deltaMinor: number; percent: number };

/**
 * Compare two minor-unit totals FROM THE SAME RESPONSE (so they are necessarily
 * the same currency — the subtraction can never mix denominations, AM-5).
 *
 * Integer subtraction only: the server's own MAX_MINOR_AMOUNT (1e15−1) makes the
 * result safe-integer by construction, so `formatMoney`'s assertSafeMinor cannot
 * throw on it and no float ever touches money here.
 *
 * The percent policy, stated rather than emergent:
 *  - `previous === 0` → `no-base`. Never "+100 %", never "∞", never a hidden NaN.
 *  - `previous < 0` (a legitimately negative previous NET) → also `no-base`: a
 *    percentage against a negative base has no direction a reader can trust — it
 *    flips sign for the wrong reason — so we show the absolute movement instead.
 *  - otherwise `ratio`, with the percent ROUNDED to an integer. It is a
 *    percentage, never fed back into money and never stored.
 */
export function compare(currentMinor: number, previousMinor: number): Comparison {
  if (currentMinor === 0 && previousMinor === 0) return { kind: 'both-zero' };
  const deltaMinor = currentMinor - previousMinor;
  if (previousMinor <= 0) return { kind: 'no-base', deltaMinor };
  return {
    kind: 'ratio',
    deltaMinor,
    percent: Math.round((deltaMinor / previousMinor) * 100),
  };
}

/**
 * A bucket's share of ITS OWN KIND's server total (`expense_minor` /
 * `income_minor`), never of a client-summed bucket total. `null` when the total
 * is zero or negative — there is no denominator, and a share of nothing is not 0 %.
 *
 * If the server's buckets ever fail to add up to its own total, the shares
 * visibly fail to reach 100 % — surfaced rather than hidden behind a normalized
 * denominator.
 */
export function share(partMinor: number, totalMinor: number): number | null {
  if (totalMinor <= 0) return null;
  return Math.round((partMinor / totalMinor) * 100);
}

/**
 * Semantic tone for a movement. No invented judgement, no "you overspent" copy:
 * spending more is a warning tone, spending less is positive, income is the
 * reverse, and a net is judged by the SIGN of the movement. Editorializing is
 * the advisor's job, not the chart's.
 */
export type Tone = 'positive' | 'warning' | 'neutral';

export function toneForDelta(
  deltaMinor: number,
  metric: 'income' | 'expense' | 'net',
): Tone {
  if (deltaMinor === 0) return 'neutral';
  const up = deltaMinor > 0;
  if (metric === 'expense') return up ? 'warning' : 'positive';
  return up ? 'positive' : 'warning';
}
