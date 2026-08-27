"""Apply and replace — turning a preview into transactions (architecture §7).

The scope's TWO writes, in one module because they share everything except which
rows they file: ``apply_import`` executes the per-row decisions of the "reconcile"
path, ``replace_import`` wipes a date range of the account and re-files the
statement over it. Both go through ``_create_transactions``, so how a statement row
becomes money is written once.

A SERVICE and not a loop of HTTP calls: a thousand rows need ONE database
transaction and ONE report, not a thousand independent requests each with its own
422. Either the whole statement lands or none of it does, and the session's status
moves with the money.

What it repeats from ``POST /transactions``, deliberately and by hand (the router
cannot be called from here, and ``services`` may not import ``routers``):

* ``currency`` is STAMPED from the account — the statement's currency was already
  verified equal to it at upload, so no row can file foreign money as the
  account's own;
* the base snapshot follows the same decision table: none at all when the account
  is already in the base currency, otherwise ``auto_snapshot`` at ``txn_date`` —
  which yields the honest NULL/NULL pair when no rate for that day exists;
* the ``original_*`` pair is copied AS THE BANK PRINTED IT. The bank applied its
  own rate and we never restate it;
* ``merchant`` goes through ``clean_merchant`` — the same trim / "empty is None"
  contract the route uses, so a line the bank left without a description becomes a
  NULL merchant here too. Written raw it would become a nameless merchant of its
  own, and the top-merchants population excludes NULLs, not empty strings.

What it deliberately does NOT repeat: the row's category is written as it stands,
WITHOUT re-checking that it is still un-archived. That check ran in the row PATCH,
where the user picked it and where the refusal was actionable; archiving a category
between that click and this write is a narrow race, and refusing a whole statement
over one such row would be the worse answer of the two.

Idempotency is ONE mechanism and only one (B-1): every row carries a deterministic
``client_id`` (architecture §3), ``transactions`` has a partial unique index on
``(user_id, client_id)``, and this module select-firsts against it and recovers
from the insert race. A second apply of the same session therefore creates
nothing, deletes nothing and reports every row as ``already_existed``.
"""

import logging
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.enums import (
    StatementImportStatus,
    StatementRowDecision,
    TransactionKind,
)
from budget_api.models import (
    Account,
    StatementImport,
    StatementImportRow,
    Transaction,
)
from budget_api.schemas.transaction import clean_merchant
from budget_api.services.fx_lookup import auto_snapshot
from budget_api.services.profile_reads import get_or_create_profile
from budget_api.services.statement_import.categories import learn_categories

logger = logging.getLogger(__name__)

#: ``transactions.merchant`` is ``String(255)`` while a statement ``description`` is
#: TEXT. Truncating the DISPLAY name is the only lossless option here: the full
#: text stays on the import row, and the alternative — a database error in the
#: middle of a batch — would refuse a whole statement over a long shop name. The
#: fingerprint is computed from the FULL description, so nothing about identity
#: depends on this cut. The cut runs BEFORE ``clean_merchant``, whose own cap is a
#: ValueError — a 422 for the user's own typing, not for a bank's long shop name.
_MERCHANT_MAX = 255

#: "Not a transfer" — the replace's own selection, spelled ONCE and imported by the
#: router's replace-preview: the counters that warn the user and the DELETE below
#: are the SAME expression, so they cannot drift apart. A transfer is one row seen
#: from two accounts and the second account is not in this file.
NOT_TRANSFER = Transaction.kind != TransactionKind.transfer.value


