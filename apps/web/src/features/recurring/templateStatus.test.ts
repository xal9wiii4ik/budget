import { describe, expect, it } from 'vitest';

import { templateStatus } from './templateStatus';
import type { RecurringTemplateRead } from '../../data/recurring';

const template: RecurringTemplateRead = {
  id: 'tpl-1',
  name: 'Rent',
  amount_minor: 5_000_000,
  kind: 'expense',
  currency: 'RUB',
  category_id: null,
  merchant: null,
  note: null,
  interval_unit: 'month',
  day_of_month: 5,
  weekday: null,
  end_date: null,
  paused: false,
  next_due_on: '2026-09-05',
  created_at: '2026-08-01T00:00:00Z',
};

describe('templateStatus', () => {
  it('reports paused even though next_due_on is ALSO null (paused wins)', () => {
    // The server nulls next_due_on for both paused and ended templates, so this
    // pair is the whole point: the same null, two different states.
    expect(templateStatus({ ...template, paused: true, next_due_on: null })).toEqual({
      status: 'paused',
    });
    expect(
      templateStatus({ ...template, paused: false, next_due_on: null, end_date: '2026-07-31' }),
    ).toEqual({ status: 'ended', endDate: '2026-07-31' });
  });

  it('carries the exact next_due_on string for an active template (rendered verbatim)', () => {
    expect(templateStatus(template)).toEqual({ status: 'active', nextDueOn: '2026-09-05' });
  });
});
