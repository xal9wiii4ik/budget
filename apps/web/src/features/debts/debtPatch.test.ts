import { describe, expect, it } from 'vitest';

import type { DebtFormValues, RepaymentFormValues } from './debtFormSchema';
import { buildDebtPatch, buildRepaymentPatch } from './debtPatch';

const initial: DebtFormValues = {
  direction: 'lent',
  counterparty: 'Иван',
  currency: 'USD',
  amount_minor: 10000,
  account_id: 'acc-usd',
  // Same currency as the debt: there is no second figure.
  account_amount_minor: null,
  opened_on: '2026-09-01',
  due_on: '2026-10-01',
  note: 'за велосипед',
};

describe('buildDebtPatch', () => {
  it('omits every unchanged field', () => {
    expect(buildDebtPatch({ ...initial }, initial)).toEqual({});
  });

  it('sends only what changed', () => {
    expect(buildDebtPatch({ ...initial, counterparty: 'Иван П.' }, initial)).toEqual({
      counterparty: 'Иван П.',
    });
  });

  it('clears the nullable pair with an explicit null', () => {
    // A dropped key would silently keep the old deadline and the old note; the
    // server reads `null` as "clear it".
    expect(buildDebtPatch({ ...initial, due_on: null, note: null }, initial)).toEqual({
      due_on: null,
      note: null,
    });
  });

  it('never sends direction or currency, even when the form values differ', () => {
    // Both are immutable server-side and absent from DebtUpdate; the baseline is
    // only a diff baseline.
    const patch = buildDebtPatch(
      { ...initial, direction: 'borrowed', currency: 'BYN' },
      initial,
    );

    expect(patch).toEqual({});
  });

  it('sends the account amount with a cross-currency account move, unchanged or not', () => {
    // Moving the movement onto an account in ANOTHER currency: the pair must
    // travel together (AMOUNT_REQUIRED_ON_CURRENCY_CHANGE /
    // DEBT_ACCOUNT_AMOUNT_REQUIRED), so the figure is emitted because the ACCOUNT
    // changed — not because the number did.
    expect(
      buildDebtPatch(
        { ...initial, account_id: 'acc-byn', account_amount_minor: 33000 },
        initial,
      ),
    ).toEqual({ account_id: 'acc-byn', account_amount_minor: 33000 });
  });

  it('omits the account amount when the move lands on the debt currency', () => {
    const crossCurrency: DebtFormValues = {
      ...initial,
      account_id: 'acc-byn',
      account_amount_minor: 33000,
    };

    // The opposite move: back onto an account that shares the debt's currency, so
    // the second figure stops existing. The key must be OMITTED and not sent as
    // `null` — an explicit null on it is a 422 DEBT_ACCOUNT_AMOUNT_REQUIRED, and
    // the server copies the debt amount onto the movement itself.
    expect(
      buildDebtPatch({ ...initial, account_id: 'acc-usd', account_amount_minor: null }, crossCurrency),
    ).toEqual({ account_id: 'acc-usd' });
  });

  it('sends a corrected account amount on its own when the account did not move', () => {
    const crossCurrency: DebtFormValues = {
      ...initial,
      account_id: 'acc-byn',
      account_amount_minor: 33000,
    };

    expect(
      buildDebtPatch({ ...crossCurrency, account_amount_minor: 33500 }, crossCurrency),
    ).toEqual({ account_amount_minor: 33500 });
  });
});

const initialRepayment: RepaymentFormValues = {
  amount_minor: 2500,
  account_id: 'acc-usd',
  account_amount_minor: null,
  occurred_at: '2026-09-20',
  note: null,
};

describe('buildRepaymentPatch', () => {
  it('omits every unchanged field', () => {
    expect(buildRepaymentPatch({ ...initialRepayment }, initialRepayment)).toEqual({});
  });

  it('sends a changed amount and date, and sets a note that was empty', () => {
    expect(
      buildRepaymentPatch(
        { ...initialRepayment, amount_minor: 3000, occurred_at: '2026-09-21', note: 'частично' },
        initialRepayment,
      ),
    ).toEqual({ amount_minor: 3000, occurred_at: '2026-09-21', note: 'частично' });
  });

  it('carries the account amount along with a cross-currency account move', () => {
    expect(
      buildRepaymentPatch(
        { ...initialRepayment, account_id: 'acc-byn', account_amount_minor: 8250 },
        initialRepayment,
      ),
    ).toEqual({ account_id: 'acc-byn', account_amount_minor: 8250 });
  });
});
