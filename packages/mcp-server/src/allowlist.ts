/**
 * The curated tool table — architecture §4, verbatim in shape and order.
 *
 * Nothing here is discovered at runtime: the server's fail-closed PAT allowlist
 * is the security boundary, this list is the PRODUCT surface (what an AI client
 * is worth exposing) and the source of the English prose the model actually
 * reads. Schemas are generated from openapi.json — see `tools.ts`.
 *
 * All 24 tools of architecture §4 live here: 13 `read` (S3) and 11 `write` (S4).
 * The write descriptions are a SAFETY mechanism, not documentation — they are
 * the only place that tells the model minor-units, "one entity per call", "look
 * before you create" and "fix, do not delete". Edit them like code.
 */

export type ToolScope = 'read' | 'write';

/**
 * How the PACKAGE fills a body property the model never sees.
 *
 * `uuid`: a fresh v4 UUID per logical tool call (see `managedBody` below).
 */
export type ManagedBodyValue = 'uuid';

export interface ToolSpec {
  /** MCP tool name, exactly as in architecture §4. */
  readonly name: string;
  readonly method: 'get' | 'post' | 'patch' | 'put' | 'delete';
  /** OpenAPI path template, e.g. `/goals/{goal_id}/contributions`. */
  readonly path: string;
  /** `write` tools are published only to a `full` token (see index.ts). */
  readonly scope: ToolScope;
  /** Curated description; handed to the model as-is. */
  readonly description: string;
  /** Property name → curated description. Unknown names fail startup. */
  readonly params?: Readonly<Record<string, string>>;
  /**
   * Body properties the MODEL must not see: property name → how the package
   * fills it. They are removed from the tool's input schema (the model can
   * neither read nor forge them) and written into the JSON body by `http.ts`.
   * A name the request body does not have fails startup, like every other
   * allowlist ↔ contract drift.
   */
  readonly managedBody?: Readonly<Record<string, ManagedBodyValue>>;
}

/** Repeated verbatim so paging advice is identical across list tools. */
const LIMIT = 'How many rows to return — keep it at 100 or less.';
const OFFSET = 'How many rows to skip, for paging through older rows.';
const PERIOD =
  'Which period grammar to use: `month` (with `month`), `quarter` (with `quarter`), ' +
  '`year` (with `year`) or `custom` (with `from` and `to`).';
const MONTH = 'Month as YYYY-MM, used when `period` is `month`.';
const QUARTER = 'Quarter as YYYY-Qn (e.g. 2026-Q1), used when `period` is `quarter`.';
const YEAR = 'Four-digit year, used when `period` is `year`.';
const FROM = 'Start date (inclusive) as YYYY-MM-DD, used when `period` is `custom`.';
const TO = 'End date (inclusive) as YYYY-MM-DD, used when `period` is `custom`.';

const MINOR_UNITS =
  'Amount in INTEGER MINOR UNITS: 12.34 EUR is 1234; JPY has no minor unit, so 500 JPY is 500. ' +
  'Never scale or convert it yourself — use convert_currency.';
const CURRENCY_IN =
  'Currency of `amount_minor`, ISO 4217 uppercase (e.g. EUR). Omit it only when the amount is ' +
  'already in the user\'s base currency (get_stats_summary.currency) — the server stamps that.';
const CATEGORY_ID = 'Category id from list_categories — never guess or invent one.';
const KEEP =
  'Omitted fields keep their current value; there is no way to clear a field through this server.';

