import { describe, expect, it } from 'vitest';

import { touchesGoalPlan } from './goalPlanTouch';

describe('touchesGoalPlan', () => {
  it('leaves the plan family alone only when the row is unattached on BOTH sides', () => {
    // The overwhelmingly common write: an ordinary operation with no plan link,
    // before or after. Nothing in ['goals', <goalId>, 'items'] or
    // ['goals','upcoming'] can have moved, so the pre-W2 behaviour stands.
    expect(touchesGoalPlan(null, null)).toBe(false);
  });

  it('fires when the link appears, disappears or moves', () => {
    expect(touchesGoalPlan(null, 'item-1')).toBe(true); // attached
    expect(touchesGoalPlan('item-1', null)).toBe(true); // detached, or deleted
    expect(touchesGoalPlan('item-1', 'item-2')).toBe(true); // re-attached elsewhere
  });

  it('fires on an edit of a still-attached row (the double-count trap)', () => {
    // Same node before and after: the amount, the date or the account changed,
    // and `paid_minor` up the whole branch is a server rollup over this row. A
    // "did the link change" trigger would skip exactly this case and leave the
    // node claiming yesterday's paid figure.
    expect(touchesGoalPlan('item-1', 'item-1')).toBe(true);
  });
});
