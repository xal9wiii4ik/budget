"""Matching a parsed statement against what the user already recorded (§4).

PURE: it takes the parsed rows, their fingerprints and a snapshot of candidate
transactions, and returns a verdict per row. No session, no queries — the router
loads the candidates in ONE select and this module decides, which is what makes
every threshold below testable without a database.

Three passes, in this order:

1. **exact by ``client_id``** — the transaction was created by an earlier import
   of this very row. True by construction, not by resemblance.
2. **exact by value** — same kind, same amount, and ``occurred_at`` on EITHER of
   the row's two dates: a hand-typed row is dated by the day of the purchase, but
   a user who typed it after seeing the debit dated it by the posting day.
3. **similar** — same kind and amount inside ``[txn_date-1; booked_date+1]``.
   The -1 covers a night purchase written down as yesterday, the +1 a row entered
   after the fact. Wider would not help: an amount without a date is a weak
   signal, and a false ``similar`` (which defaults to "keep mine", i.e. drop the
   bank's row) costs more than a missed one.

Pass 1 runs GLOBALLY, over every row, BEFORE any row is allowed a value match:
a ``client_id`` hit is proof, a value hit is resemblance, and letting an earlier
row's resemblance consume a transaction that a later row can PROVE is its own
would report the re-imported row as ``new`` (→ a duplicate on apply) and the
genuinely new one as ``exact`` (→ silently dropped). Only inside pass 2 is
"first come, first served in ``(txn_date, row_index)`` order" the rule.

Greedy 1:1 (architecture §4): an existing transaction can be the EXACT match of at
most one statement row. If the bank shows two identical payments and the user
recorded one, the second is honestly ``new`` instead of both rows claiming the
same transaction.

Transfers are ELIGIBLE ONLY AS ``similar`` candidates: a hand-recorded transfer
between the user's own accounts is one row seen from two sides, and the bank's P2P
line is the same money — but turning that into an exact match would silently
suppress a line whose counter account this file cannot prove.
"""

import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta

from budget_api.domain.merchant import normalize_merchant
from budget_api.enums import StatementRowDecision, StatementRowMatchStatus
from budget_api.services.statement_import.types import ParsedRow

#: How far outside the row's own two dates a ``similar`` candidate may sit.
SIMILAR_WINDOW = timedelta(days=1)


@dataclass(frozen=True)
class TxCandidate:
    """An existing transaction AS THIS ACCOUNT SEES IT.

    ``kind`` and ``amount_minor`` are the account's-eye view: for a transfer whose
    counter leg is this account the money ARRIVED, so the caller hands it over as
    an ``income`` of ``counter_amount_minor``. That is what lets one comparison
    serve both an ordinary row and either leg of a transfer, instead of the
    matcher re-deriving direction from ids it would have to be given as well.
    """

    id: uuid.UUID
    client_id: uuid.UUID | None
    kind: str
    amount_minor: int
    occurred_at: date
    merchant: str | None
    is_transfer: bool


@dataclass(frozen=True)
class RowMatch:
    """The verdict for one row: what was found, the best candidate, and the rest."""

    match_status: str
    matched_tx_id: uuid.UUID | None
    candidate_tx_ids: list[uuid.UUID] = field(default_factory=list[uuid.UUID])

    @property
    def decision(self) -> str:
        """The DEFAULT decision this verdict implies (architecture §4).

        ``new`` imports; ``exact`` and ``similar`` keep what the user already has.
        "Keep mine" is the safe default for ``similar`` precisely because it is the
        uncertain case — the preview highlights those rows, and importing them
        silently would create the duplicates this whole scope exists to avoid.
        """
        if self.match_status == StatementRowMatchStatus.new.value:
            return StatementRowDecision.import_.value
        return StatementRowDecision.skip.value


def _rank(row: ParsedRow, candidates: Sequence[TxCandidate]) -> list[TxCandidate]:
    """Best first: closest date, then a merchant that appears in the description.

    Text NEVER gates a match (the bank's description and a user's merchant name
    rarely agree), it only orders equally plausible candidates — which is why it is
    the second key and not the first.
    """
    description = normalize_merchant(row.description)

    def key(candidate: TxCandidate) -> tuple[int, int, str]:
        merchant = normalize_merchant(candidate.merchant or "")
        text_hit = bool(merchant) and merchant in description
        return (
            abs((candidate.occurred_at - row.txn_date).days),
            0 if text_hit else 1,
            # Total order, so two equally-ranked candidates never swap between
            # runs (the preview must be reproducible).
            str(candidate.id),
        )

    return sorted(candidates, key=key)


def _exact_by_value(
    row: ParsedRow, candidates: Sequence[TxCandidate], taken: set[uuid.UUID]
) -> list[TxCandidate]:
    return [
        candidate
        for candidate in candidates
        if not candidate.is_transfer
        and candidate.id not in taken
        and candidate.kind == row.kind
        and candidate.amount_minor == row.amount_minor
        and candidate.occurred_at in (row.txn_date, row.booked_date)
    ]


def _similar(
    row: ParsedRow, candidates: Sequence[TxCandidate], taken: set[uuid.UUID]
) -> list[TxCandidate]:
    since = row.txn_date - SIMILAR_WINDOW
    until = row.booked_date + SIMILAR_WINDOW
    return [
        candidate
        for candidate in candidates
        if candidate.id not in taken
        and candidate.kind == row.kind
        and candidate.amount_minor == row.amount_minor
        and since <= candidate.occurred_at <= until
    ]


def match_rows(
    rows: Sequence[ParsedRow],
    client_ids: Sequence[uuid.UUID],
    candidates: Sequence[TxCandidate],
) -> list[RowMatch]:
    """A verdict per row, positionally aligned with ``rows``."""
    if len(rows) != len(client_ids):
        raise ValueError("rows and client_ids must be aligned")

    by_client: dict[uuid.UUID, TxCandidate] = {
        candidate.client_id: candidate
        for candidate in candidates
        if candidate.client_id is not None
    }
    # Only EXACT matches consume a candidate. A ``similar`` verdict is a
    # suggestion the user still has to act on, so several rows may legitimately
    # point at the same transaction.
    taken: set[uuid.UUID] = set()
    verdicts: dict[int, RowMatch] = {}

    order = sorted(
        range(len(rows)), key=lambda i: (rows[i].txn_date, rows[i].row_index)
    )
    # Pass 1, over ALL rows first: a fingerprint hit is the row THIS transaction
    # was created from, so it is settled before anything is handed out on
    # resemblance. Running it per row inside the loop below would let an earlier
    # row's value match take a transaction a later row can prove is its own.
    for i in order:
        by_client_hit = by_client.get(client_ids[i])
        if by_client_hit is not None and by_client_hit.id not in taken:
            taken.add(by_client_hit.id)
            verdicts[i] = RowMatch(
                StatementRowMatchStatus.exact.value, by_client_hit.id
            )

    for i in order:
        if i in verdicts:
            continue
        row = rows[i]
        exact = _rank(row, _exact_by_value(row, candidates, taken))
        if exact:
            taken.add(exact[0].id)
            verdicts[i] = RowMatch(StatementRowMatchStatus.exact.value, exact[0].id)
            continue

        similar = _rank(row, _similar(row, candidates, taken))
        if similar:
            verdicts[i] = RowMatch(
                StatementRowMatchStatus.similar.value,
                similar[0].id,
                [candidate.id for candidate in similar],
            )
            continue

        verdicts[i] = RowMatch(StatementRowMatchStatus.new.value, None)

    return [verdicts[i] for i in range(len(rows))]
