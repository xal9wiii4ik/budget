import { zodResolver } from '@hookform/resolvers/zod';
import { transferFormSchema } from '@budget/shared';
import type { TransferFormInput } from '@budget/shared';
import { describe, expect, it } from 'vitest';

// The transfer form's whole validation story is OBJECT-LEVEL: both amounts are
// parsed with exponents that come from OTHER fields (the two accounts), and the
// "not the same account" rule is a relation between two fields. Zod attaches such
// issues with an explicit `path`, and these cases pin that zodResolver still
// routes each of them to the FIELD the user can fix — if it ever flattened them
// to the form root, "you typed too many decimals for yen" would become an
// unattributed banner over a form with two amount inputs.
const ACCOUNTS: Record<string, string> = {
  'acc-usd': 'USD',
  'acc-jpy': 'JPY', // exponent 0 — the contrast that catches a fixed-exponent parse
};

const resolver = zodResolver(transferFormSchema((id) => ACCOUNTS[id]));

const values: TransferFormInput = {
  account_id: 'acc-usd',
  counter_account_id: 'acc-jpy',
  amount: '10',
  counter_amount: '1500',
  occurred_at: '2026-08-15',
  note: '',
};

const options = { fields: {}, shouldUseNativeValidation: false } as const;

describe('transferFormSchema through zodResolver', () => {
  it('parses each leg at ITS OWN account exponent', async () => {
    const result = await resolver(values, undefined, options);

    expect(result.errors).toEqual({});
    // 10 USD -> 1000 minor (exponent 2); 1500 JPY -> 1500 minor (exponent 0).
    // A single shared exponent would make one of these 100x wrong.
    expect(result.values).toMatchObject({
      amount_minor: 1000,
      currency: 'USD',
      counter_amount_minor: 1500,
      counter_currency: 'JPY',
    });
  });

  it('routes a counter-leg exponent issue to counter_amount, not to amount', async () => {
    // "15.50" is a fine USD amount and an impossible JPY one; the issue must land
    // on the JPY side.
    const result = await resolver({ ...values, counter_amount: '15.50' }, undefined, options);

    expect(result.errors.counter_amount?.message).toBeTruthy();
    expect(result.errors.amount).toBeUndefined();
  });

  it('reports the same-account transfer on the TARGET select', async () => {
    const result = await resolver(
      { ...values, counter_account_id: 'acc-usd' },
      undefined,
      options,
    );

    expect(result.errors.counter_account_id?.message).toBeTruthy();
    // Not the form root, and not the source select — the target is the control
    // the user came to change.
    expect(result.errors.account_id).toBeUndefined();
  });

  it('reports an unpicked target on its own field and parses no amount from it', async () => {
    const result = await resolver(
      { ...values, counter_account_id: '', counter_amount: '15.50' },
      undefined,
      options,
    );

    expect(result.errors.counter_account_id?.message).toBeTruthy();
    // With no account there is no honest exponent, so the amount is NOT judged
    // (and certainly not judged at the source's exponent, where "15.50" passes).
    expect(result.errors.counter_amount).toBeUndefined();
  });

  it('rejects a leg whose account is not in the list at all (stale cache)', async () => {
    const result = await resolver({ ...values, account_id: 'acc-gone' }, undefined, options);

    expect(result.errors.account_id?.message).toBeTruthy();
    expect(result.errors.amount).toBeUndefined();
  });
});
