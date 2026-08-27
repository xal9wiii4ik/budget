"""Account model — where the money physically sits (architecture §1).

Plain ``Mapped[...]``/``mapped_column`` style WITHOUT the ``TYPE_CHECKING`` split:
this table serves no fastapi-users protocol.

Follows the categories pattern deliberately: a boolean ``archived`` (not an
``archived_at`` timestamp — the codebase's actual archive shape), no
``unique(user_id, name)`` (categories has none either), and ``user_id`` NOT NULL
because — unlike categories — there are no shared system accounts.

The balance is NOT stored (architecture §2): it is summed on read from the
transaction legs by ``services/account_balances.py``. A stored balance would need
a dual write on every create/PATCH/DELETE *including* the idempotent-replay and
IntegrityError-recovery arms, which is exactly the drift class this codebase avoids.
``starting_balance_minor`` carries NO sign CHECK: a credit card legitimately starts
in the red. Since the deposits scope it is also the OPENING BODY of a deposit
(AMENDMENT §1): a ``type='deposit'`` row is the hidden 1:1 ledger of a ``deposits``
row, invisible in ``GET /accounts`` and unreachable by PATCH — it is created and
managed exclusively through ``/deposits``.
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    String,
    Uuid,
    false,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from budget_api.enums import ACCOUNT_TYPE_VALUES
from budget_api.models.base import Base

# Rebuilt from the shared enums module so it stays the single source for model,
# schema and contract. ACCOUNT_TYPE_VALUES is the two client-facing types followed
# by the internal ``deposit`` one (enums.py explains why the third is not an enum
# member). The rendered SQL MUST stay byte-identical to the LAST migration that
# touched the constraint — 0012 (``type IN ('card', 'cash', 'deposit')``, widened
# from 0008's two values); the fixed order of that tuple guarantees it, which is why
# ``deposit`` is appended there and never inserted.
_TYPE_VALUES = ", ".join(f"'{t}'" for t in ACCOUNT_TYPE_VALUES)


class Account(Base):
    __tablename__ = "accounts"
    __table_args__ = (
        CheckConstraint(f"type IN ({_TYPE_VALUES})", name="type_valid"),
        CheckConstraint("currency ~ '^[A-Z]{3}$'", name="currency_format"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(100))
    # IMMUTABLE after creation (architecture §4): every transaction on the account is
    # stamped with this currency, so changing it would restate history. PATCH with a
    # currency is 422 ACCOUNT_CURRENCY_IMMUTABLE; the flow is archive + new account.
    currency: Mapped[str] = mapped_column(String(3))
    type: Mapped[str] = mapped_column(String(16))
    # Minor units OF THIS ACCOUNT'S currency — the opening balance the computed
    # balance starts from. Editable (OQ-4): it is a setup fact, not history.
    starting_balance_minor: Mapped[int] = mapped_column(
        BigInteger, default=0, server_default=text("0")
    )
    archived: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=false()
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
