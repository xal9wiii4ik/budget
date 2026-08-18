import { parseMoney, transactionFormSchema } from '@budget/shared';
import { describe, expect, it } from 'vitest';

import { normalizeAmountInput } from './amountInput';

describe('normalizeAmountInput — ru decimal-pad comma (F-1)', () => {
  it('treats a single comma as the decimal point', () => {
    expect(normalizeAmountInput('7,77')).toBe('7.77');
    expect(normalizeAmountInput(',5')).toBe('.5');
  });

  it('leaves a single dot and separator-less input untouched', () => {
    expect(normalizeAmountInput('7.77')).toBe('7.77');
    expect(normalizeAmountInput('777')).toBe('777');
    expect(normalizeAmountInput('')).toBe('');
  });

  it('passes ambiguous / malformed multi-separator input through unchanged', () => {
    // Two or more separators: we do not guess a thousands grouping. Untouched input
    // means the shared parser is the one that rejects it.
    expect(normalizeAmountInput('1.234,56')).toBe('1.234,56');
    expect(normalizeAmountInput('7,,77')).toBe('7,,77');
    expect(normalizeAmountInput('1,2,3')).toBe('1,2,3');
  });
});

describe('normalizeAmountInput + shared money contract', () => {
  it('makes a comma amount parse to the same minor units as the dot form', () => {
    expect(parseMoney(normalizeAmountInput('7,77'), 'RUB')).toEqual(
      parseMoney(normalizeAmountInput('7.77'), 'RUB'),
    );
    expect(parseMoney(normalizeAmountInput('7,77'), 'RUB')).toEqual({ ok: true, minor: 777 });
  });

  it('still rejects the ambiguous forms through the form schema', () => {
    const schema = transactionFormSchema('RUB');
    const values = { kind: 'expense', category_id: '', occurred_at: '2026-08-18', note: '' };

    expect(schema.safeParse({ ...values, amount: normalizeAmountInput('7,77') }).success).toBe(
      true,
    );
    for (const bad of ['1.234,56', '7,,77', '1,2,3']) {
      expect(schema.safeParse({ ...values, amount: normalizeAmountInput(bad) }).success).toBe(
        false,
      );
    }
  });
});
