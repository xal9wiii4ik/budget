"""Statement import session and its parsed rows (statement-import architecture §1).

Both tables live in ONE module because they live and die together: a row without
its session is meaningless, and the session's counters describe exactly the rows
below it (``ON DELETE CASCADE``, so cancelling a session takes its rows with it).

Nothing here touches ``transactions``: a session is a PROPOSAL. The only column
pointing at real money is ``matched_tx_id`` (``ON DELETE SET NULL``) — a preview
must never keep a deleted transaction alive, and it must never be able to delete
one either.

Plain ``Mapped[...]``/``mapped_column`` style WITHOUT the ``TYPE_CHECKING`` split:
these tables serve no fastapi-users protocol.
"""

import uuid
from datetime import date, datetime, time
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    Time,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from budget_api.enums import (
    StatementImportStatus,
    StatementRowDecision,
    StatementRowMatchStatus,
    StatementSection,
    StatementSuggestionSource,
)
from budget_api.models.base import Base


def _values(*items: str) -> str:
    return ", ".join(f"'{item}'" for item in items)


# Rebuilt from the shared enums so the enums stay the single source for model,
# schema and CHECK. The rendered SQL MUST stay byte-identical to migration 0013 —
# the definition order of each enum is what guarantees that.
_STATUS_VALUES = _values(*(s.value for s in StatementImportStatus))
_SECTION_VALUES = _values(*(s.value for s in StatementSection))
_MATCH_STATUS_VALUES = _values(*(s.value for s in StatementRowMatchStatus))
_DECISION_VALUES = _values(*(d.value for d in StatementRowDecision))
_SUGGESTION_SOURCE_VALUES = _values(*(s.value for s in StatementSuggestionSource))


