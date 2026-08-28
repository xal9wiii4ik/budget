"""Transaction row → wire shape: the ONE place a ``TransactionRead`` is built.

Top-level neutral module (the ``account_access.py`` shape): it imports ``models``
and ``schemas`` and is imported by a router, so there is no cycle and no router
imports another router. Not ``services/`` — nothing here does IO — and not
``domain/``, which is pure math that knows about neither ORM rows nor DTOs.

``serialize_transaction`` is a PURE function of the row: no session, no joins. That
is load-bearing, not tidiness — it is what lets the idempotent-replay arm return a
stored transfer without re-reading the two accounts, and it is why
``counter_currency`` is denormalized onto the row at all (C-3).

The two rate strings are derived on every read and stored nowhere: the amounts are
the facts, and a stored rate could only ever disagree with them after an edit.
"""

from budget_api.domain.fx import transfer_rate
from budget_api.enums import TransactionKind
from budget_api.models import Transaction
from budget_api.schemas.transaction import TransactionRead


def _transfer_rate_str(tx: Transaction) -> str | None:
    """The transfer's implied rate as a decimal STRING, or None for a non-transfer.

    ``format(rate, "f")`` rather than ``str(rate)``: a Decimal produced under a
    6-significant-digit context prints in scientific notation
    (``3.95000E-5``) as soon as the exponent is small enough, and a client would
    have to parse that to render it.
    """
    if tx.counter_amount_minor is None or tx.counter_currency is None:
        return None
    rate = transfer_rate(
        tx.amount_minor, tx.currency, tx.counter_amount_minor, tx.counter_currency
    )
    return None if rate is None else format(rate, "f")


def _original_rate_str(tx: Transaction) -> str | None:
    """The original leg's implied rate as a decimal STRING, or None without a pair.

    Same contract as ``_transfer_rate_str`` above and the same helper behind it —
    ACCOUNT currency major per one ``original_currency`` major, 6 significant
    digits, ``format(rate, "f")`` so a small exponent never reaches a client as
    scientific notation. Derived on every read and stored nowhere: the two amounts
    are the facts, and a stored rate could only disagree with them after an edit.
    """
    if tx.original_amount_minor is None or tx.original_currency is None:
        return None
    rate = transfer_rate(
        tx.original_amount_minor, tx.original_currency, tx.amount_minor, tx.currency
    )
    return None if rate is None else format(rate, "f")


def serialize_transaction(tx: Transaction) -> TransactionRead:
    """Row → wire. A PURE function of the row (no session, no joins) — which is what
    lets the idempotent-replay arm return a stored transfer without re-reading the
    two accounts, and is why ``counter_currency`` is denormalized (C-3)."""
    return TransactionRead(
        id=tx.id,
        account_id=tx.account_id,
        amount_minor=tx.amount_minor,
        kind=TransactionKind(tx.kind),
        currency=tx.currency,
        base_amount_minor=tx.base_amount_minor,
        base_currency=tx.base_currency,
        category_id=tx.category_id,
        occurred_at=tx.occurred_at,
        note=tx.note,
        receipt_id=tx.receipt_id,
        recurring_template_id=tx.recurring_template_id,
        merchant=tx.merchant,
        counter_account_id=tx.counter_account_id,
        counter_amount_minor=tx.counter_amount_minor,
        counter_currency=tx.counter_currency,
        transfer_rate=_transfer_rate_str(tx),
        original_amount_minor=tx.original_amount_minor,
        original_currency=tx.original_currency,
        country=tx.country,
        original_rate=_original_rate_str(tx),
        goal_item_id=tx.goal_item_id,
        created_at=tx.created_at,
    )
