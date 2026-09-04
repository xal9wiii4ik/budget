import { describe, expect, it } from 'vitest';

import { mirrorDecision } from './amountMirror';

describe('mirrorDecision', () => {
  it('fills an empty field while the legs share a currency', () => {
    expect(
      mirrorDecision({ sameCurrency: true, sentAmount: '100', counterAmount: '', mirrored: null }),
    ).toBe('100');
  });

  it('keeps following the sent amount once it owns the field', () => {
    expect(
      mirrorDecision({
        sameCurrency: true,
        sentAmount: '250',
        counterAmount: '100',
        mirrored: '100',
      }),
    ).toBe('250');
  });

  it('takes back its own figure when the currencies stop matching', () => {
    expect(
      mirrorDecision({
        sameCurrency: false,
        sentAmount: '100',
        counterAmount: '100',
        mirrored: '100',
      }),
    ).toBe('');
  });

  it('leaves the stored amount of a transfer being edited alone', () => {
    // The defect this pins: the form opens on a saved 100 USD -> 330.50 BYN
    // transfer, the mirror has written nothing, the currencies differ — and the
    // old rule answered "clear it", which made the transfer uneditable.
    expect(
      mirrorDecision({
        sameCurrency: false,
        sentAmount: '100',
        counterAmount: '330.50',
        mirrored: null,
      }),
    ).toBeNull();
    // Same-currency edit: still not the mirror's field to restate.
    expect(
      mirrorDecision({
        sameCurrency: true,
        sentAmount: '500',
        counterAmount: '495',
        mirrored: null,
      }),
    ).toBeNull();
  });

  it('never overwrites a figure the user typed over the mirrored one', () => {
    const typed = { sameCurrency: true, counterAmount: '431.10', mirrored: '100' } as const;
    expect(mirrorDecision({ ...typed, sentAmount: '100' })).toBeNull();
    // Not even when the sent amount changes afterwards.
    expect(mirrorDecision({ ...typed, sentAmount: '900' })).toBeNull();
    // Nor when a leg switches currency: clearing it would discard the user's own
    // number, which the mirror never had permission to touch.
    expect(mirrorDecision({ ...typed, sameCurrency: false, sentAmount: '100' })).toBeNull();
  });

  it('says nothing to do when the field already holds the answer', () => {
    expect(
      mirrorDecision({ sameCurrency: true, sentAmount: '100', counterAmount: '100', mirrored: '100' }),
    ).toBeNull();
    expect(
      mirrorDecision({ sameCurrency: false, sentAmount: '100', counterAmount: '', mirrored: '' }),
    ).toBeNull();
  });
});
