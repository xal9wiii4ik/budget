import type { components } from '@budget/api-client';
import { describe, expect, it } from 'vitest';

import { transferDisplay } from './transferDisplay';

type TransactionRead = components['schemas']['TransactionRead'];

const NAMES = new Map([
  ['acc-usd', 'Card USD'],
  ['acc-byn', 'Card BYN'],
]);
const nameOf = (id: string) => NAMES.get(id);

function transfer(overrides: Partial<TransactionRead> = {}): TransactionRead {
  return {
    id: 'tx-1',
    account_id: 'acc-usd',
    amount_minor: 10_000,
    currency: 'USD',
    counter_account_id: 'acc-byn',
    counter_amount_minor: 33_000,
    counter_currency: 'BYN',
    transfer_rate: '3.300000',
    base_amount_minor: null,
    base_currency: null,
    category_id: null,
    created_at: '2026-08-14T10:00:00Z',
    kind: 'transfer',
    merchant: null,
    note: null,
    occurred_at: '2026-08-14',
    receipt_id: null,
    recurring_template_id: null,
    ...overrides,
  };
}

describe('transferDisplay', () => {
  it('labels each magnitude with its OWN leg currency and names the route', () => {
    const display = transferDisplay(transfer(), nameOf);

    expect(display.route).toBe('Card USD → Card BYN');
    expect(display.sent).toEqual({ signedMinor: -10_000, currency: 'USD' });
    expect(display.received).toEqual({ signedMinor: 33_000, currency: 'BYN' });
  });

  // The accounts query is a separate request: the amounts are on the row and must
  // render at once, while a half-known route ("Card USD → ") is worse than none.
  it('drops the route while an account name is unknown, keeping both amounts', () => {
    const display = transferDisplay(transfer({ counter_account_id: 'acc-gone' }), nameOf);

    expect(display.route).toBeNull();
    expect(display.sent).toEqual({ signedMinor: -10_000, currency: 'USD' });
    expect(display.received).toEqual({ signedMinor: 33_000, currency: 'BYN' });
  });

  // The rate is the server's string (A2): trailing zeros and long tails are its
  // digits, and re-rounding them here would be exactly the client money
  // arithmetic this project forbids.
  it('captions the rate with the server string verbatim between the two codes', () => {
    expect(transferDisplay(transfer(), nameOf).rate).toBe('3.300000 BYN / USD');
    expect(transferDisplay(transfer({ transfer_rate: '0.0000395' }), nameOf).rate).toBe(
      '0.0000395 BYN / USD',
    );
  });

  it('has no rate caption when the server sent none', () => {
    expect(transferDisplay(transfer({ transfer_rate: null }), nameOf).rate).toBeNull();
  });

  // A same-currency transfer still gets a rate ("1") from the server; printing
  // "1 USD / USD" under the amounts is noise, not information.
  it('has no rate caption when both legs share a currency', () => {
    const display = transferDisplay(
      transfer({ counter_currency: 'USD', counter_amount_minor: 10_000, transfer_rate: '1' }),
      nameOf,
    );

    expect(display.rate).toBeNull();
    expect(display.received).toEqual({ signedMinor: 10_000, currency: 'USD' });
  });

  it('shows no arriving leg when the row carries no counter pair', () => {
    const display = transferDisplay(
      transfer({ counter_amount_minor: null, counter_currency: null }),
      nameOf,
    );

    expect(display.received).toBeNull();
    expect(display.sent).toEqual({ signedMinor: -10_000, currency: 'USD' });
  });
});
