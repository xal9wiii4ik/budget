/**
 * The curated tool table — architecture §4, verbatim in shape and order.
 *
 * Nothing here is discovered at runtime: the server's fail-closed PAT allowlist
 * is the security boundary, this list is the PRODUCT surface (what an AI client
 * is worth exposing) and the source of the English prose the model actually
 * reads. Schemas are generated from openapi.json — see `tools.ts`.
 *
 * All 32 tools live here: 17 `read` (S3) and 15 `write` (S4) — architecture §4
 * plus the three `/accounts` tools of the accounts-and-transfers scope (M1), the
 * two reads that caught the surface up with the API on 2026-08-23
 * (`list_upcoming_recurring`, `get_profile`) and the goal-planner trio
 * (`get_goal_plan`, `create_goal_item`, `update_goal_item`).
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
const ACCOUNT_ID = 'Account id from list_accounts — never guess or invent one.';
/**
 * The account, not the caller, decides what currency an operation is in — the
 * server stamps it and refuses a disagreeing value instead of converting. Shared
 * by the transaction tools so both say it the same way.
 */
const CURRENCY_FROM_ACCOUNT =
  'Normally OMIT this: the operation is booked in the currency of its ACCOUNT, which the server ' +
  'stamps. If you do send it, it must be exactly that account\'s currency (ISO 4217 uppercase) — ' +
  'any other value is rejected, never converted.';
const KEEP =
  'Omitted fields keep their current value; there is no way to clear a field through this server.';

/**
 * The "what the user actually spent" leg (server: S1 original pair). Verified
 * against `apps/api/src/budget_api/routers/transactions.py`: both-or-neither
 * (422 ORIGINAL_FIELDS_REQUIRED), never on a transfer (TRANSFER_ORIGINAL_FORBIDDEN),
 * never equal to the account's currency (ORIGINAL_CURRENCY_MATCHES_ACCOUNT), and —
 * when `amount_minor` is not sent too — the settlement amount is DERIVED from the
 * stored daily rate (422 FX_RATE_UNAVAILABLE when there is none). Shared so create
 * and update state the same rules.
 */
const ORIGINAL_PAIR =
  'Use it only for a spend made in a currency OTHER than the account\'s — a card in EUR used to ' +
  'pay 3000 JPY. `original_amount_minor` and `original_currency` are ONE pair: send BOTH or ' +
  'NEITHER, half of it is rejected. `original_currency` must differ from the account\'s currency ' +
  '(for a spend in the account\'s own currency there is no original leg — just send ' +
  '`amount_minor`), and neither field is allowed on a `transfer`, which already carries both of ' +
  'its legs. Expenses and income both accept it.';
const ORIGINAL_AMOUNT =
  'How much the user PAID at the till, in minor units of `original_currency` — NOT of the ' +
  'account\'s currency. ' +
  MINOR_UNITS +
  ' ' +
  ORIGINAL_PAIR;
const ORIGINAL_CURRENCY =
  'The currency the user PAID in, ISO 4217 uppercase (e.g. JPY). ' + ORIGINAL_PAIR;
/** Same answer on create and on correction — see the guard in allowlist.test.ts. */
const RECEIPT_ID =
  'Leave this out: receipts are attached in the web and mobile apps, and there is no way to ' +
  'obtain a receipt id here.';
const COUNTRY =
  'Where the spend happened: ISO 3166-1 alpha-2 country code in UPPERCASE (FR, JP, US). Optional ' +
  'context only — it changes no amount and no currency. Send it just when the user said where ' +
  'they were; never infer it from the currency.';

/**
 * The S3 read filters of `list_transactions`. Curated hard because none of the
 * three is guessable from its name: `q` looks like a full-text engine (it is a
 * plain substring over two columns), `country` looks like it might accept a name
 * or a lowercase code (it is exact and uppercase-only), and `sort` looks like it
 * might convert currencies before comparing (it does not).
 */