class StatementApplyError(Exception):
    """A refusal the router turns into its status code, carrying the string code."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class ApplyOutcome:
    """What the write DID. ``skipped`` is deliberately absent — see the router.

    The number of untouched rows is a ``decision`` cross-section, and the ONE
    implementation of those counters lives next to the session read (``_counts_of``)
    so that the confirmation screen and the report can never disagree about them.

    ``replaced`` counts the user's own records that were DELETED, not the rows that
    asked for it: several ``similar`` rows may legitimately point at one transaction
    (see ``matching.py``), and one transaction is deleted once. ``created`` is the
    rest of what was written, so ``created + replaced`` is always the number of
    transactions this call inserted.
    """

    created: int
    replaced: int
    already_existed: int


async def _load_target(
    session: AsyncSession,
    import_id: uuid.UUID,
    user_id: uuid.UUID,
    *,
    require_parsed: bool,
) -> tuple[StatementImport, Account]:
    """The session and its account, with the gates BOTH writes owe the user.

    Loaded user-scoped, so a foreign id is an ordinary miss; a session that was
    cancelled between the route's own gate and this call is IMPORT_NOT_FOUND, which
    the router turns into its ordinary 404.

    ``require_parsed`` is the ONE way the two writes differ, and deliberately so:

    * ``apply_import`` passes ``False``. Its retry after an insert race must
      converge idempotently through the B-1 fingerprint pass and report
      ``already_existed``; re-gating the status would answer 422 IMPORT_FINISHED to
      the loser of a double-submit instead (S2 decision).
    * ``replace_import`` passes ``True``. Its retry CANNOT converge that way — it
      would re-run the DELETE over a range a parallel write has just refilled and
      rely on ``deleted != confirm`` arithmetic to refuse. A lifecycle gate refuses
      the same case by construction, before a single row is touched.
    """
    session_row = await session.scalar(
        select(StatementImport).where(
            StatementImport.id == import_id, StatementImport.user_id == user_id
        )
    )
    if session_row is None:  # deleted between the route's gate and here
        raise StatementApplyError("IMPORT_NOT_FOUND")
    if require_parsed and session_row.status != StatementImportStatus.parsed.value:
        raise StatementApplyError("IMPORT_FINISHED")
    account = await session.scalar(
        select(Account).where(
            Account.id == session_row.account_id, Account.user_id == user_id
        )
    )
    if account is None:  # pragma: no cover - the FK cascades, so it cannot vanish
        # An account can only disappear WITH its import sessions (ON DELETE
        # CASCADE), so "the session is gone" is the same answer and the only one
        # that does not invent a second not-found code for one impossible state.
        raise StatementApplyError("IMPORT_NOT_FOUND")
    if account.archived:
        # The same closed door every other write to an archived account meets. A
        # mass import is the last write that should be allowed to slip through it,
        # and on the replace path the door also guards a deletion.
        raise StatementApplyError("ACCOUNT_ARCHIVED")
    return session_row, account


async def _existing_client_ids(
    session: AsyncSession, user_id: uuid.UUID, client_ids: Sequence[uuid.UUID]
) -> set[uuid.UUID]:
    """The B-1 select-first, BATCHED: one ``IN`` over the partial unique index.

    One query for the whole statement instead of one per row — and the same
    user-scoped lookup ``POST /transactions`` performs, so a fingerprint guessed
    from another user's data is an ordinary miss.
    """
    if not client_ids:
        return set()
    found = await session.scalars(
        select(Transaction.client_id).where(
            Transaction.user_id == user_id, Transaction.client_id.in_(client_ids)
        )
    )
    return {client_id for client_id in found if client_id is not None}


async def _replaceable_targets(
    session: AsyncSession, user_id: uuid.UUID, tx_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, uuid.UUID | None]:
    """What ``replace_own`` may delete: each target's id mapped to its ``client_id``.

    A READ, run BEFORE any write, so the refusal below leaves the transaction clean.
    The transfer gate lives here as well as in the row PATCH (where the user makes
    the choice, and where the refusal names the row): a transfer is ONE row seen
    from two accounts, so deleting it would erase the other account's history for
    money this file cannot even see. Apply is where the deletion would actually
    happen, and it must not depend on every future writer of ``decision`` having
    been honest — bulk-decision already is a second one.

    The value is the target's own ``client_id``, because that is what decides
    whether deleting it FREES the fingerprint the row is about to insert under (see
    ``apply_import``).

    A matched transaction the user has since deleted (the FK nulls the column) is
    simply not among the ids handed here: "throw mine away and take the bank's" is
    satisfied by creating the bank's row, and the report counts it as ``created``
    rather than claiming a replacement that did not happen.
    """
    if not tx_ids:
        return {}
    targets = (
        await session.execute(
            select(Transaction.id, Transaction.client_id, Transaction.kind).where(
                Transaction.user_id == user_id, Transaction.id.in_(tx_ids)
            )
        )
    ).all()
    if any(kind == TransactionKind.transfer.value for _, _, kind in targets):
        raise StatementApplyError("TRANSFER_REPLACE_FORBIDDEN")
    return {tx_id: client_id for tx_id, client_id, _ in targets}


async def _delete_replaced(
    session: AsyncSession, user_id: uuid.UUID, doomed: set[uuid.UUID]
) -> None:
    """The ``replace_own`` DELETE: user-scoped, inside the apply transaction."""
    if not doomed:
        return
    await session.execute(
        delete(Transaction).where(
            Transaction.user_id == user_id, Transaction.id.in_(doomed)
        )
    )


async def _create_transactions(
    session: AsyncSession,
    user_id: uuid.UUID,
    account: Account,
    rows: Sequence[StatementImportRow],
) -> None:
    """Statement rows → transactions, with the stamps of ``POST /transactions``.

    THE insertion core of this module, shared by both writes: apply hands it the
    rows a decision asked for, replace hands it everything dated into the replaced
    range. Which rows arrive is the whole difference between the two paths — how a
    row becomes money must not be, or the two would drift into two ledgers.

    Adds to the session and never flushes: the caller's single transaction is what
    makes a thousand rows land together or not at all.
    """
    profile = await get_or_create_profile(session, user_id)
    base = profile.base_currency
    for row in rows:
        if account.currency == base:
            # A base-currency row's own amount IS its base amount; a second,
            # independently editable copy of it could only ever be a lie (the
            # create decision table of POST /transactions).
            base_amount_minor, base_currency = None, None
        else:
            base_amount_minor, base_currency = await auto_snapshot(
                session, row.amount_minor, account.currency, base, row.txn_date
            )
        session.add(
            Transaction(
                user_id=user_id,
                account_id=account.id,
                amount_minor=row.amount_minor,
                kind=row.kind,
                currency=account.currency,
                base_amount_minor=base_amount_minor,
                base_currency=base_currency,
                category_id=row.category_id,
                # The day of the PURCHASE, not of the posting: it is what the user
                # would have typed, and what the matcher compared against.
                occurred_at=row.txn_date,
                merchant=clean_merchant(row.description[:_MERCHANT_MAX]),
                original_amount_minor=row.original_amount_minor,
                original_currency=row.original_currency,
                client_id=row.client_id,
            )
        )


async def apply_import(
    session: AsyncSession, import_id: uuid.UUID, user_id: uuid.UUID
) -> ApplyOutcome:
    """Execute a session's decisions in ONE transaction. Retryable AS A WHOLE.

    Everything it needs is re-read from the database on entry, so the caller's
    retry after an ``IntegrityError`` rollback starts from clean instances rather
    than from ones a failed flush already expired.

    Note what is NOT checked here: the ``parsed`` status (``require_parsed=False``,
    the one way this differs from the replace). The route gates it once, before the
    first attempt; a retry that re-gated it would answer 422 IMPORT_FINISHED to the
    loser of a double-submit instead of the idempotent "nothing to do, it is all
    already there" the B-1 pass below produces.
    """
    session_row, account = await _load_target(
        session, import_id, user_id, require_parsed=False
    )

    rows = list(
        (
            await session.scalars(
                select(StatementImportRow)
                .where(StatementImportRow.import_id == import_id)
                .order_by(StatementImportRow.row_index)
            )
        ).all()
    )
    actionable = [
        row for row in rows if row.decision != StatementRowDecision.skip.value
    ]
    replacing = [
        (row, row.matched_tx_id)
        for row in actionable
        if row.decision == StatementRowDecision.replace_own.value
        and row.matched_tx_id is not None
    ]
    targets = await _replaceable_targets(
        session, user_id, [tx_id for _, tx_id in replacing]
    )

    existing = await _existing_client_ids(
        session, user_id, [row.client_id for row in actionable]
    )
    # A ``replace_own`` row can point at the transaction an EARLIER apply created
    # from this very line — that is exactly what ``exact`` by fingerprint means.
    # Deleting it frees the fingerprint, so such a row is work to do and not an
    # ``already_existed``: reporting it as one would answer 200 to "drop my edited
    # copy, take the bank's" and then quietly do nothing. Delete and insert sit in
    # ONE database transaction, which the partial unique index tolerates.
    freed = {
        row.client_id for row, tx_id in replacing if targets.get(tx_id) == row.client_id
    }
    pending = [
        row
        for row in actionable
        if row.client_id not in existing or row.client_id in freed
    ]

    pending_ids = {row.id for row in pending}
    doomed = {
        tx_id for row, tx_id in replacing if row.id in pending_ids and tx_id in targets
    }
    await _delete_replaced(session, user_id, doomed)
    # Counted over what really happened: one transaction is deleted ONCE however
    # many rows pointed at it, so ``replaced`` is the number of the user's records
    # that disappeared and ``created`` the rest of the insert.
    replaced = len(doomed)
    created = len(pending) - replaced

    await _create_transactions(session, user_id, account, pending)
    await learn_categories(session, user_id, rows)

    session_row.status = StatementImportStatus.applied.value
    if session_row.applied_at is None:
        # Preserved on a retry: the moment the money landed is the FIRST apply, and
        # a recovered race must not restate it.
        session_row.applied_at = datetime.now(UTC)
    await session.commit()
    logger.info(
        "statement import applied import=%s created=%s replaced=%s existed=%s",
        import_id,
        created,
        replaced,
        len(actionable) - len(pending),
    )
    return ApplyOutcome(
        created=created,
        replaced=replaced,
        already_existed=len(actionable) - len(pending),
    )


class StatementReplaceMismatch(Exception):
    """The confirmed number is not what would really be deleted (S3 delta).

    Carries BOTH numbers because the client cannot act on either alone: the one it
    sent proves which preview it was looking at, and the one the server counted is
    what a fresh preview would now say.
    """

    def __init__(self, confirm_deleted_total: int, deleted_total: int) -> None:
        super().__init__("REPLACE_CONFIRMATION_MISMATCH")
        self.code = "REPLACE_CONFIRMATION_MISMATCH"
        self.confirm_deleted_total = confirm_deleted_total
        self.deleted_total = deleted_total


@dataclass(frozen=True)
class ReplaceOutcome:
    """What a replace DID: what disappeared, what was written, what was already in.

    ``created + already_existed`` is the number of statement rows dated into the
    replaced range; ``deleted`` is unrelated to it — the range held whatever it held.
    """

    deleted: int
    created: int
    already_existed: int


async def replace_import(
    session: AsyncSession,
    import_id: uuid.UUID,
    user_id: uuid.UUID,
    from_date: date,
    confirm_deleted_total: int,
) -> ReplaceOutcome:
    """Wipe ``[from_date; period_to]`` of the account and re-file the statement.

    The destructive twin of ``apply_import``, and the one write of this scope that
    destroys data the file may not bring back in the same shape. Everything happens
    in ONE database transaction — a range half-deleted and half-refilled is the one
    outcome no user could ever repair by hand.

    The selection, verbatim from architecture §7 and NOT negotiable per row:

    * ``account_id`` is the SOURCE leg only, never "either leg": deleting through
      the counter leg would destroy rows that belong to another account's history;
    * ``kind != 'transfer'``: one transfer row is two accounts' history, and the
      second account is not in this file;
    * ``occurred_at`` between ``from_date`` and the session's ``period_to`` — both
      inclusive, both compared against the same date the created rows carry.

    The confirmation is checked against the DELETE ITSELF: the statement runs with
    ``RETURNING``, so the number compared is precisely the set of rows that just
    disappeared, not a count taken a moment earlier that a concurrent write could
    have invalidated. A disagreement rolls the whole transaction back before
    anything else is attempted — nothing is deleted, nothing is written — and the
    caller answers 422 with both numbers.

    Unlike ``apply_import`` this re-checks the ``parsed`` status
    (``require_parsed=True``): the route gates it before the first attempt, but the
    retry arm above an insert race would otherwise re-run the DELETE over a session
    a parallel write has already finished. See ``_load_target``.

    Decisions are IGNORED by design: "replace this range with the bank's version of
    it" is one gesture over a range, and honouring per-row skips inside a range the
    user just wiped would leave holes nobody asked for. The B-1 fingerprint pass
    still runs, AFTER the deletion, so rows whose transaction the deletion freed are
    re-created while rows that survived elsewhere (a date the user edited out of the
    range) are reported ``already_existed`` instead of being duplicated.
    """
    session_row, account = await _load_target(
        session, import_id, user_id, require_parsed=True
    )

    deleted = len(
        (
            await session.execute(
                delete(Transaction)
                .where(
                    Transaction.user_id == user_id,
                    Transaction.account_id == session_row.account_id,
                    NOT_TRANSFER,
                    Transaction.occurred_at >= from_date,
                    Transaction.occurred_at <= session_row.period_to,
                )
                .returning(Transaction.id),
                execution_options={"synchronize_session": False},
            )
        )
        .scalars()
        .all()
    )
    if deleted != confirm_deleted_total:
        # Rolled back HERE, next to the DELETE, so "nothing was deleted" is a
        # property of this function and not of the caller remembering to undo it.
        await session.rollback()
        logger.info(
            "statement replace refused import=%s confirmed=%s actual=%s",
            import_id,
            confirm_deleted_total,
            deleted,
        )
        raise StatementReplaceMismatch(confirm_deleted_total, deleted)

    rows = list(
        (
            await session.scalars(
                select(StatementImportRow)
                .where(StatementImportRow.import_id == import_id)
                .order_by(StatementImportRow.row_index)
            )
        ).all()
    )
    in_range = [row for row in rows if row.txn_date >= from_date]
    existing = await _existing_client_ids(
        session, user_id, [row.client_id for row in in_range]
    )
    pending = [row for row in in_range if row.client_id not in existing]
    await _create_transactions(session, user_id, account, pending)
    # Over ALL the session's rows, exactly as apply does: what the user taught by
    # categorizing a line is true whether or not that line falls into the range
    # being replaced (the gate is ``category_user_set``, never the selection).
    await learn_categories(session, user_id, rows)

    session_row.status = StatementImportStatus.replaced.value
    if session_row.applied_at is None:
        session_row.applied_at = datetime.now(UTC)
    await session.commit()
    logger.info(
        "statement import replaced import=%s from=%s deleted=%s created=%s existed=%s",
        import_id,
        from_date,
        deleted,
        len(pending),
        len(in_range) - len(pending),
    )
    return ReplaceOutcome(
        deleted=deleted,
        created=len(pending),
        already_existed=len(in_range) - len(pending),
    )
