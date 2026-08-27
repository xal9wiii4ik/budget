"""Statement-import request/response schemas (architecture §6, PM deltas §10).

Two shapes carry the scope's contract:

* a ROW looks like a TRANSACTION (§10.1) — ``amount_minor`` + ``currency`` (the
  account's) plus the ``original_*`` pair — so the web renders the
  "spent / debited" pair with the module it already has, and no adapter can
  reinterpret money on the way to the screen;
* a SESSION carries its counters in TWO cross-sections (§10.4): by
  ``match_status`` ("what was found") and by ``decision`` ("what will happen on
  apply"). The apply confirmation is built on the second, so it must not be
  derivable only by paging through a thousand rows.

The upload itself has no request model — it is a ``multipart/form-data`` body
whose fields are declared on the route. The S2 writes (one row's decision, one
group's decision) do, and both answer with a shape the client already renders:
the PATCH with the updated row (§10.3), the bulk with the session's counters
(§10.8), so neither costs a re-read of up to a thousand rows.
"""

import uuid
from datetime import date, datetime, time

from pydantic import BaseModel, Field

from budget_api.enums import (
    StatementImportStatus,
    StatementRowDecision,
    StatementRowMatchStatus,
    StatementSection,
    StatementSuggestionSource,
    TransactionKind,
)


class StatementRowCandidate(BaseModel):
    """A transaction the matcher pointed at, in mini form (§10.5).

    Embedded in the row rather than referenced by id: a preview screen with a
    thousand rows must not fire a thousand lookups to answer "which of my records
    is this?". JOINed at read time from ``candidate_tx_ids``, so a transaction
    deleted meanwhile simply stops being reported instead of becoming a dead id.
    """

    id: uuid.UUID
    occurred_at: date
    amount_minor: int
    currency: str
    kind: TransactionKind
    merchant: str | None
    note: str | None


class StatementRowRead(BaseModel):
    id: uuid.UUID
    #: Position in the FILE — the order the preview is paged in.
    row_index: int
    #: Which block of the file the row came from. DISPLAY only: both import into
    #: the one chosen account.
    section: StatementSection
    txn_date: date
    #: ``null`` when the file said ``00:00:00``: the bank's spelling of "time
    #: unknown", which is why it is not stored as midnight.
    txn_time: time | None
    booked_date: date
    #: The bank's operation text — becomes the transaction's ``merchant`` on apply.
    description: str
    bank_category: str | None
    kind: TransactionKind
    #: The money in the SAME shape ``TransactionRead`` uses (§10.1): magnitude plus
    #: kind, denominated in ``currency`` — which is the account's currency, already
    #: verified equal to the statement's at upload.
    amount_minor: int
    currency: str
    #: What the merchant charged, when it was not this currency. Decode at
    #: ``original_currency``'s exponent, never at the row's (the AM-5 no-fallback
    #: rule).
    original_amount_minor: int | None
    original_currency: str | None
    #: "Комиссия/Money-back" in ``currency``'s minor units, SIGN AS IN THE FILE
    #: (§10.2); 0 when the file carried none. It does NOT become a transaction in
    #: v1 — clients show it, nobody sums it.
    fee_minor: int
    match_status: StatementRowMatchStatus
    #: The best candidate, or null. Present for ``exact`` and ``similar`` alike; it
    #: is also the row that ``decision=replace_own`` would replace.
    matched_tx_id: uuid.UUID | None
    #: Every candidate behind the verdict, best first, with ``matched_tx_id``
    #: always first when there is one — so "show my record" needs no second call.
    candidates: list[StatementRowCandidate]
    #: What the server GUESSED at parse time, and where it got it from (§5):
    #: the merchant map beats the bank's own category, because one merchant is more
    #: specific than one of 22 buckets. Both null when neither map knew this row.
    suggested_category_id: uuid.UUID | None
    suggestion_source: StatementSuggestionSource | None
    #: The category the created transaction will carry — SEEDED from the suggestion
    #: at parse time, so a preview nobody edits still files its rows where the user
    #: has been filing them.
    category_id: uuid.UUID | None
    #: True once the user sent a category through PATCH. The learning gate: a
    #: suggestion left untouched must not teach the maps their own guess (§5), so
    #: "the server guessed X" and "the user picked X" cannot be one flag.
    category_user_set: bool
    #: The bank's P2P wording (architecture §5). A hint to the user, never an
    #: automatic transfer: this file cannot know the counter account, and a kind
    #: cannot be edited afterwards (KIND_CHANGE_UNSUPPORTED).
    possible_transfer: bool
    #: What apply will DO with this row. Defaulted from ``match_status`` at parse
    #: time (new → import, exact/similar → skip); the user's to change (S2).
    decision: StatementRowDecision


