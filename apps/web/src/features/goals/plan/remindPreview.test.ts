import { describe, expect, it } from 'vitest';

import { remindPreview } from './remindPreview';

describe('remindPreview', () => {
  it('shows a fixed date as it stands, whatever the deadline is', () => {
    expect(
      remindPreview({
        mode: 'on',
        remindOn: '2026-06-01',
        remindDaysBefore: null,
        effectiveDeadline: '2026-06-15',
      }),
    ).toEqual({ status: 'date', date: '2026-06-01' });
  });

  it('counts "N days before" back from the EFFECTIVE deadline, across a month boundary', () => {
    expect(
      remindPreview({
        mode: 'days',
        remindOn: null,
        remindDaysBefore: 20,
        effectiveDeadline: '2026-03-05',
      }),
    ).toEqual({ status: 'date', date: '2026-02-13' });
  });

  it('has no date to show when there is no deadline to count back from', () => {
    // The intent is still storable — set a deadline later and the reminder starts
    // working — so this is its own state, not an error and not a made-up date.
    expect(
      remindPreview({
        mode: 'days',
        remindOn: null,
        remindDaysBefore: 7,
        effectiveDeadline: null,
      }),
    ).toEqual({ status: 'no-deadline' });
  });

  it('says nothing while the chosen mode has no value typed into it yet', () => {
    expect(
      remindPreview({
        mode: 'days',
        remindOn: null,
        remindDaysBefore: null,
        effectiveDeadline: '2026-03-05',
      }),
    ).toEqual({ status: 'none' });
    expect(
      remindPreview({
        mode: 'none',
        remindOn: '2026-06-01',
        remindDaysBefore: null,
        effectiveDeadline: '2026-06-15',
      }),
    ).toEqual({ status: 'none' });
  });
});
