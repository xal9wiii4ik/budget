import { describe, expect, it } from 'vitest';

import { buildDepositPatch } from './depositPatch';
import type { DepositFormValues } from './depositFormSchema';

function values(overrides: Partial<DepositFormValues> = {}): DepositFormValues {
  return {
    name: 'Bank deposit',
    currency: 'BYN',
    rate_percent: '10.95',
    capitalization: 'monthly',
    opened_on: '2025-08-01',
    term_end: '2026-09-01',
    tax_rate_percent: '13',
    initial_balance_minor: 0,
    ...overrides,
  };
}

describe('buildDepositPatch', () => {
  it('emits nothing when nothing changed', () => {
    expect(buildDepositPatch(values(), values())).toEqual({});
  });

  it('clears the two nullable fields with an EXPLICIT null', () => {
    // Omitting the key would mean "keep the term" and "keep taxing" — the
    // opposite of what the user did. `null` is what makes the deposit
    // open-ended and untaxed server-side.
    const patch = buildDepositPatch(
      values({ term_end: null, tax_rate_percent: null }),
      values(),
    );

    expect(patch).toEqual({ term_end: null, tax_rate_percent: null });
  });

  it('never emits currency, the opening body, or the archive flag', () => {
    // The first two have no PATCH representation at all; the third has to travel
    // ALONE (the server refuses a reopen carrying anything else), so a builder
    // that could emit it beside other fields would make that failure reachable.
    const patch = buildDepositPatch(
      values({ currency: 'USD', initial_balance_minor: 999 }),
      values(),
    );

    expect(patch).toEqual({});
  });

  it('sends the rate as the STRING it was typed as', () => {
    const patch = buildDepositPatch(values({ rate_percent: '9.5' }), values());

    expect(patch).toEqual({ rate_percent: '9.5' });
  });
});