export const ALLOWLIST: readonly ToolSpec[] = [
  {
    name: 'list_transactions',
    method: 'get',
    path: '/transactions',
    scope: 'read',
    description:
      'Search and filter the user\'s transactions by period, category and direction. ' +
      'Returns individual rows with their ids — this is where every `transaction_id` comes from. ' +
      'For totals use get_transactions_summary instead of adding rows up yourself. ' +
      'Keep `limit` at 100 or less and page with `offset`.',
    params: {
      from: 'Start date (inclusive) as YYYY-MM-DD.',
      to: 'End date (inclusive) as YYYY-MM-DD.',
      category_id: 'Only this category; take the id from list_categories.',
      kind: 'Only expenses or only income.',
      limit: LIMIT,
      offset: OFFSET,
    },
  },
  {
    name: 'get_transactions_summary',
    method: 'get',
    path: '/transactions/summary',
    scope: 'read',
    description:
      'Totals per category for ONE month, computed by the server in the base currency. ' +
      'Prefer it over summing list_transactions yourself — amounts in different currencies ' +
      'are converted server-side with the stored daily rate.',
    params: { month: 'Month to summarise, as YYYY-MM.' },
  },
  {
    name: 'list_categories',
    method: 'get',
    path: '/categories',
    scope: 'read',
    description:
      'List the user\'s categories with their ids and structure. This is where every ' +
      '`category_id` comes from — never guess one. System categories are shared and read-only.',
    params: { include_archived: 'Also return archived categories (default false).' },
  },
  {
    name: 'list_goals',
    method: 'get',
    path: '/goals',
    scope: 'read',
    description:
      'Overview of the savings goals: target, saved so far and base currency. ' +
      'This is where every `goal_id` comes from.',
    params: { include_archived: 'Also return archived goals (default false).' },
  },
  {
    name: 'get_goal',
    method: 'get',
    path: '/goals/{goal_id}',
    scope: 'read',
    description: 'Details of ONE savings goal. Take `goal_id` from list_goals, never guess it.',
    params: { goal_id: 'Goal id from list_goals.' },
  },
  {
    name: 'get_goal_progress',
    method: 'get',
    path: '/goals/{goal_id}/progress',
    scope: 'read',
    description:
      'Progress series for ONE goal — the pace and projection are computed by the server, ' +
      'do not recompute them. Take `goal_id` from list_goals.',
    params: {
      goal_id: 'Goal id from list_goals.',
      months: 'How many months of history to include (1-60).',
    },
  },
  {
    name: 'list_goal_contributions',
    method: 'get',
    path: '/goals/{goal_id}/contributions',
    scope: 'read',
    description:
      'Contribution history of ONE goal, newest first. Take `goal_id` from list_goals. ' +
      'Keep `limit` at 100 or less and page with `offset`.',
    params: { goal_id: 'Goal id from list_goals.', limit: LIMIT, offset: OFFSET },
  },
  {
    name: 'list_limits',
    method: 'get',
    path: '/limits',
    scope: 'read',
    description:
      'Monthly spending limits per category together with the amount already spent — ' +
      'the spend is computed by the server in the base currency, do not recompute it.',
    params: { month: 'Month as YYYY-MM; defaults to the current month.' },
  },
  {
    name: 'list_recurring',
    method: 'get',
    path: '/recurring',
    scope: 'read',
    description:
      'List recurring payment templates (rent, subscriptions) with their schedule, ' +
      'next due date and paused state. This is where every `template_id` comes from.',
  },
  {
    name: 'get_stats_summary',
    method: 'get',
    path: '/stats/summary',
    scope: 'read',
    description:
      'Income, expense and net totals for a period, plus the user\'s base currency in ' +
      '`currency` — that is the currency every other total is expressed in. Server-side math: ' +
      'never convert or sum amounts yourself.',
    params: { period: PERIOD, month: MONTH, quarter: QUARTER, year: YEAR, from: FROM, to: TO },
  },
  {
    name: 'get_stats_monthly',
    method: 'get',
    path: '/stats/monthly',
    scope: 'read',
    description: 'Month-by-month income/expense trend in the base currency, computed by the server.',
    params: { months: 'How many months back to return (1-60).' },
  },
  {
    name: 'get_top_merchants',
    method: 'get',
    path: '/stats/top-merchants',
    scope: 'read',
    description:
      'The merchants the user spent most with in a period, in the base currency. ' +
      'Same period grammar as get_stats_summary.',
    params: {
      limit: 'How many merchants to return (1-50).',
      period: PERIOD,
      month: MONTH,
      quarter: QUARTER,
      year: YEAR,
      from: FROM,
      to: TO,
    },
  },
  {
    name: 'convert_currency',
    method: 'get',
    path: '/fx/convert',
    scope: 'read',
    description:
      'Convert an amount between currencies at the server\'s daily rate. Use this for ANY ' +
      'cross-currency figure — never multiply amounts yourself. Minor units in and out.',
    params: {
      amount_minor: 'Amount in MINOR units of the source currency: 12.34 EUR is 1234; JPY has no minor unit, so 500 JPY is 500.',
      from: 'Source currency, ISO 4217 uppercase (e.g. EUR).',
      to: 'Target currency, ISO 4217 uppercase (e.g. USD).',
      date: 'Rate date as YYYY-MM-DD; defaults to the most recent rate.',
    },
  },

  // ---------------------------------------------------------------- write ---
  // Published only to a `full` token (index.ts). The server's fail-closed
  // allowlist is the enforcement; these texts are what keeps a well-behaved
  // model from duplicating, deleting or mis-scaling the user's money.
  {
    name: 'create_transaction',
    method: 'post',
    path: '/transactions',
    scope: 'write',
    description:
      'Record ONE transaction. Amounts are INTEGER MINOR UNITS with an explicit `currency`: ' +
      '12.34 EUR → amount_minor 1234; JPY has no minor unit → 500 JPY is 500. Never do money math ' +
      'yourself — use convert_currency. BEFORE creating, call list_transactions for the same date ' +
      'and amount: if it is there do NOT duplicate — fix it with update_transaction; the id is ' +
      'echoed back.',
    // The model never sees or sets `client_id`: this server generates one per
    // logical call so a replayed HTTP attempt returns the SAVED row instead of
    // creating a second transaction (architecture §6, B-1).
    managedBody: { client_id: 'uuid' },
    params: {
      amount_minor: MINOR_UNITS + ' Always positive — `kind` says whether it is money in or out.',
      currency: CURRENCY_IN,
      kind: 'Whether this is an expense (money out) or income (money in).',
      occurred_at: 'The date the money moved, as YYYY-MM-DD.',
      category_id: CATEGORY_ID + ' Omit it if the user did not say which category.',
      merchant: 'Who was paid or who paid, as the user named them.',
      note: 'Free-text note from the user.',
      base_amount_minor:
        'Only when the user states the exact converted amount they were charged in their base ' +
        'currency, in minor units. Omit it and the server converts at its own daily rate — that ' +
        'is the normal case.',
      receipt_id:
        'Leave this out: receipts are attached in the web and mobile apps, and there is no way to ' +
        'obtain a receipt id here.',
    },
  },
  {
    name: 'update_transaction',
    method: 'patch',
    path: '/transactions/{transaction_id}',
    scope: 'write',
    description:
      'Correct ONE existing transaction. Send only the fields that change; omitted fields keep ' +
      'their value. PREFER this tool over delete_transaction for fixing mistakes. Take ' +
      'transaction_id from list_transactions, never guess it.',
    params: {
      transaction_id: 'Transaction id from list_transactions.',
      amount_minor: MINOR_UNITS,
      currency: CURRENCY_IN,
      kind: 'Change between expense and income.',
      occurred_at: 'New date of the transaction, as YYYY-MM-DD.',
      category_id: CATEGORY_ID,
      merchant: 'New merchant name.',
      note: 'New note. ' + KEEP,
      base_amount_minor:
        'Only when the user states the exact converted amount in their base currency, in minor ' +
        'units; otherwise omit it and let the server keep or recompute its own conversion.',
    },
  },
  {
    name: 'delete_transaction',
    method: 'delete',
    path: '/transactions/{transaction_id}',
    scope: 'write',
    description:
      'PERMANENTLY delete ONE transaction — the ONLY irreversible tool. Use it ONLY when the user ' +
      'has EXPLICITLY asked to delete this specific transaction. If in ANY doubt, first show the ' +
      'transaction you found (list_transactions) and ask the user to confirm. To fix mistakes ' +
      'prefer update_transaction. One entity per call — there is no bulk delete, no deletion by ' +
      'filter or by list of ids. Take transaction_id from list_transactions, never guess it.',
    params: { transaction_id: 'Transaction id from list_transactions, confirmed with the user.' },
  },
  {
    name: 'create_category',
    method: 'post',
    path: '/categories',
    scope: 'write',
    description:
      'Create ONE new category. Call list_categories FIRST: the account already ships with system ' +
      'categories, and a near-duplicate ("Food" next to an existing "Groceries") only splits the ' +
      "user's history in two. The new id comes back in the response.",
    params: {
      name: 'Category name as the user would write it.',
      kind: 'Whether this category is for expenses or for income.',
      color: 'Hex colour like #4F46E5. Optional.',
      icon: 'Icon name. Optional — omit it unless the user asked for one.',
    },
  },
  {
    name: 'update_category',
    method: 'patch',
    path: '/categories/{category_id}',
    scope: 'write',
    description:
      'Rename or ARCHIVE one category. Archiving IS deletion in this product: categories are ' +
      'referenced by past transactions, so they are archived, not destroyed — history is ' +
      'preserved. There is no delete_category tool by design. System categories are read-only.',
    params: {
      category_id: CATEGORY_ID,
      name: 'New name.',
      kind: 'Change between an expense and an income category.',
      archived:
        'true archives the category (this is what "delete a category" means here) and it stops ' +
        'being offered for new transactions; false brings it back. ' + KEEP,
      color: 'New hex colour like #4F46E5.',
      icon: 'New icon name.',
    },
  },
  {
    name: 'create_recurring',
    method: 'post',
    path: '/recurring',
    scope: 'write',
    description:
      'Create ONE recurring template — a schedule (rent, salary, a subscription), NOT a ' +
      'transaction: the server posts the actual transactions when they fall due, so do not also ' +
      'call create_transaction for them. A monthly template needs `day_of_month`, a weekly one ' +
      'needs `weekday`. Amounts are INTEGER MINOR UNITS — never do money math yourself.',
    params: {
      name: 'What the user calls this payment, e.g. "Rent".',
      amount_minor: MINOR_UNITS,
      currency: CURRENCY_IN,
      kind: 'Whether each generated transaction is an expense or income.',
      interval_unit: 'How often it repeats: every month or every week.',
      day_of_month: 'Day of the month (1-31), required for a monthly template. A month that is ' +
        'shorter uses its last day.',
      weekday: 'Day of the week for a weekly template: 0 is Monday, 6 is Sunday.',
      category_id: CATEGORY_ID,
      merchant: 'Who is paid, as the user named them.',
      note: 'Free-text note carried onto each generated transaction.',
      end_date: 'Last date the template may generate, as YYYY-MM-DD. Omit for open-ended.',
      paused: 'true creates it paused — it generates nothing until resumed.',
    },
  },
  {
    name: 'update_recurring',
    method: 'patch',
    path: '/recurring/{template_id}',
    scope: 'write',
    description:
      'Change ONE recurring template. Send only the fields that change; omitted fields keep their ' +
      'value. Set `paused` to true to stop a subscription without losing its history — that is ' +
      'the intended way to end one, there is no delete tool here. Take template_id from ' +
      'list_recurring, never guess it. Amounts are INTEGER MINOR UNITS.',
    params: {
      template_id: 'Template id from list_recurring.',
      name: 'New name.',
      amount_minor: MINOR_UNITS,
      currency: CURRENCY_IN,
      kind: 'Change between expense and income.',
      interval_unit: 'Switch between monthly and weekly; send the matching `day_of_month` or ' +
        '`weekday` in the same call.',
      day_of_month: 'New day of the month (1-31) for a monthly template.',
      weekday: 'New day of the week for a weekly template: 0 is Monday, 6 is Sunday.',
      category_id: CATEGORY_ID,
      merchant: 'New merchant name.',
      note: 'New note. ' + KEEP,
      end_date: 'New end date as YYYY-MM-DD.',
      paused: 'true pauses generation, false resumes it.',
    },
  },
  {
    name: 'set_category_limit',
    method: 'put',
    path: '/limits/{category_id}',
    scope: 'write',
    description:
      'Set the monthly limit for ONE category — a full upsert: what you send REPLACES the current ' +
      'limit, it never adds a second one. amount_minor is in the user\'s base currency, which the ' +
      'server stamps. Only expense categories can carry a limit. Call list_limits first to see ' +
      "the current limit and this month's spend.",
    params: {
      category_id: CATEGORY_ID + ' Must be an expense category.',
      amount_minor:
        'The monthly cap in INTEGER MINOR UNITS of the base currency: 250 EUR is 25000; JPY has ' +
        'no minor unit, so 500 JPY is 500. Never scale or convert it yourself — use ' +
        'convert_currency and get_stats_summary.currency for the base currency.',
    },
  },
  {
    name: 'create_goal',
    method: 'post',
    path: '/goals',
    scope: 'write',
    description:
      'Create ONE savings goal. `target_minor` is in INTEGER MINOR UNITS of the goal `currency` ' +
      '(12.34 EUR → 1234; JPY has no minor unit → 500 JPY is 500) — never convert amounts ' +
      'yourself, use convert_currency. The new goal id comes back in the response; record money ' +
      'put aside with add_goal_contribution, not by raising the target.',
    params: {
      name: 'What the user calls this goal, e.g. "New laptop".',
      target_minor: 'The amount to reach, in INTEGER MINOR UNITS of `currency`.',
      currency: 'Currency of the goal, ISO 4217 uppercase (e.g. EUR).',
      deadline: 'Target date as YYYY-MM-DD. Optional.',
      initial_saved_minor:
        'Money already put aside when the goal is created, in minor units of `currency`. It is ' +
        'recorded as the first contribution — do not add the same money again.',
      priority: 'Ordering hint among goals; lower comes first. Optional.',
    },
  },
  {
    name: 'update_goal',
    method: 'patch',
    path: '/goals/{goal_id}',
    scope: 'write',
    description:
      'Change ONE savings goal. Send only the fields that change; omitted fields keep their ' +
      'value. `archived: true` retires a goal and keeps its contributions — that is how a goal is ' +
      '"removed", there is no delete tool. To record money put aside use add_goal_contribution, ' +
      'never target_minor. Take goal_id from list_goals, never guess it.',
    params: {
      goal_id: 'Goal id from list_goals.',
      name: 'New name.',
      target_minor:
        'New target, in INTEGER MINOR UNITS of the goal currency. This is what the user wants to ' +
        'reach, not what they have saved.',
      currency: 'New currency of the goal, ISO 4217 uppercase.',
      deadline: 'New target date as YYYY-MM-DD.',
      priority: 'New ordering hint; lower comes first.',
      archived: 'true retires the goal, false brings it back. ' + KEEP,
    },
  },
  {
    name: 'add_goal_contribution',
    method: 'post',
    path: '/goals/{goal_id}/contributions',
    scope: 'write',
    description:
      'Record ONE contribution to a savings goal — money put aside, in INTEGER MINOR UNITS of the ' +
      'goal currency (12.34 EUR → 1234; JPY has no minor unit → 500 JPY is 500). Never do money ' +
      'math yourself. Calling this twice adds TWO contributions: check ' +
      'list_goal_contributions for the same date and amount before adding. Take goal_id from ' +
      'list_goals, never guess it.',
    params: {
      goal_id: 'Goal id from list_goals.',
      amount_minor:
        'How much was put aside, in minor units of the goal currency. A NEGATIVE amount takes ' +
        'money back out of the goal; it cannot take out more than is saved.',
      occurred_at: 'Date of the contribution as YYYY-MM-DD; defaults to today.',
      note: 'Free-text note from the user.',
    },
  },
];