const TX_SEARCH =
  'Free-text search: returns rows whose MERCHANT or NOTE contains this text, case-insensitively ' +
  '(works the same in Cyrillic and Latin). It is a plain substring match, not a search language: ' +
  '`%` and `_` are matched literally, there are no wildcards or operators, and it does NOT look ' +
  'at category names, amounts or dates — use `category_id`, `from`/`to` for those. Pass the words ' +
  'the user actually said; several unrelated words in one string will match nothing, so search ' +
  'for the shortest distinctive fragment.';
const TX_COUNTRY_FILTER =
  'Only rows recorded as spent in this country: ISO 3166-1 alpha-2 in UPPERCASE (PL, FR, JP). ' +
  'The match is exact — a lowercase code, a three-letter code or a country name is rejected with ' +
  'a validation error, and rows with no country recorded are never returned by this filter.';
const TX_SORT =
  'Row order: `date_desc` (newest first, the default when you omit this), `date_asc` (oldest ' +
  'first), `amount_desc` (largest amount first) or `amount_asc` (smallest first). The amount ' +
  'sorts compare the stored minor units as they are, with NO currency conversion, so a mixed-' +
  'currency list is ordered by raw number — say so if you present such a list as "the biggest ' +
  'expenses". Sorting never changes which rows match, only their order, and paging with `offset` ' +
  'keeps the same order.';

/**
 * The plan link of the goal-planner scope. Verified against
 * `apps/api/src/budget_api/schemas/transaction.py` and `routers/transactions.py`:
 * ONE nullable column, so an operation belongs to at most one node; expense only
 * (422 GOAL_ITEM_EXPENSE_ONLY); a foreign or unknown node is 404, byte-identical
 * to "does not exist". Shared so create and update say it the same way — the
 * field arrives in both flat schemas the moment the contract has it, and a link
 * the model invents silently moves a payment into someone's plan totals.
 */
const GOAL_ITEM_LINK =
  'Files this EXPENSE under one node of a goal\'s plan ("the flights of the Japan trip"), which ' +
  'is how the plan knows what has already been paid. Take the id from get_goal_plan — never ' +
  'invent one; an unknown or foreign node is refused as not found. An operation belongs to AT ' +
  'MOST ONE node: there is no list here, so one payment covering two items cannot be split — ' +
  'link it where it mostly belongs, or ask the user to record two operations. EXPENSES ONLY: on ' +
  'an income or a transfer the server rejects it, because "paid" means money that left. Linking ' +
  'changes NO amount and NO currency — it only files the operation under the plan, where the ' +
  'server counts it into that node\'s and its ancestors\' totals.';
const TX_GOAL_ITEM_FILTER =
  'Only expenses linked to this plan node, id from get_goal_plan. It matches the node\'s WHOLE ' +
  'SUBTREE: filtering by a parent also returns what was paid on its children, which is exactly ' +
  'the "paid" figure the plan reports for that parent. Operations linked to no plan node are ' +
  'never returned by this filter, and a node that is not the user\'s own is not found.';

/**
 * The goal-planner plan tree (`get_goal_plan`, `create_goal_item`,
 * `update_goal_item`). Checked field by field against `GoalItemRead` /
 * `GoalItemCreate` / `GoalItemUpdate` in apps/api/openapi.json — every claim
 * below names a field that exists.
 *
 * The three things a model cannot guess from the schema: the money is summed
 * BOTTOM-UP by the server (a parent's own price is a guideline, not the total,
 * and adding the rows up double-counts), a deadline is INHERITED rather than
 * copied, and the order among siblings is changed with a relative `move`
 * instruction because there is no writable position field.
 */
const GOAL_ITEM_MINOR =
  'in INTEGER MINOR UNITS (12.34 EUR is 1234; JPY has no minor unit, so 500 JPY is 500) — never ' +
  'scale or convert it yourself, use convert_currency';
