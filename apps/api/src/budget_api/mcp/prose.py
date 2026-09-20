"""English prose shared by more than one MCP tool — byte-identical everywhere.

These are the fragments the MODEL reads, ported verbatim from the curated table
the TypeScript server used to own. They live here for one reason: a sentence that
two tools must say the SAME way (minor units, "take the id from list_accounts",
"omitted fields keep their value") drifts the moment it is written twice. Prose
used by a single tool stays inside its ``@mcp_tool(...)`` call, next to the route
it describes.

Write descriptions like code: on a money write they are the only place that tells
the model minor units, "one entity per call", "look before you create" and "fix,
do not delete". stdlib only — a router may import this module freely.
"""

LIMIT = "How many rows to return — keep it at 100 or less."
OFFSET = "How many rows to skip, for paging through older rows."
PERIOD = (
    "Which period grammar to use: `month` (with `month`), `quarter` (with "
    "`quarter`), `year` (with `year`) or `custom` (with `from` and `to`)."
)
MONTH = "Month as YYYY-MM, used when `period` is `month`."
QUARTER = "Quarter as YYYY-Qn (e.g. 2026-Q1), used when `period` is `quarter`."
YEAR = "Four-digit year, used when `period` is `year`."
FROM = "Start date (inclusive) as YYYY-MM-DD, used when `period` is `custom`."
TO = "End date (inclusive) as YYYY-MM-DD, used when `period` is `custom`."
MINOR_UNITS = (
    "Amount in INTEGER MINOR UNITS: 12.34 EUR is 1234; JPY has no minor unit, so 500 "
    "JPY is 500. Never scale or convert it yourself — use convert_currency."
)
CURRENCY_IN = (
    "Currency of `amount_minor`, ISO 4217 uppercase (e.g. EUR). Omit it only when "
    "the amount is already in the user's base currency (get_stats_summary.currency) "
    "— the server stamps that."
)
CATEGORY_ID = "Category id from list_categories — never guess or invent one."
ACCOUNT_ID = "Account id from list_accounts — never guess or invent one."
CURRENCY_FROM_ACCOUNT = (
    "Normally OMIT this: the operation is booked in the currency of its ACCOUNT, "
    "which the server stamps. If you do send it, it must be exactly that account's "
    "currency (ISO 4217 uppercase) — any other value is rejected, never converted."
)
KEEP = (
    "Omitted fields keep their current value; there is no way to clear a field "
    "through this server."
)
ORIGINAL_PAIR = (
    "Use it only for a spend made in a currency OTHER than the account's — a card in "
    "EUR used to pay 3000 JPY. `original_amount_minor` and `original_currency` are "
    "ONE pair: send BOTH or NEITHER, half of it is rejected. `original_currency` "
    "must differ from the account's currency (for a spend in the account's own "
    "currency there is no original leg — just send `amount_minor`), and neither "
    "field is allowed on a `transfer`, which already carries both of its legs. "
    "Expenses and income both accept it."
)
ORIGINAL_AMOUNT = (
    "How much the user PAID at the till, in minor units of `original_currency` — NOT "
    "of the account's currency. " + MINOR_UNITS + " " + ORIGINAL_PAIR
)
ORIGINAL_CURRENCY = (
    "The currency the user PAID in, ISO 4217 uppercase (e.g. JPY). " + ORIGINAL_PAIR
)
RECEIPT_ID = (
    "Leave this out: receipts are attached in the web and mobile apps, and there is "
    "no way to obtain a receipt id here."
)
COUNTRY = (
    "Where the spend happened: ISO 3166-1 alpha-2 country code in UPPERCASE (FR, JP, "
    "US). Optional context only — it changes no amount and no currency. Send it just "
    "when the user said where they were; never infer it from the currency."
)
TX_SEARCH = (
    "Free-text search: returns rows whose MERCHANT or NOTE contains this text, "
    "case-insensitively (works the same in Cyrillic and Latin). It is a plain "
    "substring match, not a search language: `%` and `_` are matched literally, "
    "there are no wildcards or operators, and it does NOT look at category names, "
    "amounts or dates — use `category_id`, `from`/`to` for those. Pass the words the "
    "user actually said; several unrelated words in one string will match nothing, "
    "so search for the shortest distinctive fragment."
)
TX_COUNTRY_FILTER = (
    "Only rows recorded as spent in this country: ISO 3166-1 alpha-2 in UPPERCASE "
    "(PL, FR, JP). The match is exact — a lowercase code, a three-letter code or a "
    "country name is rejected with a validation error, and rows with no country "
    "recorded are never returned by this filter."
)
TX_SORT = (
    "Row order: `date_desc` (newest first, the default when you omit this), "
    "`date_asc` (oldest first), `amount_desc` (largest amount first) or `amount_asc` "
    "(smallest first). The amount sorts compare the stored minor units as they are, "
    "with NO currency conversion, so a mixed-currency list is ordered by raw number "
    '— say so if you present such a list as "the biggest expenses". Sorting never '
    "changes which rows match, only their order, and paging with `offset` keeps the "
    "same order."
)
GOAL_ITEM_LINK = (
    "Files this EXPENSE under one node of a goal's plan (\"the flights of the Japan "
    'trip"), which is how the plan knows what has already been paid. Take the id '
    "from get_goal_plan — never invent one; an unknown or foreign node is refused as "
    "not found. An operation belongs to AT MOST ONE node: there is no list here, so "
    "one payment covering two items cannot be split — link it where it mostly "
    "belongs, or ask the user to record two operations. EXPENSES ONLY: on an income "
    'or a transfer the server rejects it, because "paid" means money that left. '
    "Linking changes NO amount and NO currency — it only files the operation under "
    "the plan, where the server counts it into that node's and its ancestors' totals."
)
TX_GOAL_ITEM_FILTER = (
    "Only expenses linked to this plan node, id from get_goal_plan. It matches the "
    "node's WHOLE SUBTREE: filtering by a parent also returns what was paid on its "
    'children, which is exactly the "paid" figure the plan reports for that parent. '
    "Operations linked to no plan node are never returned by this filter, and a node "
    "that is not the user's own is not found."
)
GOAL_ITEM_MINOR = (
    "in INTEGER MINOR UNITS (12.34 EUR is 1234; JPY has no minor unit, so 500 JPY is "
    "500) — never scale or convert it yourself, use convert_currency"
)
GOAL_ITEM_CEILING = (
    "It is a GUIDELINE and a ceiling for what hangs underneath, NOT the subtree "
    "total: the server adds the children up on its own, so never set a parent to the "
    "sum of the children you are about to add. When they outgrow the guideline the "
    "plan simply comes back with `ceiling_exceeded: true` on that node — a fact to "
    "report, not an error."
)
GOAL_ITEM_CONVERTED = (
    "in minor units of the GOAL's currency. It OVERRIDES the server's own "
    "conversion, so send it only when the user stated that figure themselves — never "
    "one you worked out. It needs the node to have a price, and it is refused when "
    "the node is already priced in the goal currency (there would be nothing to "
    "convert)."
)
GOAL_ITEM_REMIND_ON = (
    "Remind the user on this exact date, as YYYY-MM-DD. A node carries AT MOST ONE "
    "reminder: sending this together with `remind_days_before`, or adding it to a "
    "node that already has one, is rejected."
)
GOAL_ITEM_REMIND_DAYS = (
    "Remind the user this many days (0-365) BEFORE the deadline in force — unlike "
    "`remind_on` it follows the date when the date moves. A node carries AT MOST ONE "
    "reminder: sending this together with `remind_on`, or adding it to a node that "
    "already has one, is rejected."
)
REMIND_SWITCH = (
    "So a node that already carries the other kind of reminder has to be switched "
    "over in the app."
)
GOAL_ITEM_PARENT = (
    "Node id from get_goal_plan, of the SAME goal — never invent one. Nesting is "
    "what makes the parent a group whose cost is the sum of its children."
)
