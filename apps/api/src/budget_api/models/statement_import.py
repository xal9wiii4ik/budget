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
from decimal import Decimal
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
    Numeric,
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
    StatementAiStatus,
    StatementBalanceCheck,
    StatementImportStatus,
    StatementReconciliationStatus,
    StatementRowDecision,
    StatementRowMatchStatus,
    StatementSection,
    StatementSelfCheckFailure,
    StatementSelfCheckStatus,
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
_AI_STATUS_VALUES = _values(*(s.value for s in StatementAiStatus))
_SELF_CHECK_STATUS_VALUES = _values(*(s.value for s in StatementSelfCheckStatus))
_SELF_CHECK_FAILURE_VALUES = _values(*(s.value for s in StatementSelfCheckFailure))
_BALANCE_CHECK_VALUES = _values(*(s.value for s in StatementBalanceCheck))
_RECONCILIATION_STATUS_VALUES = _values(
    *(s.value for s in StatementReconciliationStatus)
)


class StatementImport(Base):
    __tablename__ = "statement_imports"
    __table_args__ = (
        CheckConstraint(f"status IN ({_STATUS_VALUES})", name="status_valid"),
        CheckConstraint(f"ai_status IN ({_AI_STATUS_VALUES})", name="ai_status_valid"),
        # pdf-reconcile 0019. The three PAIR checks below are hand-written literals
        # here AND in the migration: alembic cannot diff a CHECK on an existing
        # table, so the only alarm for a drift is tests/test_core_model.py.
        CheckConstraint(
            f"self_check_status IN ({_SELF_CHECK_STATUS_VALUES})",
            name="self_check_status_valid",
        ),
        CheckConstraint(
            f"self_check_failed IS NULL OR self_check_failed IN "
            f"({_SELF_CHECK_FAILURE_VALUES})",
            name="self_check_failed_valid",
        ),
        # "Failed" and "which check failed" are one fact: a failure with no name
        # could not be shown to the user, and a name without a failure would make
        # the apply gate's single-column read a lie.
        CheckConstraint(
            "(self_check_status = 'failed') = (self_check_failed IS NOT NULL)",
            name="self_check_detail",
        ),
        CheckConstraint(
            f"balance_check IN ({_BALANCE_CHECK_VALUES})", name="balance_check_valid"
        ),
        # The verdict and its two numbers travel together: ``not_available`` is
        # exactly the state with no app balance to report, and a diff without a
        # balance (or the other way round) would be half an answer.
        CheckConstraint(
            "((balance_check = 'not_available') = (app_balance_minor_at_end IS NULL))"
            " AND ((app_balance_minor_at_end IS NULL) = (balance_diff_minor IS NULL))",
            name="balance_check_pair",
        ),
        CheckConstraint(
            f"reconciliation_status IN ({_RECONCILIATION_STATUS_VALUES})",
            name="reconciliation_status_valid",
        ),
        # ``ok`` is the only status with a report, and it always has one: the read
        # route returns the JSONB verbatim, so "ok with nothing to show" would be
        # a 200 with no body to render.
        CheckConstraint(
            "(reconciliation_status = 'ok') = (reconciliation IS NOT NULL)",
            name="reconciliation_present",
        ),
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
    #: What the LLM pass did to this import (``StatementAiStatus``) — honest for
    #: every session, including the ones parsed before the feature existed: the
    #: server_default is ``not_configured``, which is exactly what was true of
    #: them. NOT NULL, because "we do not know what the AI did" is not one of the
    #: five answers.
    ai_status: Mapped[str] = mapped_column(
        String(16), server_default=text("'not_configured'")
    )
    #: Which provider/model/prompt produced this session's suggestions. Stamped
    #: whenever a provider EXISTED (so also for ``skipped`` and ``failed`` — "we
    #: asked this model and got nothing" is the diagnosable fact), all three NULL
    #: for ``not_configured``. Stored rather than read from Settings at display
    #: time: the setting moves, an old preview's provenance must not.
    ai_provider: Mapped[str | None] = mapped_column(String(32), nullable=True)
    ai_model: Mapped[str | None] = mapped_column(String(64), nullable=True)
    #: ``services/categorize.PROMPT_VERSION`` as it was at parse time — the key the
    #: evals report is also keyed by, so a row's suggestion can be traced to the
    #: prompt that produced it.
    ai_prompt_version: Mapped[str | None] = mapped_column(String(32), nullable=True)
    #: The balance anchors the file PRINTS for its period (pdf-reconcile
    #: architecture §2), in the statement currency's minor units. NULL for a format
    #: that carries none — every Priorbank session — which is why the balance check
    #: below has a ``not_available`` answer at all. Stored and not recomputed: they
    #: are what the BANK said, and the whole point of the post-import comparison is
    #: to hold our ledger against that sentence.
    opening_balance_minor: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    closing_balance_minor: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    #: Did the statement prove its own arithmetic (``StatementSelfCheckStatus``)?
    #: FOUR typed columns rather than one JSONB blob (D-M1): the apply gate reads
    #: exactly one of them, the preview renders two integers without parsing JSON,
    #: and a fixed four-field shape is not "flexible". NOT NULL with a
    #: ``not_available`` default — "we do not know whether it added up" is not one
    #: of the three answers.
    self_check_status: Mapped[str] = mapped_column(
        String(16), server_default=text("'not_available'")
    )
    #: Which check failed FIRST (``StatementSelfCheckFailure``), set if and only if
    #: the status is ``failed`` (CHECK ``self_check_detail``).
    self_check_failed: Mapped[str | None] = mapped_column(String(16), nullable=True)
    #: The two sides of the failed arithmetic, in minor units — what the file's
    #: anchors said and what the rows add up to. Both NULL for ``date_range``,
    #: which is not a difference anybody can subtract.
    self_check_expected_minor: Mapped[int | None] = mapped_column(
        BigInteger, nullable=True
    )
    self_check_actual_minor: Mapped[int | None] = mapped_column(
        BigInteger, nullable=True
    )
    #: The POST-import comparison (``StatementBalanceCheck``, D-B1), stamped inside
    #: the apply/replace transaction and never at upload: the pre-apply number
    #: describes a ledger the apply is about to change. INFORMATIONAL — it refuses
    #: nothing, because every honest cause of a mismatch (a skipped row, an app row
    #: the bank posts after the period) is the user's own decision to look at.
    balance_check: Mapped[str] = mapped_column(
        String(16), server_default=text("'not_available'")
    )
    #: The balance ``GET /accounts`` would show for the account on ``period_to``,
    #: and ``app_balance_minor_at_end - closing_balance_minor`` — the sign says
    #: which side holds more money. Both NULL exactly when the verdict is
    #: ``not_available`` (CHECK ``balance_check_pair``).
    app_balance_minor_at_end: Mapped[int | None] = mapped_column(
        BigInteger, nullable=True
    )
    balance_diff_minor: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    #: The reconcile agent's state (``StatementReconciliationStatus``, D-R5).
    #: ``running`` is a CLAIM: ``reconciliation_started_at`` is what lets a crashed
    #: run be re-claimed after twice the time budget instead of wedging the session.
    reconciliation_status: Mapped[str] = mapped_column(
        String(16), server_default=text("'none'")
    )
    reconciliation_started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    reconciled_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    #: The whole report (``services/reconcile.Report`` plus its usage block) as the
    #: agent returned it. JSONB and not a table: it is a per-session document read
    #: whole by one route, with no integrity meaning of its own, and a later run
    #: overwrites it. Present if and only if the status is ``ok``.
    reconciliation: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    #: Which provider/model/prompt produced the report — the ``ai_*`` trio's twin,
    #: stamped for a ``failed`` run too ("we asked this model and got nothing" is
    #: the diagnosable fact).
    reconcile_provider: Mapped[str | None] = mapped_column(String(32), nullable=True)
    reconcile_model: Mapped[str | None] = mapped_column(String(64), nullable=True)
    reconcile_prompt_version: Mapped[str | None] = mapped_column(
        String(32), nullable=True
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
    #: The bank's own text for the line ("Операция" in Priorbank, "Description" in
    #: Credo). Becomes the transaction's ``merchant`` on apply ONLY for a format
    #: that isolates no names at all — see ``merchant`` below.
    description: Mapped[str] = mapped_column(Text)
    #: The shop name the parser could isolate INSIDE a sentence-shaped description
    #: ("გადახდა - YANDEX.EDA 56.10 BYN 01.08.2026" → "YANDEX.EDA"). THREE-VALUED,
    #: and the three must SURVIVE this column (``types.display_name`` reads it back
    #: at apply time): a name; ``''`` — the parser looked and this line has no
    #: merchant, stored as the empty string and never collapsed to NULL, because
    #: NULL here means the third thing; NULL — the format isolates no names, so the
    #: description is the best name there is (the Priorbank case and the default).
    #: ``String(255)`` because this is what ``transactions.merchant`` is filled
    #: from (apply prefers it over ``description``), and it is also the text the
    #: merchant-category map is keyed by. A column and not a corner of ``raw``: it
    #: decides what a created transaction is called, so the preview must be able
    #: to SHOW it (``StatementRowRead.merchant``) and a reader must be able to
    #: query it.
    merchant: Mapped[str | None] = mapped_column(String(255), nullable=True)
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
    #: Every cell of the source line, keyed by the section's column header, and
    #: NOTHING else: the file verbatim. The escape hatch for what v1 does not model
    #: (digital-card number, and whatever the next format carries) — data is never
    #: dropped, and no new column is added for a value nothing reads yet. A value
    #: that DOES decide something gets a column instead (``merchant`` above): a key
    #: in here is invisible to the preview and to every query.
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
    #: What the model said about this row, when it was asked at all (ai-layer
    #: architecture §"Row seeding"). NULL = the pass never covered it: no provider,
    #: the rules already had an answer, or the row was left untouched by a budget,
    #: a cap or a failure.
    #:
    #: ``Numeric(4, 3)`` so the column is bounded to the 0..1 it is documented as
    #: (the service validates the range too); it is NOT money and crosses the wire
    #: as a ``float`` — no client arithmetic is involved beyond display.
    ai_confidence: Mapped[Decimal | None] = mapped_column(Numeric(4, 3), nullable=True)
    #: The model's own short justification, shown VERBATIM to the user. NULL for
    #: every unsure answer: a reason for a category nobody chose is noise. Never
    #: cleared afterwards — it records what the model said, not what is true now.
    ai_reason: Mapped[str | None] = mapped_column(String(300), nullable=True)
    #: "Look at this row before you apply": set for an unsure answer and for a
    #: seeded one the model was not confident about
    #: (``confidence < categorize_confidence_threshold``). Cleared by the PATCH
    #: that sends a category — the user looked. It blocks nothing; it is the live
    #: number behind the preview's "check category (N)" chip, which is why it is a
    #: column and the chip's count is a COUNT over it.
    needs_review: Mapped[bool] = mapped_column(
        Boolean, server_default=text("false"), default=False
    )
    decision: Mapped[str] = mapped_column(String(16))