class StatementRowList(BaseModel):
    """The pagination envelope of ``GET /{id}/rows`` (the TransactionList shape)."""

    items: list[StatementRowRead]
    #: Rows matching the filter, not the page — the client renders "N of total"
    #: and pages without a second call.
    total: int


class MatchStatusCounts(BaseModel):
    """ "What was found" (§10.4)."""

    exact: int
    similar: int
    new: int


class DecisionCounts(BaseModel):
    """ "What will happen on apply" (§10.4) — the numbers the confirmation shows."""

    #: Wire name ``import``; the Python attribute carries the underscore because
    #: ``import`` is a keyword. A SERIALIZATION alias, not a plain one: the plain
    #: alias would also rename the constructor argument, and this model is only
    #: ever built in Python and read on the wire.
    import_: int = Field(serialization_alias="import")
    skip: int
    replace_own: int


class StatementImportRead(BaseModel):
    id: uuid.UUID
    account_id: uuid.UUID
    status: StatementImportStatus
    source_format: str
    filename: str
    #: The file's own currency — equal to the account's by construction (the
    #: upload refuses any other with 422 STATEMENT_CURRENCY_MISMATCH).
    statement_currency: str
    period_from: date
    period_to: date
    #: Rows stored for preview.
    rows_total: int
    #: Counted and dropped: "Заблокированные суммы" are not posted yet and would
    #: duplicate the ordinary rows that follow them later (task.md §4).
    rows_blocked: int
    #: Lines whose turnover was zero — nothing moved.
    rows_zero_skipped: int
    by_match_status: MatchStatusCounts
    by_decision: DecisionCounts
    created_at: datetime  # tz-aware
    #: Stamped when the session leaves ``parsed`` (S2/S3); null while it is a
    #: proposal.
    applied_at: datetime | None


class StatementImportError(BaseModel):
    """404/422 envelope — the ``DepositError`` shape with the refusal's facts (§10.7).

    ``detail`` is the stable UPPER_SNAKE code, as everywhere in this API. The
    optional fields are populated for exactly two refusals, each of which is
    unusable without them — one error model rather than several, so the routes'
    ``anyOf`` union stays a single reference:

    * ``STATEMENT_CURRENCY_MISMATCH`` — "this file is in BYN, that account is in
      USD" is the whole content of the refusal, and a client that had to re-derive
      it from two other requests would show the user a dead end;
    * ``REPLACE_CONFIRMATION_MISMATCH`` (S3) — the number the user confirmed and
      the number the server would really delete RIGHT NOW. The second is what the
      replace preview would answer on a re-read, so the client can redraw the
      warning instead of asking the user to guess what changed.
    """

    detail: str
    statement_currency: str | None = None
    account_currency: str | None = None
    #: What the client sent as its confirmation, echoed back.
    confirm_deleted_total: int | None = None
    #: What the server would delete now — the preview's ``deleted_total``.
    deleted_total: int | None = None


class StatementRowPatch(BaseModel):
    """The user's decision on ONE row (§10.3).

    Both fields are optional and independent — the preview edits them from two
    different controls, and a category click must not resend (or silently reset) a
    decision the user made a minute ago.

    ``category_id`` is TRI-STATE by presence, the project's PATCH grammar: omitted
    keeps what is there, a value sets it, an explicit ``null`` clears it back to
    "no category". Sending a category — and nothing else in this API — is what
    raises ``category_user_set``; an explicit ``null`` clears the choice and the
    flag with it. That flag is the gate of the learning upsert, so the server's own
    suggestion must never be able to teach the maps that made it.
    """

    #: ``null``/omitted means "leave the decision alone" rather than "clear it":
    #: every row always has one (defaulted from its match status at parse time).
    decision: StatementRowDecision | None = None
    category_id: uuid.UUID | None = None


class StatementBulkDecision(BaseModel):
    """One decision for every row of one match status (§10.8).

    Deliberately keyed by ``match_status`` and not by a list of row ids: the whole
    point is "keep all my own records" / "import everything new" on a thousand-row
    statement, and a client that had to enumerate ids would first have to page
    through them all.
    """

    match_status: StatementRowMatchStatus
    decision: StatementRowDecision


