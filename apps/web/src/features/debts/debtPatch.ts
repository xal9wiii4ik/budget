// PATCH bodies for a debt and for one of its repayments: DIFFS against
// output-shaped initial values — unchanged → OMIT, cleared → explicit `null`,
// changed → value (the house patch discipline). Beside the feature rather than in
// `@budget/api-client` for the `buildDepositPatch` reason: the builders there are
// SHARED with the frozen mobile client, while these forms are web-local.
//
// Four server rules shape them (architecture.md §Endpoints, §Currency):
//
//   * `direction` and `currency` have NO patch representation at all — both are
//     immutable by schema and absent from `DebtUpdate`. Getting a debt's
//     direction wrong is fixed by deleting it and recording it again, which is
//     what the real DELETE exists for;
//   * `counterparty` / `amount_minor` / `account_id` / `opened_on` /
//     `occurred_at` map to NOT NULL columns — an explicit null is a
//     `DEBT_<FIELD>_REQUIRED` 422 — so they are emitted only when changed and
//     never as null;
//   * `due_on` and `note` are the nullable pair: cleared means "no deadline" and
//     "no comment", and BOTH need an explicit null to say so. A dropped key would
//     silently keep the old deadline;
//   * `account_amount_minor` is the one non-obvious rule, and the reason this
//     module is tested. It is the movement's figure in the ACCOUNT's currency,
//     and it exists only while that currency differs from the debt's. It belongs
//     to the NOT-NULL group above — `null` on it is a 422
//     `DEBT_ACCOUNT_AMOUNT_REQUIRED` (routers/debts.py: the same NOT-NULL-fact
//     loop that guards `account_id`) — so the key is emitted ONLY with a number:
//     when the account moved onto one in ANOTHER currency (the figure must travel
//     with the pair even if the number itself did not change —
//     `AMOUNT_REQUIRED_ON_CURRENCY_CHANGE`), or when the number itself changed to
//     a number. In every other case the key is OMITTED, never null — a move onto
//     an account that SHARES the debt's currency included: there the server
//     copies the debt amount itself (`services/debt_writes.py::update_movement`,
//     `eff_currency == debt.currency`), so nothing stale survives and there is
//     nothing for the client to say.
import type { DebtRepaymentUpdate, DebtUpdate } from '../../data/debts';
import type { DebtFormValues, RepaymentFormValues } from './debtFormSchema';

function nullableChange<T>(next: T | null, previous: T | null): T | null | undefined {
  if (next === previous) return undefined;
  return next;
}

/**
 * The `account_amount_minor` key for a movement patch, or `undefined` to omit it.
 *
 * Never `null` — see the module header: the field is a NOT NULL fact the server
 * refuses to clear, and `null` in the form values means "the account shares the
 * debt's currency, so there is no second figure", which is exactly the case the
 * server handles by copying.
 *
 * `accountChanged` is passed in rather than re-derived: both callers have just
 * computed it for their own `account_id` key, and the rule reads better as "did
 * the account move" than as a second comparison of the same two ids.
 */
function accountAmountKey(
  next: number | null,
  previous: number | null,
  accountChanged: boolean,
): number | undefined {
  if (next === null) return undefined;
  if (accountChanged) return next;
  return next === previous ? undefined : next;
}

export function buildDebtPatch(values: DebtFormValues, initial: DebtFormValues): DebtUpdate {
  const patch: DebtUpdate = {};

  if (values.counterparty !== initial.counterparty) patch.counterparty = values.counterparty;
  if (values.amount_minor !== initial.amount_minor) patch.amount_minor = values.amount_minor;

  const accountChanged = values.account_id !== initial.account_id;
  if (accountChanged) patch.account_id = values.account_id;

  const accountAmount = accountAmountKey(
    values.account_amount_minor,
    initial.account_amount_minor,
    accountChanged,
  );
  if (accountAmount !== undefined) patch.account_amount_minor = accountAmount;

  if (values.opened_on !== initial.opened_on) patch.opened_on = values.opened_on;

  const dueOn = nullableChange(values.due_on, initial.due_on);
  if (dueOn !== undefined) patch.due_on = dueOn;

  const note = nullableChange(values.note, initial.note);
  if (note !== undefined) patch.note = note;

  return patch;
}

export function buildRepaymentPatch(
  values: RepaymentFormValues,
  initial: RepaymentFormValues,
): DebtRepaymentUpdate {
  const patch: DebtRepaymentUpdate = {};

  if (values.amount_minor !== initial.amount_minor) patch.amount_minor = values.amount_minor;

  const accountChanged = values.account_id !== initial.account_id;
  if (accountChanged) patch.account_id = values.account_id;

  const accountAmount = accountAmountKey(
    values.account_amount_minor,
    initial.account_amount_minor,
    accountChanged,
  );
  if (accountAmount !== undefined) patch.account_amount_minor = accountAmount;

  if (values.occurred_at !== initial.occurred_at) patch.occurred_at = values.occurred_at;

  const note = nullableChange(values.note, initial.note);
  if (note !== undefined) patch.note = note;

  return patch;
}
