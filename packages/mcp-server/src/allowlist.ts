/**
 * The curated tool table — architecture §4, verbatim in shape and order.
 *
 * Nothing here is discovered at runtime: the server's fail-closed PAT allowlist
 * is the security boundary, this list is the PRODUCT surface (what an AI client
 * is worth exposing) and the source of the English prose the model actually
 * reads. Schemas are generated from openapi.json — see `tools.ts`.
 *
 * S3 publishes the 13 `read` tools. The `write` half (architecture §4) lands in
 * S4 as data-only additions to this array.
 */

export type ToolScope = 'read' | 'write';

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
];
