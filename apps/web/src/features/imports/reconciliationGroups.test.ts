import { describe, expect, it } from 'vitest';

import { reconciliationGroups } from './reconciliationGroups';

/** The generic takes anything with a `kind`; an id is only there to be traced. */
const item = (kind: string, id: string) => ({ kind, id });

describe('reconciliationGroups', () => {
  // The model answers in its own order; the screen's order is the one its copy
  // was written for ("missing from the app" first — the only kind that means
  // something was never recorded at all).
  it('orders the groups by kind, not by the order the items arrived in', () => {
    const groups = reconciliationGroups([
      item('fx_difference', 'f'),
      item('missing_in_app', 'm'),
      item('date_differs', 'd'),
      item('extra_in_app', 'e'),
      item('amount_differs', 'a'),
    ]);

    expect(groups.map((group) => group.kind)).toEqual([
      'missing_in_app',
      'extra_in_app',
      'amount_differs',
      'date_differs',
      'fx_difference',
    ]);
  });

  // A heading with nothing under it promises a list that does not exist; the
  // per-kind zeros belong in the counts strip, where they are a figure.
  it('drops the kinds with no items instead of heading an empty list', () => {
    const groups = reconciliationGroups([
      item('amount_differs', 'a1'),
      item('amount_differs', 'a2'),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe('amount_differs');
    // Within a kind the server's order survives: it is the order the model read
    // the statement in, which is the order the user's eye follows down a PDF.
    expect(groups[0]?.items.map((entry) => entry.id)).toEqual(['a1', 'a2']);
    expect(groups[0]?.copy?.titleKey).toBe('imports.kindAmountDiffers');
  });

  // A newer server's kind must be SHOWN, not swallowed: the embedded row and
  // transaction views still read, and hiding a finding is the one failure this
  // module may not have. It lands last, with no copy, so the component falls
  // back to the raw string.
  it('keeps a kind it has no copy for in a tail group', () => {
    const groups = reconciliationGroups([
      item('duplicate_in_app', 'u'),
      item('missing_in_app', 'm'),
    ]);

    expect(groups.map((group) => group.kind)).toEqual(['missing_in_app', 'duplicate_in_app']);
    expect(groups[0]?.copy).not.toBeNull();
    expect(groups[1]?.copy).toBeNull();
    expect(groups[1]?.items.map((entry) => entry.id)).toEqual(['u']);
  });
});
