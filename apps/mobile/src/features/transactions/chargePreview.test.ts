import { describe, expect, it } from 'vitest';

import { chargePreviewRequest, type ChargePreviewInput } from './chargePreview';

// 50.00 EUR spent on a BYN account, charge left to the server.
const base: ChargePreviewInput = {
  isEdit: false,
  pairMode: true,
  chargedRaw: '',
  spentNormalized: '50',
  spendCurrency: 'EUR',
  accountCurrency: 'BYN',
  date: '2026-09-04',
};

describe('chargePreviewRequest', () => {
  it('asks only while the charged field is EMPTY — a typed amount is never second-guessed', () => {
    // The contrast this test exists for: same inputs, one keystroke apart. With
    // the field empty the form may show an estimate; the moment the user has
    // typed what their bank took, the client stops asking about it at all, so no
    // conversion result can ever reach that field or that value on the wire.
    expect(chargePreviewRequest(base)).toEqual({
      amountMinor: 5000,
      from: 'EUR',
      to: 'BYN',
      date: '2026-09-04',
    });
    expect(chargePreviewRequest({ ...base, chargedRaw: '165.00' })).toBeNull();
    // Whitespace is not a number the user typed, so it does not count as one.
    expect(chargePreviewRequest({ ...base, chargedRaw: '  ' })).not.toBeNull();
  });

  it('stays silent where an estimate could not mean anything', () => {
    // An edit shows the STORED charge; a single-currency row has nothing to
    // convert; a half-typed amount or date would be a guessed parameter.
    expect(chargePreviewRequest({ ...base, isEdit: true })).toBeNull();
    expect(chargePreviewRequest({ ...base, pairMode: false })).toBeNull();
    expect(chargePreviewRequest({ ...base, spentNormalized: '.' })).toBeNull();
    expect(chargePreviewRequest({ ...base, date: '2026-09' })).toBeNull();
  });
});