class StatementApplyReport(BaseModel):
    """What an apply DID — the response body and nowhere else (§10.6).

    Not persisted (v1): the durable record is the session's ``applied`` status plus
    the transactions themselves, and a stored report would be a second truth that
    can disagree with them.

    The four numbers add up to the session's row count: ``skipped`` is exactly the
    ``decision=skip`` cross-section the confirmation screen showed, and every other
    row ended in one of the three others. They are NOT a partition by row, and
    deliberately so: several ``similar`` rows may point at one record of the user's,
    which is deleted once. ``replaced`` therefore counts the records that
    disappeared, ``created`` the rest of what was written, and their sum is exactly
    the number of transactions this call inserted.
    """

    #: Transactions written by this call that did not replace a record of the user's.
    created: int
    #: Rows the user chose to leave alone.
    skipped: int
    #: The user's own records this call DELETED — each one replaced by the bank's
    #: version of it, deletion and insert in ONE database transaction.
    replaced: int
    #: Rows whose transaction was already in the ledger — the same fingerprint, so
    #: the same row of an earlier apply (B-1). A repeated apply reports every row
    #: here and writes nothing.
    already_existed: int


class StatementReplacePreview(BaseModel):
    """What ``POST /replace`` would destroy — counted BEFORE anything is confirmed.

    The whole point of the replace path is that it deletes transactions the
    statement will not necessarily bring back in the same shape (a receipt link, a
    plan payment, an attribution to a recurring template all die with the row), so
    the warning has to be built from the SERVER's own selection rather than from
    anything a client counted for itself.

    Reading it mutates nothing and is repeatable: the numbers may legitimately move
    between two reads if the user books something meanwhile, which is exactly why
    ``POST /replace`` re-checks them against ``confirm_deleted_total`` instead of
    trusting the number this response carried.

    ``deleted_total + transfers_kept`` is EVERY row the account shows in
    ``[from; period_to]`` — a non-transfer row can only ever be seen through its
    own ``account_id``, and a transfer through either leg. So the two numbers
    together say what happens to everything the user can see in that range, and
    nothing survives unannounced.
    """

    #: Rows the replace will DELETE: this account's own non-transfer transactions
    #: dated in ``[from; period_to]``. The number the client must echo back.
    deleted_total: int
    #: …of which carry a receipt link. The image stays in storage; the row that
    #: pointed at it does not.
    deleted_with_receipt: int
    #: …of which are payments of a goal's plan node. They leave that node's "paid".
    deleted_with_goal_item: int
    #: …of which were materialized from a recurring template. The attribution is
    #: lost with them (the template itself is untouched).
    deleted_with_recurring_template: int
    #: Transfers touching this account in the range, on EITHER leg. They are never
    #: deleted (architecture §7): one row is two accounts' history, and the second
    #: account is not in this file.
    transfers_kept: int
    #: Statement rows dated ``>= from`` — what the replace will insert, before the
    #: B-1 fingerprint pass decides which of them are already in the ledger.
    will_create: int


class StatementReplaceRequest(BaseModel):
    """The confirmed replace (architecture §7 + the S3 delta).

    ``confirm_deleted_total`` is the number the user read off the preview and typed
    back. It is TWO guards in one: a click cannot land on a destructive button by
    accident, and the server re-checks the number against what it is really about
    to delete — so data booked between the preview and the confirmation cannot be
    swept away by a number that was true a minute ago.
    """

    #: Start of the replaced range; its end is the session's ``period_to``. Must lie
    #: inside ``[period_from; period_to]`` — 422 REPLACE_FROM_OUT_OF_RANGE otherwise.
    from_date: date
    #: The preview's ``deleted_total``, echoed back. ``0`` is legal and means "the
    #: range holds nothing of mine".
    confirm_deleted_total: int = Field(ge=0)


class StatementReplaceReport(BaseModel):
    """What a replace DID — the response body and nowhere else (§10.6).

    Deliberately NOT ``StatementApplyReport``: that report's ``skipped`` and
    ``replaced`` describe per-row decisions, and a replace has none — it wipes a
    date range and re-files the statement over it. Reusing those names would let a
    reader believe a replace honoured decisions it explicitly ignores.
    """

    #: Transactions this call deleted — equal to the ``confirm_deleted_total`` that
    #: was accepted, by construction.
    deleted: int
    #: Transactions written from the statement's rows dated ``>= from_date``.
    created: int
    #: Rows whose fingerprint was already in the ledger AFTER the deletion — a
    #: transaction of an earlier import that survived outside the replaced range
    #: (B-1). Nothing is written for them, and nothing is duplicated.
    already_existed: int
