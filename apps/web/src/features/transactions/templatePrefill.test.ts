import { describe, expect, it } from 'vitest';

import { buildTemplateDefaults, type TemplatePrefillSource } from './templatePrefill';

function source(overrides: Partial<TemplatePrefillSource> = {}): TemplatePrefillSource {
  return {
    account_id: 'acc-1',
    amount_minor: 1250,
    currency: 'USD',
    kind: 'expense',
    category_id: 'cat-1',
    name: 'Rent',
    merchant: 'Landlord',
    note: 'flat 12',
    ...overrides,
  };
}

describe('buildTemplateDefaults', () => {
  it('decodes the amount with the TEMPLATE currency, not a default exponent', () => {
    // The one 100x mistake this seam can make: JPY has exponent 0, so 5000 minor
    // units are 5000 yen — decoding at the usual 2 would prefill "50.00" and the
    // user would save a hundredth of their rent.
    expect(buildTemplateDefaults(source(), '2026-08-23').amount).toBe('12.50');

    const jpy = buildTemplateDefaults(
      source({ currency: 'JPY', amount_minor: 5000 }),
      '2026-08-23',
    );
    expect(jpy.amount).toBe('5000');
    // Same currency on both sides = one amount, no pair — so the field the user
    // sees is parsed back with the very exponent it was decoded at.
    expect(jpy.currency).toBe('JPY');
    expect(jpy.original_currency).toBe('JPY');
  });

  it('falls back to the template NAME when it has no merchant', () => {
    // A manual row carries no template link and therefore no "Recurring" badge to
    // resolve a name from, so "Rent" would otherwise be lost entirely.
    expect(buildTemplateDefaults(source(), '2026-08-23').merchant).toBe('Landlord');
    expect(buildTemplateDefaults(source({ merchant: null }), '2026-08-23').merchant).toBe('Rent');
    // The widget row (UpcomingChargeRead) carries no merchant field at all.
    expect(buildTemplateDefaults(source({ merchant: undefined }), '2026-08-23').merchant).toBe(
      'Rent',
    );
  });

  it('maps the nullable server fields onto the form empty-string sentinels', () => {
    // `null` in a <select> value or a <textarea> is not a blank field, it is a
    // React warning and a control that no longer matches the form state.
    const values = buildTemplateDefaults(source({ category_id: null, note: null }), '2026-08-23');
    expect(values.category_id).toBe('');
    expect(values.note).toBe('');
  });
});
