import { describe, expect, it } from 'vitest';

import { selfCheckLine } from './selfCheckLine';

describe('selfCheckLine', () => {
  // The whole reason the `none` tone exists: Priorbank and every session parsed
  // before S2 report `not_available`, and a green tick there would claim a
  // check passed that never ran. A server that sends the field at all is the
  // contrast.
  it('renders nothing when no check ran, and a tick when one passed', () => {
    expect(selfCheckLine({ self_check_status: 'not_available' }).tone).toBe('none');
    expect(selfCheckLine({}).tone).toBe('none');
    expect(selfCheckLine({ self_check_status: 'passed' })).toEqual({
      tone: 'ok',
      key: 'imports.selfCheckPassed',
      figures: null,
    });
  });

  // Which check failed picks the sentence, and the two integers travel RAW (the
  // caller formats them at the statement's currency). Nothing is subtracted.
  it('names the failed check and carries both figures untouched', () => {
    expect(
      selfCheckLine({
        self_check_status: 'failed',
        self_check_failed: 'balance',
        self_check_expected_minor: 120_050,
        self_check_actual_minor: 119_000,
      }),
    ).toEqual({
      tone: 'warning',
      key: 'imports.selfCheckBalance',
      figures: { expected: 120_050, actual: 119_000 },
    });
    expect(
      selfCheckLine({
        self_check_status: 'failed',
        self_check_failed: 'income_total',
        self_check_expected_minor: 5_000,
        self_check_actual_minor: 4_000,
      }).key,
    ).toBe('imports.selfCheckIncomeTotal');
    expect(
      selfCheckLine({
        self_check_status: 'failed',
        self_check_failed: 'expense_total',
        self_check_expected_minor: 5_000,
        self_check_actual_minor: 4_000,
      }).key,
    ).toBe('imports.selfCheckExpenseTotal');
  });

  // The one arm that differs in SHAPE: dates, not money. Its two integer
  // columns are NULL by design, and its sentence has no placeholders — so
  // `figures` must be null here even though the tone is the same warning.
  it('gives the date-range failure a figure-free sentence', () => {
    expect(
      selfCheckLine({
        self_check_status: 'failed',
        self_check_failed: 'date_range',
        self_check_expected_minor: null,
        self_check_actual_minor: null,
      }),
    ).toEqual({ tone: 'warning', key: 'imports.selfCheckDateRange', figures: null });
  });

  // A money check without its figures (a server older than S2, or a half-filled
  // row) must NOT fall through to a sentence built around two numbers: that
  // would render "{expected}" to the user. It degrades to the general line
  // instead — contrast with the balance case above, which keeps its own key.
  it('degrades a money check with missing figures to the general sentence', () => {
    expect(
      selfCheckLine({ self_check_status: 'failed', self_check_failed: 'balance' }),
    ).toEqual({ tone: 'warning', key: 'imports.selfCheckFailed', figures: null });
    // Same for a `failed` status with no named check (the DB CHECK forbids it).
    expect(
      selfCheckLine({ self_check_status: 'failed', self_check_failed: null }).key,
    ).toBe('imports.selfCheckFailed');
  });
});
