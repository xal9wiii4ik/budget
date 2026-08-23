// Which words the transaction form uses, per kind.
//
// The form is one form: an income is not a different entity, it is the same row
// with the sign flipped. But "Account / Spent / Charged to the account" is
// expense wording, and reading it while typing in a salary is what the income
// complaint was about. So every direction-dependent label is looked up HERE by
// the watched `kind` and derived during render — no second copy of the kind in
// state, no effect rewriting labels after the radio flips.
//
// Only direction-dependent copy lives in this table. Rate and conversion strings
// (chargeNoRateAhead, chargeEstimate, chargeRecalc*, converted*) are deliberately
// absent: they talk about exchange rates, which have no direction, and doubling
// them would double the Russian review surface for nothing.
//
// No test, on purpose: it is a lookup table whose only failure mode (a key that
// does not exist) is a typecheck error, and a test asserting the table equals
// itself is the vacuous test the house rule forbids.
import type { SimpleKey } from '../../i18n/t';

export type TransactionKind = 'expense' | 'income';

export interface KindCopy {
  /** AccountField label: which account the money left / landed on. */
  account: SimpleKey;
  /** Single-amount mode ({currency}). */
  amountLabel: SimpleKey;
  /** Pair mode, the amount in the OTHER currency ({currency}). */
  spentLabel: SimpleKey;
  /** Visible label + hint of the spend-currency picker. */
  spendCurrencyLabel: SimpleKey;
  spendCurrencyHint: SimpleKey;
  /** Pair mode, the amount that hits the account ({currency}). */
  chargedLabel: SimpleKey;
  /** The three sentences about that amount being left to the server. */
  chargeDefault: SimpleKey;
  chargeManual: SimpleKey;
  manualChargeRequired: SimpleKey;
  /** The `merchant` column: a shop for an expense, a payer for an income. */
  merchantLabel: SimpleKey;
  /**
   * Income needs a sentence saying WHAT to write there ("Source" alone reads as
   * a dropdown); expense's "Name / place" is self-explanatory, so it has none.
   */
  merchantHint: SimpleKey | null;
}

export const KIND_COPY: Record<TransactionKind, KindCopy> = {
  expense: {
    account: 'txForm.accountExpense',
    amountLabel: 'txForm.amountLabel',
    spentLabel: 'txForm.spentLabel',
    spendCurrencyLabel: 'txForm.spendCurrencyLabel',
    spendCurrencyHint: 'txForm.spendCurrencyHint',
    chargedLabel: 'txForm.chargedLabel',
    chargeDefault: 'txForm.chargeDefault',
    chargeManual: 'txForm.chargeManual',
    manualChargeRequired: 'txForm.manualChargeRequired',
    merchantLabel: 'txForm.merchantLabel',
    merchantHint: null,
  },
  income: {
    account: 'txForm.accountIncome',
    amountLabel: 'txForm.amountLabelIncome',
    spentLabel: 'txForm.receivedLabel',
    spendCurrencyLabel: 'txForm.spendCurrencyLabelIncome',
    spendCurrencyHint: 'txForm.spendCurrencyHintIncome',
    chargedLabel: 'txForm.creditedLabel',
    chargeDefault: 'txForm.chargeDefaultIncome',
    chargeManual: 'txForm.chargeManualIncome',
    manualChargeRequired: 'txForm.manualChargeRequiredIncome',
    merchantLabel: 'txForm.merchantLabelIncome',
    merchantHint: 'txForm.merchantHintIncome',
  },
};
