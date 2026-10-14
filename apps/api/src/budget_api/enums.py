"""Shared enums imported by both models and schemas.

Neutral module (no internal imports) so ``models/category.py`` and
``schemas/category.py`` can both use ``CategoryKind`` without violating the
schemas-never-import-models direction (architecture §1).
"""

from enum import StrEnum


class CategoryKind(StrEnum):
    # Definition order (expense, income) is load-bearing: the category model's
    # CHECK constraint is rebuilt from this iteration order and must emit SQL
    # byte-identical to migration 0002 (``kind IN ('expense', 'income')``).
    expense = "expense"
    income = "income"


class TransactionKind(StrEnum):
    # Independent from CategoryKind by design (decision c); the accounts-and-transfers
    # scope added the promised third value. Definition order (expense, income,
    # transfer) is load-bearing: models/transaction.py rebuilds its kind CHECK from
    # this iteration order and must emit SQL byte-identical to migration 0008
    # (kind IN ('expense', 'income', 'transfer')) — `transfer` is APPENDED, never
    # inserted. models/recurring_template.py deliberately does NOT iterate this enum
    # (recurring transfers are unsupported in v1, architecture §7): it pins the
    # ('expense', 'income') tuple so this third value cannot widen its CHECK.
    expense = "expense"
    income = "income"
    transfer = "transfer"


class TransactionSort(StrEnum):
    # The ONLY enum in this module with no table behind it: it is a wire-contract
    # value (the ``sort`` query param of ``GET /transactions``), so no CHECK
    # constraint is rebuilt from its definition order and appending a value here is
    # free. It lives next to TransactionKind anyway — both are enums the transaction
    # router hands to FastAPI as a query type, and a second home for that idea would
    # be one home too many.
    #
    # ``date_desc`` is FIRST because it is the default the route declares: an omitted
    # ``sort`` must keep the pre-S3 ordering exactly (occurred_at DESC, created_at
    # DESC, id).
    date_desc = "date_desc"
    date_asc = "date_asc"
    amount_desc = "amount_desc"
    amount_asc = "amount_asc"


class AccountType(StrEnum):
    # The CLIENT-FACING account vocabulary — every type a client may send AND every
    # type ``GET /accounts`` can return. Definition order (card, cash) is
    # load-bearing: models/account.py rebuilds its type CHECK from this iteration
    # order (followed by DEPOSIT_ACCOUNT_TYPE below) and must emit SQL
    # byte-identical to migration 0012 (type IN ('card', 'cash', 'deposit')).
    card = "card"
    cash = "cash"


#: The THIRD stored account type, deliberately NOT a member of the enum above.
#:
#: A ``deposit`` account is the hidden 1:1 ledger of a ``deposits`` row (deposits
#: architecture §"Поведение счетов типа deposit"): it is created only by
#: ``POST /deposits``, filtered out of ``GET /accounts``, answers 404 to
#: ``PATCH /accounts/{id}``, and takes transfers only. So it never crosses the wire
#: in either direction — and keeping it out of ``AccountType`` is what says that in
#: the CONTRACT rather than only in prose: the enum stays a two-value component, no
#: client is forced to render a case the server cannot produce, and no client can
#: send the value (a card PATCHed into a deposit account would keep its money while
#: vanishing from every list and belonging to no deposit).
#:
#: It lives here, next to the enum, because ``models/account.py`` builds ONE CHECK
#: constraint out of both and the two must be read together. Appended AFTER the
#: enum's members for the same byte-identity reason the enum's own order matters.
DEPOSIT_ACCOUNT_TYPE = "deposit"

#: Every value the ``accounts.type`` CHECK accepts, in the order migration 0012
#: renders them. The single source for the model's constraint.
ACCOUNT_TYPE_VALUES: tuple[str, ...] = (
    *(t.value for t in AccountType),
    DEPOSIT_ACCOUNT_TYPE,
)


