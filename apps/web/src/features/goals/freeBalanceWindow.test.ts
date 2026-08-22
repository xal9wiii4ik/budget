import { describe, expect, it } from 'vitest';

import { freeBalanceWindow } from './freeBalanceWindow';

describe('freeBalanceWindow', () => {
  it('names the three full months before the current one', () => {
    expect(freeBalanceWindow(new Date('2026-08-22T12:00:00Z'))).toEqual({
      fromMonth: '2026-05',
      toMonth: '2026-07',
    });
  });

  it('carries the window into the previous year in January', () => {
    // The rollover the string arithmetic has to survive: Jan 2026 -> Oct..Dec 2025.
    expect(freeBalanceWindow(new Date('2026-01-15T12:00:00Z'))).toEqual({
      fromMonth: '2025-10',
      toMonth: '2025-12',
    });
  });

  // The server's `today` is UTC (routers/goals.py `_today()`), so the label must
  // follow UTC too — otherwise it names the wrong three months for a few hours
  // around every month boundary. Both instants below are asserted because the
  // runner's own zone decides which one exposes a local-components implementation:
  // west of UTC the first instant is still July locally, east of UTC the second is
  // already August. One of the two therefore fails unless the basis is UTC.
  it('uses UTC components, not the host timezone, at a month boundary', () => {
    expect(freeBalanceWindow(new Date('2026-08-01T00:30:00Z'))).toEqual({
      fromMonth: '2026-05',
      toMonth: '2026-07',
    });
    expect(freeBalanceWindow(new Date('2026-07-31T23:30:00Z'))).toEqual({
      fromMonth: '2026-04',
      toMonth: '2026-06',
    });
  });
});
