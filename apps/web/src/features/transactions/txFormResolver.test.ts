import { zodResolver } from '@hookform/resolvers/zod';
import { multiCurrencyTransactionFormSchema } from '@budget/shared';
import type { MultiCurrencyTransactionFormInput } from '@budget/shared';
import { describe, expect, it } from 'vitest';

// The one novel RHF mechanic in W1: the multi-currency schema validates at the
// OBJECT level (the amount's exponent depends on a sibling field), so its issues
// are attached with an explicit `path` instead of being raised by a field schema.
// These cases pin that zodResolver still routes them to the right FIELD — if it
// ever flattened them to the form root, every money error in the transaction form
// would silently become an unattributed banner.
const resolver = zodResolver(multiCurrencyTransactionFormSchema('RUB'));

const values: MultiCurrencyTransactionFormInput = {
  amount: '10',
  currency: 'USD',
  base_amount: '',
  kind: 'expense',
  category_id: '',
  occurred_at: '2026-08-15',
  note: '',
};

describe('multi-currency schema through zodResolver', () => {
  it('returns the TRANSFORMED output (minor units) on success', async () => {
    const result = await resolver({ ...values, base_amount: '900' }, undefined, {
      fields: {},
      shouldUseNativeValidation: false,
    });
    expect(result.errors).toEqual({});
    expect(result.values).toMatchObject({ amount: 1000, base_amount_minor: 90000 });
  });

  it('routes an object-level amount issue to the amount field, not the form root', async () => {
    const result = await resolver({ ...values, amount: '1.5', currency: 'JPY' }, undefined, {
      fields: {},
      shouldUseNativeValidation: false,
    });
    expect(result.errors.amount?.message).toBeTruthy();
    expect(result.errors.base_amount).toBeUndefined();
  });

  it('routes a base_amount issue to the base_amount field', async () => {
    const result = await resolver({ ...values, base_amount: '9.001' }, undefined, {
      fields: {},
      shouldUseNativeValidation: false,
    });
    expect(result.errors.base_amount?.message).toBeTruthy();
    expect(result.errors.amount).toBeUndefined();
  });
});
