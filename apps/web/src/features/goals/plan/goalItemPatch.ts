// PATCH body for one plan item: a DIFF against output-shaped initial values —
// unchanged → OMIT, cleared → explicit `null`, changed → value (the house patch
// discipline; the builders in `@budget/api-client` are shared with mobile, and
// this form has no mobile twin, so it stays beside the feature).
//
// Two server rules shape it (routers/goal_items.py `update_goal_item`):
//   * `name` / `currency` are NOT NULL columns — an explicit null is a
//     `*_REQUIRED` 422, so they are emitted only when changed, never as null;
//   * sending `amount_minor` or `currency` makes the server RECOMPUTE the
//     goal-currency amount. That is why an override the user CLEARED is sent as
//     an explicit `null` (discard and recompute) and an unchanged one is omitted:
//     the modal clears the field on a currency change, so a stale override can
//     never be re-stamped as if the user had just typed it.
import type { GoalItemUpdate } from '../../../data/goalItems';
import type { GoalItemFormValues } from './goalItemFormSchema';

function nullableChange<T>(next: T | null, previous: T | null): T | null | undefined {
  if (next === previous) return undefined;
  return next;
}

function sameLinks(next: readonly string[], previous: readonly string[]): boolean {
  return next.length === previous.length && next.every((link, i) => link === previous[i]);
}

export function buildGoalItemPatch(
  values: GoalItemFormValues,
  initial: GoalItemFormValues,
): GoalItemUpdate {
  const patch: GoalItemUpdate = {};

  if (values.name !== initial.name) patch.name = values.name;
  if (values.currency !== initial.currency) patch.currency = values.currency;

  const description = nullableChange(values.description, initial.description);
  if (description !== undefined) patch.description = description;

  // A list is never "cleared to null": an empty list IS the cleared state, and
  // the server normalises `null` to `[]` anyway.
  if (!sameLinks(values.links, initial.links)) patch.links = values.links;

  const amount = nullableChange(values.amount_minor, initial.amount_minor);
  if (amount !== undefined) patch.amount_minor = amount;

  const converted = nullableChange(values.converted_minor, initial.converted_minor);
  if (converted !== undefined) patch.converted_minor = converted;

  // An explicit null RESTORES inheritance — the server never writes the date the
  // node was merely showing (task.md).
  const deadline = nullableChange(values.deadline, initial.deadline);
  if (deadline !== undefined) patch.deadline = deadline;

  // The reminder is exactly one intent or none, so switching between the two
  // emits BOTH keys: the new value and an explicit null clearing the other.
  const remindOn = nullableChange(values.remind_on, initial.remind_on);
  if (remindOn !== undefined) patch.remind_on = remindOn;
  const remindDays = nullableChange(values.remind_days_before, initial.remind_days_before);
  if (remindDays !== undefined) patch.remind_days_before = remindDays;

  return patch;
}
