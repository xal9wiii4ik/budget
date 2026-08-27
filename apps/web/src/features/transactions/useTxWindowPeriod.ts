import { currentMonth } from '@budget/shared';
import { useState } from 'react';

import type { TxRangeMode } from './txFilters';
import type { TxWindowPeriod } from './txWindow';

export interface TxWindowPeriodState {
  /** The window the modal is showing right now. */
  period: TxWindowPeriod;
  /** The month the stepper shows — see below. */
  monthAnchor: string;
  /** The ONE writer, wired straight to `TxRangePicker`'s `onChange`. */
  onRangeChange: (next: TxRangeMode) => void;
}

/**
 * The period of a drill-down window (features/transactions/TxWindowModal).
 *
 * LOCAL state, deliberately not the URL: nothing in such a window is a
 * destination to share or to restore with the back button — the way to a
 * shareable view is the "open all operations" link at the bottom, which
 * reproduces the window on /transactions.
 *
 * `monthAnchor` is kept while a custom period is on, so "back to this month"
 * returns to what was being read (the /transactions rule, minus the URL). While
 * the period is a month, the two are the same value.
 */
export function useTxWindowPeriod(): TxWindowPeriodState {
  const [monthAnchor, setMonthAnchor] = useState(() => currentMonth());
  const [period, setPeriod] = useState<TxWindowPeriod>(() => ({
    kind: 'month',
    month: currentMonth(),
  }));

  return {
    period,
    monthAnchor,
    onRangeChange: (next) => {
      // The picker's union has three modes; the modal renders it with
      // `allowAllTime={false}`, so it never emits this one (TxWindowPeriod has
      // no such arm to store it in).
      if (next.kind === 'all') return;
      if (next.kind === 'month') setMonthAnchor(next.month);
      setPeriod(next);
    },
  };
}