const GOAL_ITEM_CEILING =
  'It is a GUIDELINE and a ceiling for what hangs underneath, NOT the subtree total: the server ' +
  'adds the children up on its own, so never set a parent to the sum of the children you are ' +
  'about to add. When they outgrow the guideline the plan simply comes back with ' +
  '`ceiling_exceeded: true` on that node — a fact to report, not an error.';
const GOAL_ITEM_CONVERTED =
  'in minor units of the GOAL\'s currency. It OVERRIDES the server\'s own conversion, so send it ' +
  'only when the user stated that figure themselves — never one you worked out. It needs the ' +
  'node to have a price, and it is refused when the node is already priced in the goal currency ' +
  '(there would be nothing to convert).';
const GOAL_ITEM_REMIND_ON =
  'Remind the user on this exact date, as YYYY-MM-DD. A node carries AT MOST ONE reminder: ' +
  'sending this together with `remind_days_before`, or adding it to a node that already has one, ' +
  'is rejected.';
const GOAL_ITEM_REMIND_DAYS =
  'Remind the user this many days (0-365) BEFORE the deadline in force — unlike `remind_on` it ' +
  'follows the date when the date moves. A node carries AT MOST ONE reminder: sending this ' +
  'together with `remind_on`, or adding it to a node that already has one, is rejected.';
/** Both reminder fields are nullable, and MCP cannot send a null (see `KEEP`). */
const REMIND_SWITCH =
  'So a node that already carries the other kind of reminder has to be switched over in the app.';
const GOAL_ITEM_PARENT =
  'Node id from get_goal_plan, of the SAME goal — never invent one. Nesting is what makes the ' +
  'parent a group whose cost is the sum of its children.';

