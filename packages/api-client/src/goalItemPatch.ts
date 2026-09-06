// PATCH body for one plan item: a DIFF against output-shaped initial values —
// unchanged → OMIT, cleared → explicit `null`, changed → value (the house patch
// discipline). It lives in @budget/api-client with the other patch builders
// (mobile-catchup-3, line C): the mobile plan screen builds the same PATCH from
// the same field set, and a second copy of "cleared means recompute" is exactly
// the kind of second opinion about money this project does not keep. Each client
// still owns its zod schema — the messages there are dictionary keys.
//
// Two server rules shape it (routers/goal_items.py `update_goal_item`):
//   * `name` / `currency` are NOT NULL columns — an explicit null is a
//     `*_REQUIRED` 422, so they are emitted only when changed, never as null;
//   * sending `amount_minor` or `currency` makes the server RECOMPUTE the
//     goal-currency amount. That is why an override the user CLEARED is sent as
//     an explicit `null` (discard and recompute) and an unchanged one is omitted:
//     the modal clears the field on a currency change, so a stale override can
//     never be re-stamped as if the user had just typed it.
import type { components } from './generated/schema';

type GoalItemUpdate = components['schemas']['GoalItemUpdate'];

/**
 * The OUTPUT shape of a plan-item form — the same field set on both clients, so
 * the diff rules live here while each client keeps its own zod schema (the
 * messages are dictionary keys, and the two dictionaries are disjoint).
 */
export interface GoalItemFormValues {
  name: string;
  description: string | null;
  links: string[];
  amount_minor: number | null;
  currency: string;
  /** The user's override in the GOAL's currency; null = "let the server compute". */
  converted_minor: number | null;
  deadline: string | null;
  remind_on: string | null;
  remind_days_before: number | null;
}

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