class StatementImport(Base):
    __tablename__ = "statement_imports"
    __table_args__ = (
        CheckConstraint(f"status IN ({_STATUS_VALUES})", name="status_valid"),
        CheckConstraint(
            "statement_currency ~ '^[A-Z]{3}$'", name="statement_currency_format"
        ),
        CheckConstraint("period_to >= period_from", name="period_ordered"),
        Index("ix_statement_imports_user_id_account_id", "user_id", "account_id"),
        # ONE live preview per account (migration 0013). PARTIAL — only ``parsed``
        # sessions are alive; applied and replaced ones are the journal of what was
        # done and accumulate freely — so an explicit name is mandatory, exactly as
        # for the transactions idempotency index: a partial unique index cannot be
        # a UniqueConstraint in Postgres.
        Index(
            "uq_statement_imports_live_preview",
            "user_id",
            "account_id",
            unique=True,
            postgresql_where=text("status = 'parsed'"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE")
    )
    #: The account this statement is being imported INTO. CASCADE for the same
    #: reason transactions cascade: an account is only ever hard-deleted by the user
    #: cascade, where its import sessions are equally dead.
    account_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("accounts.id", ondelete="CASCADE")
    )
    status: Mapped[str] = mapped_column(String(16))
    #: The parser that produced the rows (``priorbank_csv_v1``). Stored, not
    #: inferred: a second bank format is a new parser and old sessions must keep
    #: saying which one read them.
    source_format: Mapped[str] = mapped_column(String(32))
    filename: Mapped[str] = mapped_column(String(255))
    #: The currency the file's turnover column is denominated in — already verified
    #: to equal the account's currency at upload (422 STATEMENT_CURRENCY_MISMATCH
    #: otherwise), so it can never disagree with the money in the rows.
    statement_currency: Mapped[str] = mapped_column(String(3))
    period_from: Mapped[date] = mapped_column(Date)
    period_to: Mapped[date] = mapped_column(Date)
    #: Rows the parser turned into ``statement_import_rows`` — NOT the file's line
    #: count.
    rows_total: Mapped[int] = mapped_column(Integer)
    #: "Заблокированные суммы": authorized but not yet posted. Counted and DROPPED
    #: (architecture §1) — they arrive later as ordinary rows, so importing them
    #: would guarantee a duplicate. The counter is what makes the drop visible.
    rows_blocked: Mapped[int] = mapped_column(Integer)
    #: Rows whose turnover is zero: nothing moved, so there is nothing to import.
    rows_zero_skipped: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    #: Stamped when the session leaves ``parsed`` (S2/S3); NULL while it is a
    #: proposal.
    applied_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class StatementImportRow(Base):
    __tablename__ = "statement_import_rows"
    __table_args__ = (
        CheckConstraint(f"section IN ({_SECTION_VALUES})", name="section_valid"),
        CheckConstraint(
            f"match_status IN ({_MATCH_STATUS_VALUES})", name="match_status_valid"
        ),
        CheckConstraint(f"decision IN ({_DECISION_VALUES})", name="decision_valid"),
        CheckConstraint(
            f"suggestion_source IS NULL OR suggestion_source IN "
            f"({_SUGGESTION_SOURCE_VALUES})",
            name="suggestion_source_valid",
        ),
        CheckConstraint("amount_minor >= 0", name="amount_minor_non_negative"),
        # The SAME atomic pair the transactions table enforces (0009): a row that
        # carries half an original leg could not be turned into a transaction at
        # all, and apply must never discover that at INSERT time.
        CheckConstraint(
            "(original_amount_minor IS NULL) = (original_currency IS NULL)",
            name="original_pair",
        ),
        CheckConstraint(
            "original_currency ~ '^[A-Z]{3}$'", name="original_currency_format"
        ),
        # UNIQUE: ``row_index`` alone is the sort key of the paginated preview, so
        # offset paging is only total if no two rows of one session share it.
        Index(
            "ix_statement_import_rows_import_id_row_index",
            "import_id",
            "row_index",
            unique=True,
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    import_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("statement_imports.id", ondelete="CASCADE")
    )
    #: Position in the FILE (0-based, across both sections). The stable sort key of
    #: every paginated read — the file's order is the only order a user recognizes.
    row_index: Mapped[int] = mapped_column(Integer)
    section: Mapped[str] = mapped_column(String(16))
    #: "Дата транзакции" — when the purchase happened. This is what a created
    #: transaction is dated with, and the left edge of the matching window.
    txn_date: Mapped[date] = mapped_column(Date)
    #: The clock part of the same cell, NULL when the file said ``00:00:00`` —
    #: which the bank uses for "time unknown", not for midnight.
    txn_time: Mapped[time | None] = mapped_column(Time, nullable=True)
    #: "Дата операции по счету" — when the bank posted it, always ≥ ``txn_date``.
    booked_date: Mapped[date] = mapped_column(Date)
    #: "Операция" — becomes the transaction's ``merchant`` on apply.
    description: Mapped[str] = mapped_column(Text)
    #: The bank's own category string (22 distinct values in one real file), the
    #: key of ``bank_category_map``. Stored verbatim after a strip: it is a lookup
    #: key inside ONE format, so normalizing it would only make two spellings.
    bank_category: Mapped[str | None] = mapped_column(String(255), nullable=True)
    kind: Mapped[str] = mapped_column(String(16))
    #: |turnover| in the ACCOUNT's currency — the same magnitude-plus-kind shape
    #: ``transactions`` uses, so apply is a copy and never a sign conversion.
    amount_minor: Mapped[int] = mapped_column(BigInteger)
    #: What the purchase cost in the merchant's currency ("Сумма"/"Валюта"), set
    #: only when that currency differs from the statement's. The bank's own rate
    #: arrives as a FACT in this pair — we never convert it ourselves.
    original_amount_minor: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    original_currency: Mapped[str | None] = mapped_column(String(3), nullable=True)
    #: "Комиссия/Money-back", minor units of the statement currency, SIGN AS IN THE
    #: FILE (a fee is negative, a money-back positive) — a typed column rather than
    #: a corner of ``raw`` (PM §10.2) because a client must be able to show it
    #: without parsing "1 800,00" itself. NOT NULL, 0 when the cell is empty: "no
    #: fee" and "zero fee" are the same fact, and a nullable column would make
    #: every reader handle both.
    fee_minor: Mapped[int] = mapped_column(
        BigInteger, server_default=text("0"), default=0
    )
    #: Every cell of the source line, keyed by the section's column header. The
    #: escape hatch for what v1 does not model (digital-card number, and whatever
    #: the next format carries) — data is never dropped, and no new column is added
    #: for a value nothing reads yet.
    raw: Mapped[dict[str, Any]] = mapped_column(JSONB)
    #: The deterministic fingerprint of this row (architecture §3) — it becomes the
    #: created transaction's ``client_id``, which is what makes re-importing an
    #: overlapping period a no-op by CONSTRUCTION rather than by matching luck.
    client_id: Mapped[uuid.UUID] = mapped_column(Uuid)
    match_status: Mapped[str] = mapped_column(String(16))
    #: The best candidate, or NULL. SET NULL rather than CASCADE: deleting the
    #: transaction must not delete the preview row that mentions it.
    matched_tx_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("transactions.id", ondelete="SET NULL"), nullable=True
    )
    #: Every candidate behind a ``similar`` verdict (a JSON array of uuid strings),
    #: NULL otherwise. A JSONB array rather than a link table: it is a read-once
    #: preview detail with no integrity meaning of its own — the mini-views the API
    #: returns are JOINed from ``transactions`` at read time, so a deleted
    #: candidate simply stops being reported.
    candidate_tx_ids: Mapped[list[str] | None] = mapped_column(JSONB, nullable=True)
    #: Heuristic flag for the bank's P2P wording (architecture §5): the counter
    #: account is invisible from a one-account statement, so v1 FLAGS and never
    #: converts — a wrong auto-transfer could not be undone by an edit
    #: (KIND_CHANGE_UNSUPPORTED).
    possible_transfer: Mapped[bool] = mapped_column(
        Boolean, server_default=text("false"), default=False
    )
    #: The suggestion (S2) and, separately, the user's choice. Two columns, not
    #: one: "the server guessed X" and "the user picked X" are what the learning
    #: gate below distinguishes.
    suggested_category_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("categories.id", ondelete="SET NULL"), nullable=True
    )
    suggestion_source: Mapped[str | None] = mapped_column(String(16), nullable=True)
    category_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("categories.id", ondelete="SET NULL"), nullable=True
    )
    #: True only after the user explicitly sent a category (S2 PATCH). The gate of
    #: the learning upsert: a passively accepted suggestion must not teach the map
    #: its own guess, or a first mistake becomes permanent.
    category_user_set: Mapped[bool] = mapped_column(
        Boolean, server_default=text("false"), default=False
    )
    decision: Mapped[str] = mapped_column(String(16))