class DepositCapitalization(StrEnum):
    # How accrued interest joins the principal (deposits architecture §Enum). ONE
    # column instead of boolean + period, so "no capitalization but a period" is
    # unrepresentable rather than CHECK-forbidden; ``none`` is simple interest.
    #
    # Definition order is load-bearing exactly like the enums above:
    # models/deposit.py rebuilds its capitalization CHECK from this iteration order
    # and must emit SQL byte-identical to migration 0012
    # (capitalization IN ('none', 'monthly', 'quarterly', 'at_maturity')).
    none = "none"
    monthly = "monthly"
    quarterly = "quarterly"
    at_maturity = "at_maturity"


class DepositStatus(StrEnum):
    # A COMPUTED wire value, not a column: a deposit is ``matured`` exactly when its
    # term_end has arrived (accrual is frozen on that date), and storing that would
    # mean a row whose truth depends on a nightly job having run. Like
    # TransactionSort above, no CHECK constraint is rebuilt from this definition
    # order, so appending here is free.
    active = "active"
    matured = "matured"


class ReceiptStatus(StrEnum):
    # Definition order is load-bearing: models/receipt.py rebuilds the status
    # CHECK from this iteration order and must emit SQL byte-identical to
    # migration 0004 (status IN ('pending', 'processing', 'parsed', 'failed')).
    pending = "pending"
    processing = "processing"
    parsed = "parsed"
    failed = "failed"


class RecurrenceUnit(StrEnum):
    # Definition order (month, week) is load-bearing: models/recurring_template.py
    # rebuilds its interval_unit CHECK from this iteration order and must emit SQL
    # byte-identical to migration 0006 (interval_unit IN ('month', 'week')).
    month = "month"
    week = "week"


class PatScope(StrEnum):
    # Personal access token scope (5.6 architecture §1). A STRING enum, not a
    # boolean flag: future granular scopes (e.g. ``transactions:write``) extend the
    # CHECK constraint without changing the column type. Definition order (read,
    # full) is load-bearing: models/personal_access_token.py rebuilds its scope
    # CHECK from this iteration order and must emit SQL byte-identical to migration
    # 0007 (scope IN ('read', 'full')).
    read = "read"
    full = "full"


class StatementImportStatus(StrEnum):
    # The session lifecycle (statement-import architecture §2). Three PERSISTED
    # states and no more: a file that fails to parse never becomes a row (the
    # refusal is a 422), and "partly reconciled" is derived from the rows'
    # decisions rather than stored on the session.
    #
    # Definition order is load-bearing: models/statement_import.py rebuilds the
    # status CHECK from this iteration order and must emit SQL byte-identical to
    # migration 0013 (status IN ('parsed', 'applied', 'replaced')).
    parsed = "parsed"
    applied = "applied"
    replaced = "replaced"


class StatementSection(StrEnum):
    # Which of the file's two operation blocks a row came from (architecture §5).
    # DISPLAY only: both sections import into the ONE chosen account, so this never
    # decides where money lands. Definition order is load-bearing (the section
    # CHECK in migration 0013).
    contract = "contract"
    card = "card"


class StatementRowMatchStatus(StrEnum):
    # What the matcher found for this statement row (architecture §4): the row is
    # already in the app (``exact``), something in the window looks like it
    # (``similar``), or nothing does (``new``). Definition order is load-bearing
    # (the match_status CHECK in migration 0013).
    exact = "exact"
    similar = "similar"
    new = "new"


class StatementRowDecision(StrEnum):
    # What will HAPPEN to this row on apply (architecture §4). Defaults are set at
    # parse time from the match status (new → import, exact/similar → skip) and are
    # the user's to change; ``replace_own`` needs a matched transaction to replace.
    #
    # ``import_`` is spelled with the trailing underscore because ``import`` is a
    # Python keyword — the VALUE, which is what the CHECK constraint and the wire
    # carry, is plain ``import``. Definition order is load-bearing (the decision
    # CHECK in migration 0013).
    import_ = "import"
    skip = "skip"
    replace_own = "replace_own"


