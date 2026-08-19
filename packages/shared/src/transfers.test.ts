import { describe, expect, it } from 'vitest';

import { signedLegFor, type TransactionLeg } from './transfers';

const CARD_USD = 'acc-usd';
const CARD_BYN = 'acc-byn';
const CASH = 'acc-cash';

function row(overrides: Partial<TransactionLeg> = {}): TransactionLeg {
  return {
    kind: 'expense',
    account_id: CARD_USD,
    amount_minor: 10_000,
    currency: 'USD',
    counter_account_id: null,
    counter_amount_minor: null,
    counter_currency: null,
    ...overrides,
  };
}

function transfer(overrides: Partial<TransactionLeg> = {}): TransactionLeg {
  return row({
    kind: 'transfer',
    account_id: CARD_USD,
    amount_minor: 10_000,
    currency: 'USD',
    counter_account_id: CARD_BYN,
    counter_amount_minor: 33_000,
    counter_currency: 'BYN',
    ...overrides,
  });
}

describe('signedLegFor', () => {
  it('signs an expense negative and an income positive, in the row currency', () => {
    expect(signedLegFor(row({ kind: 'expense' }), CARD_USD)).toEqual({
      signedMinor: -10_000,
      currency: 'USD',
    });
    expect(signedLegFor(row({ kind: 'income' }), CARD_USD)).toEqual({
      signedMinor: 10_000,
      currency: 'USD',
    });
  });

  // The two transfer arms are the whole point of the rule: the SAME row is read
  // from either side of the same wire, and each side has its own currency.
  it('reads the source leg of a transfer as money leaving, in the source currency', () => {
    expect(signedLegFor(transfer(), CARD_USD)).toEqual({
      signedMinor: -10_000,
      currency: 'USD',
    });
  });

  it('reads the target leg of a transfer as money arriving, in the COUNTER currency', () => {
    expect(signedLegFor(transfer(), CARD_BYN)).toEqual({
      signedMinor: 33_000,
      currency: 'BYN',
    });
  });

  it('has nothing to say about an account the row does not touch', () => {
    expect(signedLegFor(row(), CASH)).toBeNull();
    expect(signedLegFor(transfer(), CASH)).toBeNull();
  });

  // Contrast with the target case above: same account, same request, but the
  // counter pair is absent — so there is no amount and no currency to show, and
  // the source leg's 10 000 USD must NOT stand in for it.
  it('returns null for a target leg whose counter pair is missing', () => {
    expect(
      signedLegFor(transfer({ counter_amount_minor: null, counter_currency: null }), CARD_BYN),
    ).toBeNull();
  });
});
