// How the reconcile agent's findings are ordered on screen (pdf-reconcile S4).
//
// The report arrives as ONE flat list of items, each with a `kind`, in whatever
// order the model answered. The screen shows them grouped, because the five
// kinds ask the user for five different things ("this is missing from the app"
// is a row to add; "this is only in the app" is a row to check), and a mixed
// list makes every item a fresh reading task.
//
// PURE and LANGUAGE-FREE by the house rule (the `aiStatusLine` precedent): the
// groups carry dict KEYS and the items themselves, never a sentence. Generic in
// the item, so a test needs nothing but `{kind}` while the screen keeps the full
// `StatementDiscrepancy` — including the two embedded mini views it renders.
//
// NOTHING is counted here. The headline figures are the server's `counts` /
// `settled_exact` / `open_*`, and a group's length is a property of the list on
// screen rather than a claim about the report (an unknown kind, see below, is
// precisely a case where the two can differ).
import type { SimpleKey } from '../../i18n/t';

/**
 * The closed kind set, in the order the screen reads: what the app is MISSING
 * first (the only kind that means "something was never recorded"), then what it
 * holds and the bank does not, then the three pairs that differ in a detail.
 */
export const DISCREPANCY_KIND_ORDER = [
  'missing_in_app',
  'extra_in_app',
  'amount_differs',
  'date_differs',
  'fx_difference',
] as const;

/** A group's heading and the one line that explains what the kind means. */
export interface DiscrepancyKindCopy {
  titleKey: SimpleKey;
  hintKey: SimpleKey;
}

/**
 * Keyed by `string`, not by the generated `DiscrepancyKind`, for one reason: a
 * newer server may answer a kind this build has no copy for, and the lookup has
 * to be able to MISS. A `Record<DiscrepancyKind, …>` would type the miss away
 * and the only ways back would be a cast or a hidden item.
 */
const KIND_COPY: Readonly<Record<string, DiscrepancyKindCopy | undefined>> = {
  missing_in_app: {
    titleKey: 'imports.kindMissingInApp',
    hintKey: 'imports.kindMissingInAppHint',
  },
  extra_in_app: {
    titleKey: 'imports.kindExtraInApp',
    hintKey: 'imports.kindExtraInAppHint',
  },
  amount_differs: {
    titleKey: 'imports.kindAmountDiffers',
    hintKey: 'imports.kindAmountDiffersHint',
  },
  date_differs: {
    titleKey: 'imports.kindDateDiffers',
    hintKey: 'imports.kindDateDiffersHint',
  },
  fx_difference: {
    titleKey: 'imports.kindFxDifference',
    hintKey: 'imports.kindFxDifferenceHint',
  },
};

export interface ReconciliationGroup<T> {
  /** The server's own kind string, verbatim — the fallback heading. */
  kind: string;
  /** `null` for a kind this build has no copy for: render `kind` as it came. */
  copy: DiscrepancyKindCopy | null;
  /** Never empty: a kind with no items is not a group at all. */
  items: T[];
}

/**
 * Group the items by kind, in the fixed order above.
 *
 * An EMPTY kind is dropped rather than rendered as a heading with nothing under
 * it — the per-kind zeros are in the counts strip, where they are a figure
 * rather than a promise of a list. An UNKNOWN kind keeps its items in a tail
 * group with no copy: hiding what the server said is the one failure mode this
 * module must not have (the `statementFormatLabel` rule), and a newer server's
 * finding is still a finding the user can read from the embedded views.
 *
 * Order WITHIN a kind is the server's, untouched: the model answers in the order
 * it read the statement, which is the order the user's eye follows down a PDF.
 */
export function reconciliationGroups<T extends { kind: string }>(
  items: readonly T[],
): ReconciliationGroup<T>[] {
  // Insertion order is what makes the unknown tail deterministic: a Map keeps
  // the kinds in order of first appearance.
  const byKind = new Map<string, T[]>();
  for (const item of items) {
    const bucket = byKind.get(item.kind);
    if (bucket === undefined) {
      byKind.set(item.kind, [item]);
    } else {
      bucket.push(item);
    }
  }

  const groups: ReconciliationGroup<T>[] = [];
  for (const kind of DISCREPANCY_KIND_ORDER) {
    const bucket = byKind.get(kind);
    if (bucket === undefined) continue;
    byKind.delete(kind);
    groups.push({ kind, copy: KIND_COPY[kind] ?? null, items: bucket });
  }
  // Whatever is left is a kind this build does not know; it goes last, because
  // the five known ones are what this screen's copy was written for.
  for (const [kind, bucket] of byKind) {
    groups.push({ kind, copy: KIND_COPY[kind] ?? null, items: bucket });
  }
  return groups;
}
