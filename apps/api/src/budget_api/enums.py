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


class AccountType(StrEnum):
    # Definition order (card, cash) is load-bearing: models/account.py rebuilds its
    # type CHECK from this iteration order and must emit SQL byte-identical to
    # migration 0008 (type IN ('card', 'cash')).
    card = "card"
    cash = "cash"


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