class StatementSuggestionSource(StrEnum):
    # Where a row's suggested category came from (architecture §5), null until S2
    # fills the suggestion. Definition order is load-bearing (the suggestion_source
    # CHECK in migration 0013, REBUILT with the third value in 0018).
    #
    # ``llm`` is APPENDED and must stay last: models/statement_import.py renders
    # the CHECK from this iteration order and migration 0018 spells the same three
    # values by hand, so a reorder here is a silent drift between the two.
    merchant = "merchant"
    bank_category = "bank_category"
    llm = "llm"


class StatementAiStatus(StrEnum):
    # What the LLM categorization pass did to THIS import (ai-layer architecture
    # §"Router integration"). Deliberately coarse — the CAUSE of a partial or a
    # failed run lives in the log line, not on the session:
    #
    # * ``not_configured`` — this server has no provider at all (no API key, or
    #   ``LLM_PROVIDER=off``). The default of every existing session, which is why
    #   it is the column's server_default and the first value here.
    # * ``skipped`` — a provider exists but the rules covered everything; nothing
    #   was eligible, so nothing was asked.
    # * ``ok`` — every eligible row got an answer (a category or an honest "not
    #   sure"; both are answers).
    # * ``partial`` — some eligible rows got one and the rest were left untouched
    #   (time budget, row cap, quota mid-way, an aborting error, an unparseable
    #   batch).
    # * ``failed`` — eligible rows existed and NOT ONE got an answer.
    #
    # Definition order is load-bearing (the ``ai_status`` CHECK in migration 0018).
    not_configured = "not_configured"
    skipped = "skipped"
    ok = "ok"
    partial = "partial"
    failed = "failed"


class OAuthClientAuthMethod(StrEnum):
    # How a dynamically registered OAuth client authenticates at ``/oauth/token``
    # (mcp-remote ruling R1). ``none`` is a public client bound by PKCE alone; the
    # two secret methods exist because what claude.ai's DCR actually asks for could
    # not be verified locally, and a refusal would have cost the owner a full round
    # trip. A secret is stored ONLY as its SHA-256 (``oauth/client_auth.py``), so
    # "confidential" here never means "a plaintext secret in our database".
    #
    # Definition order is load-bearing: models/oauth_client.py rebuilds its
    # ``token_endpoint_auth_method`` CHECK from this iteration order and must emit
    # SQL byte-identical to migration 0016.
    none = "none"
    client_secret_post = "client_secret_post"
    client_secret_basic = "client_secret_basic"


class DebtDirection(StrEnum):
    # Which way the money went when the debt was opened (debts architecture
    # §Enums): ``lent`` = the user gave money away and is owed it back,
    # ``borrowed`` = the user received money and owes it back. IMMUTABLE on a
    # stored debt — ``domain/debts.movement_kind`` derives every movement's kind
    # from it, so a direction that could change would retro-flip the sign of money
    # already booked.
    #
    # Definition order is load-bearing: models/debt.py rebuilds its direction
    # CHECK from this iteration order and must emit SQL byte-identical to
    # migration 0017 (direction IN ('lent', 'borrowed')).
    lent = "lent"
    borrowed = "borrowed"


class DebtRole(StrEnum):
    # What a debt movement IS (debts architecture §Tables): the opening amount
    # (``principal``, at most one per debt by partial unique index) or a partial
    # repayment. Together with the debt's direction it decides the row's
    # ``kind`` — see ``domain/debts.movement_kind``.
    #
    # Definition order is load-bearing: models/transaction.py rebuilds its
    # ``debt_role_valid`` CHECK from this iteration order and must emit SQL
    # byte-identical to migration 0017
    # (debt_role IS NULL OR debt_role IN ('principal', 'repayment')).
    principal = "principal"
    repayment = "repayment"


class DebtStatus(StrEnum):
    # A COMPUTED wire value, not a column (the DepositStatus precedent): a debt is
    # ``closed`` exactly when its remaining amount is 0, which is arithmetic over
    # its movements. Storing it would need every movement write AND delete to
    # recompute a flag — and deleting a repayment must simply reopen the debt. Like
    # DepositStatus, no CHECK is rebuilt from this definition order.
    open = "open"
    closed = "closed"