export const ALLOWLIST: readonly ToolSpec[] = [
  {
    name: 'list_transactions',
    method: 'get',
    path: '/transactions',
    scope: 'read',
    description:
      'Search and filter the user\'s transactions by text, period, category, account, country ' +
      'and direction, in the order you choose. ' +
      'Returns individual rows with their ids — this is where every `transaction_id` comes from. ' +
      'For totals use get_transactions_summary instead of adding rows up yourself. ' +
      'Keep `limit` at 100 or less and page with `offset`.',
    params: {
      from: 'Start date (inclusive) as YYYY-MM-DD.',
      to: 'End date (inclusive) as YYYY-MM-DD.',
      category_id: 'Only this category; take the id from list_categories.',
      kind: 'Only expenses, only income, or only `transfer` rows (money moved between the ' +
        'user\'s own accounts, which count as neither).',
      account_id:
        ACCOUNT_ID +
        ' Narrows the list to what happened on that ONE account. A transfer is a SINGLE operation ' +
        'with two sides, so the same row (same id) comes back both when you filter by the account ' +
        'the money left and when you filter by the account it arrived on — that is one transfer ' +
        'seen twice, not two transfers; never add the two lists together.',
      q: TX_SEARCH,
      country: TX_COUNTRY_FILTER,
      goal_item_id: TX_GOAL_ITEM_FILTER,
      sort: TX_SORT,
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
    name: 'list_accounts',
    method: 'get',
    path: '/accounts',
    scope: 'read',
    description:
      'List the user\'s accounts (cards, cash) with their ids, currency and current balance. ' +
      'This is where every `account_id` comes from — never guess one, and call this BEFORE ' +
      'recording any transaction. `balance_minor` is computed by the server in that account\'s ' +
      'OWN currency, in minor units: do not add balances of different currencies together and ' +
      'do not recompute a balance from the transaction list.',
    params: { include_archived: 'Also return archived accounts (default false).' },
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
    name: 'get_goal_plan',
    method: 'get',
    path: '/goals/{goal_id}/items',
    scope: 'read',
    description:
      'The PLAN of ONE goal: every item the user broke it into ("flights", "hotel", "visa"), ' +
      'flat, with the numbers the server already computed. This is where every plan node id — ' +
      'the `item_id` and `parent_id` of the goal-item tools and the `goal_item_id` of a ' +
      'transaction — comes from. Assemble the TREE from `parent_id` (null means a root, `depth` ' +
      'is 1 there); the rows arrive in display order. MONEY IS SUMMED BOTTOM-UP BY THE SERVER: ' +
      '`children_sum_minor` is what a node and everything under it costs, in the goal currency ' +
      'named ONCE per response in `goal_currency`; for a leaf it is just its own price. NEVER add ' +
      'the rows up — a parent already contains its children, so a sum over the list ' +
      'double-counts; the goal-wide totals are in get_goal. `amount_minor` is the node\'s OWN ' +
      'price, in its own `currency`, which may differ from the goal\'s: it is what the user said ' +
      'this item should cost, a guideline — `ceiling_exceeded: true` means the children add up to ' +
      'more than it, which is worth telling the user and is NOT an error. `converted_minor` is ' +
      'that price in the goal currency; when it and `converted_currency` are null there was no ' +
      'rate, the node is counted in `planned_unconverted_count` instead of being summed, and any ' +
      'total you quote is understated — say so rather than treating it as zero. DATES ARE ' +
      'INHERITED: `deadline` is the node\'s own and is often null, `effective_deadline` is the one ' +
      'actually in force (nearest ancestor with a date, else the goal\'s) and `deadline_inherited` ' +
      'says which — quote `effective_deadline`, never work a date out yourself. `paid_minor` is ' +
      'what has already been paid against the node AND its subtree (the transactions linked to ' +
      'it; list them with list_transactions.goal_item_id), with the same caveat in ' +
      '`paid_unconverted_count`. `files_count` and `subtree_files_count` count attachments the ' +
      'user manages in the apps — there is no file tool here.',
    params: { goal_id: 'Goal id from list_goals.' },
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
    name: 'list_upcoming_recurring',
    method: 'get',
    path: '/recurring/upcoming',
    scope: 'read',
    description:
      'The charges the recurring templates still OWE — money that has not moved yet. Nothing here ' +
      'has happened: a charge that was already posted (even earlier today) is gone from this list ' +
      'and is a real transaction, so look for it with list_transactions instead. Use it to answer ' +
      '"what is about to hit my accounts", never to report spending. Amounts are INTEGER MINOR ' +
      'UNITS of each row\'s OWN currency (12.34 EUR is 1234; JPY has no minor unit, so 500 JPY is ' +
      '500) — do not add up rows of different currencies, and do not convert them yourself. ' +
      'Paused templates owe nothing and are absent.',
    params: {
      days:
        'How far ahead to look, in days from today (1-90, default 30) — this is the ONLY thing ' +
        'that decides how much of the future is listed, so a missing charge usually just falls ' +
        'outside the window.',
    },
  },
  {
    name: 'get_profile',
    method: 'get',
    path: '/profile',
    scope: 'read',
    description:
      'The user\'s own settings, and above all their BASE CURRENCY: that is the currency every ' +
      'server-computed total is already expressed in (summaries, limits, monthly trends), and the ' +
      'one to phrase totals in when talking to the user. Read it before quoting figures. ' +
      '`monthly_income_minor` is what the user DECLARED they earn per month, in INTEGER MINOR ' +
      'UNITS of the base currency — it may be null, which means they never told us, not that they ' +
      'earn nothing; never infer it from transactions. `country` and `language` are context (the ' +
      'language the user prefers to be answered in) and may also be null. Read-only: there is no ' +
      'tool to change any of this, base currency included — ask the user to change it in the app.',
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
      'Record ONE transaction on ONE account. `account_id` is REQUIRED and comes from ' +
      'list_accounts — the account also decides the currency, which the server stamps. Amounts ' +
      'are INTEGER MINOR UNITS: 12.34 EUR → amount_minor 1234; JPY has no minor unit → 500 JPY is ' +
      '500. Never do money math yourself — use convert_currency. MOVING MONEY BETWEEN THE USER\'S ' +
      'OWN ACCOUNTS IS ONE CALL, NOT TWO: send kind `transfer` with account_id as the source and ' +
      'counter_account_id as the destination — recording a transfer as an expense plus an income ' +
      'double-counts it and corrupts every total. BEFORE creating, call list_transactions for the ' +
      'same date and amount: if it is there do NOT duplicate — fix it with update_transaction; ' +
      'the id is echoed back.',
    // The model never sees or sets `client_id`: this server generates one per
    // logical call so a replayed HTTP attempt returns the SAVED row instead of
    // creating a second transaction (architecture §6, B-1).
    managedBody: { client_id: 'uuid' },
    params: {
      account_id:
        ACCOUNT_ID +
        ' Required: the account the money left or arrived on, and for a transfer the SOURCE side.',
      amount_minor:
        'What was charged TO THE ACCOUNT, in the ACCOUNT\'s currency. ' +
        MINOR_UNITS +
        ' Always positive — `kind` says whether it is money in or out. For a transfer it is what ' +
        'LEAVES `account_id`, in that account\'s currency. It may be OMITTED only when you send ' +
        'the `original_amount_minor` + `original_currency` pair instead: the server then converts ' +
        'the original amount at its own stored daily rate for `occurred_at` (and refuses the call ' +
        'if it has no rate for that day — it never guesses one). Send it TOGETHER with that pair ' +
        'only when the user stated what the bank actually took: a sent amount is stored verbatim ' +
        'and beats any rate. With no original pair it is required — a call with neither is ' +
        'rejected.',
      currency: CURRENCY_FROM_ACCOUNT,
      kind:
        'Whether this is an expense (money out), income (money in) or a `transfer` between two ' +
        'of the user\'s own accounts. A transfer is neither spending nor earning, so it is left ' +
        'out of every income/expense total.',
      counter_account_id:
        'Transfers ONLY, and then required: the DESTINATION account, from list_accounts. It must ' +
        'be a different account than `account_id`. Never send it with an expense or income.',
      counter_amount_minor:
        'Transfers ONLY, and then required: how much ARRIVES on the destination account, in ' +
        'INTEGER MINOR UNITS of THAT account\'s currency (so 100 EUR arriving as 10800 JPY is ' +
        '10800). For a transfer between accounts of the same currency it equals `amount_minor`. ' +
        'Across currencies, send the exact received amount ONLY if the user stated it — otherwise ' +
        'get the figure from convert_currency; never invent a rate. The server derives the ' +
        'effective rate from the two amounts.',
      occurred_at: 'The date the money moved, as YYYY-MM-DD.',
      category_id:
        CATEGORY_ID +
        ' Omit it if the user did not say which category, and NEVER send it for a transfer — ' +
        'moving money between own accounts has no category and the server rejects one.',
      merchant: 'Who was paid or who paid, as the user named them.',
      note: 'Free-text note from the user.',
      base_amount_minor:
        'Only when the user states the exact converted amount they were charged in their base ' +
        'currency, in minor units. Omit it and the server converts at its own daily rate — that ' +
        'is the normal case. Never send it for a transfer: use `counter_amount_minor` instead.',
      original_amount_minor: ORIGINAL_AMOUNT,
      original_currency: ORIGINAL_CURRENCY,
      country: COUNTRY,
      goal_item_id: GOAL_ITEM_LINK,
      receipt_id: RECEIPT_ID,
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
      account_id:
        ACCOUNT_ID +
        ' Moves the transaction to another account: the server restamps the row with that ' +
        'account\'s currency and recomputes any conversion, so do NOT also send `currency` or ' +
        'converted amounts.',
      amount_minor:
        'What was charged TO THE ACCOUNT, in the ACCOUNT\'s currency. ' +
        MINOR_UNITS +
        ' Send it only when that charged amount is what is wrong. If you send a new ' +
        '`original_amount_minor` + `original_currency` pair WITHOUT it, the server recomputes the ' +
        'charged amount itself, at its stored daily rate for the transaction\'s date (and refuses ' +
        'the whole edit if it has no rate for that day). Send both when the user tells you the ' +
        'real bank charge as well — a sent amount is stored verbatim and beats any rate.',
      currency: CURRENCY_FROM_ACCOUNT,
      kind:
        'Change between expense and income. An existing transaction can NOT become a transfer, ' +
        'and a transfer can not become an expense or income — the server rejects it. Converting ' +
        'one means re-creating it: show the user the row and get their explicit go-ahead before ' +
        'any delete_transaction.',
      counter_account_id:
        'Transfers ONLY: move the DESTINATION side to another account, from list_accounts. It ' +
        'must differ from the source account.',
      counter_amount_minor:
        'Transfers ONLY: correct how much ARRIVED, in INTEGER MINOR UNITS of the destination ' +
        'account\'s currency.',
      occurred_at: 'New date of the transaction, as YYYY-MM-DD.',
      category_id: CATEGORY_ID + ' A transfer can never take one.',
      merchant: 'New merchant name.',
      note: 'New note. ' + KEEP,
      base_amount_minor:
        'Only when the user states the exact converted amount in their base currency, in minor ' +
        'units; otherwise omit it and let the server keep or recompute its own conversion.',
      original_amount_minor:
        ORIGINAL_AMOUNT +
        ' On a correction the pair is still atomic: both fields in the SAME call, or neither. ' +
        KEEP +
        ' So an original leg recorded by mistake can be CHANGED here but never removed — if the ' +
        'user wants it gone, say so and let them do it in the app.',
      original_currency:
        ORIGINAL_CURRENCY +
        ' It must differ from the currency the row ends up in, so moving the row to an account ' +
        'denominated in it is refused — change or keep them consistently in one call.',
      country: COUNTRY + ' ' + KEEP,
      goal_item_id:
        GOAL_ITEM_LINK +
        ' Sending a DIFFERENT node moves the payment there, and the plan\'s "paid" figures follow ' +
        'on the next read. ' +
        KEEP +
        ' So a link put on the wrong node is corrected here, but never removed — if the user ' +
        'wants the payment off the plan entirely, say so and let them do it in the app.',
      receipt_id: RECEIPT_ID,
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
    name: 'create_account',
    method: 'post',
    path: '/accounts',
    scope: 'write',
    description:
      'Create ONE account (a card or a cash wallet). Call list_accounts FIRST: a near-duplicate ' +
      '("Card" next to an existing "Debit card") splits the user\'s history and its balances in ' +
      'two, and there is no way to merge them afterwards. Only create one when the user names a ' +
      'place their money actually sits that is not in the list yet. The `currency` is fixed at ' +
      'creation and can NEVER be changed — ask the user if you are not sure which one they mean. ' +
      'The new id comes back in the response.',
    params: {
      name: 'What the user calls this account, e.g. "Наличные" or "Revolut".',
      currency: 'Currency of the account, ISO 4217 uppercase (e.g. EUR). Every transaction booked ' +
        'here is stamped with it, and it can never be changed afterwards.',
      type: 'Whether this is a card/bank account or physical cash.',
      starting_balance_minor:
        'What was already on the account before the user started tracking it, in INTEGER MINOR ' +
        'UNITS of the account currency (1 234.56 EUR is 123456; JPY has no minor unit, so 500 JPY ' +
        'is 500). It may be negative for a credit card in debt. Omit it for zero — do NOT record ' +
        'the opening balance as a transaction.',
    },
  },
  {
    name: 'update_account',
    method: 'patch',
    path: '/accounts/{account_id}',
    scope: 'write',
    description:
      'Rename or ARCHIVE one account. Archiving is how an account is "removed": it stops being ' +
      'offered for new operations while every past transaction on it is preserved — there is no ' +
      'delete_account tool by design, because deleting one would take its history with it. Send ' +
      'only the fields that change. Take account_id from list_accounts, never guess it.',
    params: {
      account_id: ACCOUNT_ID,
      name: 'New name.',
      currency:
        'NEVER send this. An account\'s currency is immutable — the server rejects any attempt to ' +
        'change it, including resending the current value. There is no way to change it: if the ' +
        'user needs another currency, create a new account with create_account (and archive this ' +
        'one if it is no longer used).',
      type: 'Change between a card/bank account and cash.',
      starting_balance_minor:
        'Correct the balance the account had before tracking started, in INTEGER MINOR UNITS of ' +
        'the account currency. It shifts the computed balance by exactly this much and changes no ' +
        'transaction — do not use it to record money coming in or going out.',
      archived:
        'true archives the account (this is what "delete an account" means here) and it stops ' +
        'being offered for new transactions; false brings it back. ' + KEEP,
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
      initial_budget_minor:
        'The BUDGET the user has decided to put into this goal — "I am ready to spend about 3000 ' +
        'on the trip" — in INTEGER MINOR UNITS of the goal currency (12.34 EUR is 1234; JPY has ' +
        'no minor unit, so 500 JPY is 500). It is a planning note the user types, not money and ' +
        'not a target: nothing is saved or spent by writing it, no total is computed from it, and ' +
        'it never moves `target_minor`. It exists to be COMPARED with what the plan actually ' +
        'costs — do not use it to record money put aside (add_goal_contribution) or to state a ' +
        'price (`final_cost_override_minor`).',
      final_cost_override_minor:
        'Override what this goal is taken to COST, in INTEGER MINOR UNITS of the goal currency. ' +
        'By default that number is computed BOTTOM-UP from the plan items (get_goal_plan), and ' +
        'every projection follows it; send this only when the user states a final figure of their ' +
        'own that differs — an all-in quote, a negotiated price. It then replaces the computed ' +
        'total everywhere, so the two numbers stop agreeing on purpose. This is what the thing ' +
        'costs; `initial_budget_minor` is what the user is willing to spend — do not confuse ' +
        'them. ' +
        KEEP +
        ' Handing the goal back to its bottom-up total is therefore done in the app.',
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
  // The plan of a goal (goal-planner §9). TWO write tools and no third one:
  //
  // * `delete_goal_item` is NEVER published. Deleting a node cascades over its
  //   whole SUBTREE and takes the user's attached files with it — strictly more
  //   destructive than delete_transaction, and unlike it there is nothing to
  //   confirm row by row. An action of that size is not performed on a sentence
  //   in a chat; the app has the button, with the file count in the warning.
  // * `list_upcoming_goal_deadlines` (GET /goals/upcoming) is not here YET: the
  //   endpoint is subtask B2 and is absent from the contract, and a tool on a
  //   path openapi.json does not have fails the whole server at startup. It
  //   ships together with B2.
  {
    name: 'create_goal_item',
    method: 'post',
    path: '/goals/{goal_id}/items',
    scope: 'write',
    description:
      'Add ONE item to ONE goal\'s plan — something that has to be bought or booked. Only `name` ' +
      'is required: a grouping node ("Transport") needs NO price of its own, the children carry ' +
      'the money and the server adds them up. Call get_goal_plan FIRST — a second node for ' +
      'something the plan already has splits one cost into two, and it is also the only source of ' +
      '`parent_id`. Amounts are INTEGER MINOR UNITS and the SERVER does every sum and every ' +
      'conversion: never total a plan up yourself. One node per call; the new id comes back in ' +
      'the response. The plan of an ARCHIVED goal is closed to writes. There is no tool to remove ' +
      'a node — deleting one would take its whole subtree and the user\'s files with it, so it is ' +
      'done in the app.',
    params: {
      goal_id: 'Goal id from list_goals — the plan belongs to this goal, and so must `parent_id`.',
      name: 'What the user calls this item, e.g. "Flights" or "Hotel in Kyoto".',
      parent_id:
        'Nest this node under an existing one. ' +
        GOAL_ITEM_PARENT +
        ' Omit it for a top-level item of the plan.',
      description:
        'Free-text details the user gave: booking reference, address, what is included. Not a ' +
        'place for amounts — those belong in `amount_minor`.',
      links: 'Reference URLs the user pasted (a listing, a booking page). Send them as given.',
      amount_minor:
        'What THIS item costs, in `currency` and ' +
        GOAL_ITEM_MINOR +
        '. Optional: leave it out for a pure grouping node. ' +
        GOAL_ITEM_CEILING,
      currency:
        'Currency of `amount_minor`, ISO 4217 uppercase. OMIT it and the GOAL\'s currency is ' +
        'stamped — send it only for an item genuinely priced in another one (a hotel billed in ' +
        'JPY inside a EUR goal), and the server then converts it into the goal currency at its ' +
        'own daily rate.',
      converted_minor:
        'What this item comes to in the goal\'s currency, ' + GOAL_ITEM_CONVERTED,
      deadline:
        'The date THIS item must be done by, as YYYY-MM-DD. Omit it and the node INHERITS the ' +
        'date in force: the nearest ancestor that has one, else the goal\'s deadline. Prefer ' +
        'inheriting — copying the parent\'s date down freezes it, so it stops following when the ' +
        'parent moves.',
      remind_on: GOAL_ITEM_REMIND_ON,
      remind_days_before: GOAL_ITEM_REMIND_DAYS,
    },
  },
  {
    name: 'update_goal_item',
    method: 'patch',
    path: '/goals/{goal_id}/items/{item_id}',
    scope: 'write',
    description:
      'Correct ONE node of a goal\'s plan, or move it. Send only the fields that change; omitted ' +
      'fields keep their value. Take `goal_id` from list_goals and `item_id` from get_goal_plan, ' +
      'never guess either. RESTRUCTURING happens here too: `parent_id` moves the node WITH ' +
      'everything under it, and `move` swaps it with the neighbouring sibling. Money stays the ' +
      'server\'s: a node\'s own price is a guideline, the sums are recomputed from the leaves on ' +
      'the next get_goal_plan. Always prefer fixing a node to asking the user to recreate it — ' +
      'there is no delete tool here at all.',
    params: {
      goal_id: 'Goal id from list_goals.',
      item_id: 'Plan node id from get_goal_plan.',
      name: 'New name.',
      parent_id:
        'Move this node — with its whole subtree — under another node. ' +
        GOAL_ITEM_PARENT +
        ' A node cannot be moved under itself or under one of its own descendants, and the plan ' +
        'has a maximum nesting depth; both are refused. ' +
        KEEP +
        ' So a nested node cannot be made a top-level one here — that is done in the app.',
      description: 'New details, replacing the old text. ' + KEEP,
      links:
        'New list of reference URLs. It REPLACES the whole list rather than adding to it, so ' +
        'include the links that should stay.',
      amount_minor:
        'New price for THIS node, in its own currency and ' +
        GOAL_ITEM_MINOR +
        '. ' +
        GOAL_ITEM_CEILING,
      currency:
        'New currency of `amount_minor`, ISO 4217 uppercase. Changing it makes the server redo ' +
        'the goal-currency conversion, so do not send a stale `converted_minor` beside it — only ' +
        'a figure the user just gave you.',
      converted_minor:
        'New goal-currency figure for this node, ' + GOAL_ITEM_CONVERTED,
      deadline:
        'New own date for this node, as YYYY-MM-DD. ' +
        KEEP +
        ' So a node that inherits its date can be given one here, but a date once set cannot be ' +
        'handed back to inheritance through this server — that is done in the app.',
      remind_on: GOAL_ITEM_REMIND_ON + ' ' + KEEP + ' ' + REMIND_SWITCH,
      remind_days_before: GOAL_ITEM_REMIND_DAYS + ' ' + KEEP + ' ' + REMIND_SWITCH,
      move:
        'Reorder among SIBLINGS: `up` swaps this node with the one before it, `down` with the one ' +
        'after. There is no position or sort number to write — the server owns those and does the ' +
        'swap in one step. ONE step per call, and at the top (or the bottom) it simply does ' +
        'nothing instead of failing. It changes only the display order: no amount, no parent, no ' +
        'date.',
    },
  },
];
