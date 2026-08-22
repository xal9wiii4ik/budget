import { describe, expect, it } from 'vitest';

import { periodicityLabel, weekdayLabels } from './periodicity';
import type { RecurringTemplateRead } from '../../data/recurring';
import { createTranslate } from '../../i18n/t';

const t = createTranslate('en');
const tRu = createTranslate('ru');

const template: RecurringTemplateRead = {
  id: 'tpl-1',
  name: 'Rent',
  account_id: 'acc-1',
  amount_minor: 5_000_000,
  kind: 'expense',
  currency: 'RUB',
  category_id: null,
  merchant: null,
  note: null,
  interval_unit: 'month',
  day_of_month: 5,
  weekday: null,
  start_date: null,
  end_date: null,
  paused: false,
  next_due_on: '2026-09-05',
  created_at: '2026-08-01T00:00:00Z',
};

describe('weekdayLabels', () => {
  // BOTH ENDS are asserted on purpose: a Date.getDay()-shaped off-by-one would
  // still put *a* weekday at index 0, so only the pair pins the ISO convention.
  it('is ISO-ordered: index 0 is Monday and index 6 is Sunday (en-US)', () => {
    const labels = weekdayLabels('en-US');
    expect(labels[0]).toBe('Monday');
    expect(labels[6]).toBe('Sunday');
  });

  it('localizes without changing the order (ru-RU)', () => {
    const labels = weekdayLabels('ru-RU');
    expect(labels[0]?.startsWith('понедельник')).toBe(true);
    expect(labels[6]?.startsWith('воскресенье')).toBe(true);
  });
});

describe('periodicityLabel', () => {
  it('reads the WIRE weekday as an ISO index (0 -> Monday), not a getDay() one', () => {
    expect(
      periodicityLabel(
        { ...template, interval_unit: 'week', day_of_month: null, weekday: 0 },
        t,
        'en-US',
      ),
    ).toBe('Weekly on Monday');
    expect(
      periodicityLabel(
        { ...template, interval_unit: 'week', day_of_month: null, weekday: 6 },
        t,
        'en-US',
      ),
    ).toBe('Weekly on Sunday');
  });

  it('names the day of the month for a monthly template', () => {
    expect(periodicityLabel(template, t, 'en-US')).toBe('Monthly on day 5');
  });

  it('takes the sentence from the dictionary and the weekday from the locale', () => {
    // Contrast with the en case above: the wire value is the SAME ISO index, so
    // anything that differs here comes from the language, not from the data.
    expect(
      periodicityLabel(
        { ...template, interval_unit: 'week', day_of_month: null, weekday: 0 },
        tRu,
        'ru-RU',
      ),
    ).toBe('Еженедельно, понедельник');
  });
});
