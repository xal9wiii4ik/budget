"""Matching and fingerprinting — the two pure decisions of the import (§3, §4).

Both modules decide what a preview will TELL the user (and, in S2, what apply
will create), and both are reachable without a database, so their thresholds are
pinned here rather than through the router: a window boundary or a greedy 1:1
verdict proved through HTTP would be the same assertion wrapped in six fixtures.
"""

import uuid
from datetime import date

from budget_api.enums import (
    StatementRowDecision,
    StatementRowMatchStatus,
    StatementSection,
    TransactionKind,
)
from budget_api.services.statement_import import FORMAT_IDS
from budget_api.services.statement_import.credo import FORMAT_ID as CREDO_FORMAT
from budget_api.services.statement_import.fingerprint import (
    FINGERPRINT_VERSIONS,
    client_ids,
)
from budget_api.services.statement_import.matching import TxCandidate, match_rows
from budget_api.services.statement_import.priorbank import FORMAT_ID as FORMAT
from budget_api.services.statement_import.types import ParsedRow

USER_ID = uuid.UUID("11111111-1111-1111-1111-111111111111")
ACCOUNT_ID = uuid.UUID("22222222-2222-2222-2222-222222222222")


def _row(
    *,
    row_index: int = 0,
    txn_date: date = date(2026, 6, 10),
    booked_date: date | None = None,
    amount_minor: int = 5_000,
    kind: str = TransactionKind.expense.value,
    description: str = "SHOP",
) -> ParsedRow:
    return ParsedRow(
        row_index=row_index,
        section=StatementSection.card.value,
        txn_date=txn_date,
        txn_time=None,
        booked_date=booked_date or txn_date,
        description=description,
        bank_category=None,
        kind=kind,
        amount_minor=amount_minor,
        original_amount_minor=None,
        original_currency=None,
        fee_minor=0,
        raw={},
        possible_transfer=False,
    )


def _candidate(
    *,
    occurred_at: date = date(2026, 6, 10),
    amount_minor: int = 5_000,
    kind: str = TransactionKind.expense.value,
    client_id: uuid.UUID | None = None,
    merchant: str | None = None,
    is_transfer: bool = False,
) -> TxCandidate:
    return TxCandidate(
        id=uuid.uuid4(),
        client_id=client_id,
        kind=kind,
        amount_minor=amount_minor,
        occurred_at=occurred_at,
        merchant=merchant,
        is_transfer=is_transfer,
    )


class TestMatching:
    def test_client_id_beats_a_value_match(self) -> None:
        """A row re-imported by fingerprint claims ITS transaction, not a lookalike.

        Both candidates are indistinguishable by value; only the fingerprint says
        which one this line already became. Picking the other would leave the real
        one unclaimed and the user with a duplicate on the next apply.
        """
        row = _row()
        fingerprint = client_ids(USER_ID, ACCOUNT_ID, [row], FORMAT)[0]
        lookalike = _candidate()
        recorded = _candidate(client_id=fingerprint)

        [verdict] = match_rows([row], [fingerprint], [lookalike, recorded])

        assert verdict.match_status == StatementRowMatchStatus.exact.value
        assert verdict.matched_tx_id == recorded.id
        assert verdict.decision == StatementRowDecision.skip.value

    def test_exact_matches_on_either_of_the_two_dates(self) -> None:
        """The purchase day AND the posting day both count as "the same row".

        The bank posts a day or three later and the file carries both dates; a user
        types whichever one they saw. Accepting only one would report half of an
        already-recorded month as new.
        """
        row = _row(txn_date=date(2026, 6, 10), booked_date=date(2026, 6, 12))
        fingerprints = client_ids(USER_ID, ACCOUNT_ID, [row], FORMAT)

        for occurred_at in (date(2026, 6, 10), date(2026, 6, 12)):
            candidate = _candidate(occurred_at=occurred_at)
            [verdict] = match_rows([row], fingerprints, [candidate])
            assert verdict.match_status == StatementRowMatchStatus.exact.value
            assert verdict.matched_tx_id == candidate.id

    def test_similar_window_is_one_day_on_each_side(self) -> None:
        """±1 day is ``similar``; ±2 is nothing at all.

        The contrast is the point: an amount with no date near it is a weak signal,
        and a false ``similar`` defaults to "keep mine", i.e. silently drops the
        bank's row from the import.
        """
        row = _row(txn_date=date(2026, 6, 10), booked_date=date(2026, 6, 12))
        fingerprints = client_ids(USER_ID, ACCOUNT_ID, [row], FORMAT)

        for occurred_at in (date(2026, 6, 9), date(2026, 6, 13)):
            [verdict] = match_rows(
                [row], fingerprints, [_candidate(occurred_at=occurred_at)]
            )
            assert verdict.match_status == StatementRowMatchStatus.similar.value

        for occurred_at in (date(2026, 6, 8), date(2026, 6, 14)):
            [verdict] = match_rows(
                [row], fingerprints, [_candidate(occurred_at=occurred_at)]
            )
            assert verdict.match_status == StatementRowMatchStatus.new.value
            assert verdict.decision == StatementRowDecision.import_.value

    def test_one_transaction_can_be_claimed_by_one_row_only(self) -> None:
        """Two identical payments against one record → exact + new, never exact twice.

        The real file has four byte-identical ``PAYBYCARD.BY`` lines. If the user
        recorded one, the second is honestly missing from the app, and saying
        "already there" about it would lose money quietly.
        """
        first = _row(row_index=0)
        second = _row(row_index=1)
        rows = [first, second]
        fingerprints = client_ids(USER_ID, ACCOUNT_ID, rows, FORMAT)
        recorded = _candidate()

        first_verdict, second_verdict = match_rows(rows, fingerprints, [recorded])

        assert first_verdict.match_status == StatementRowMatchStatus.exact.value
        assert first_verdict.matched_tx_id == recorded.id
        assert second_verdict.match_status == StatementRowMatchStatus.new.value
        assert second_verdict.matched_tx_id is None

    def test_a_fingerprint_hit_outranks_an_earlier_row_s_value_match(self) -> None:
        """The client_id pass runs over ALL rows before any value match is handed out.

        Row A is a genuinely new operation of the 10th, posted on the 11th; row B is
        the operation of the 11th that an earlier import already turned into the one
        recorded transaction. Both rows can match it by VALUE, and A is processed
        first — so a per-row pass 1 gives A the transaction (``exact`` → skip: the
        new operation is silently dropped) and leaves B with nothing (``new`` →
        import: a duplicate of money already recorded). Proof beats resemblance, in
        that order and globally, or the preview lies in both directions at once.
        """
        new_row = _row(
            row_index=0, txn_date=date(2026, 6, 10), booked_date=date(2026, 6, 11)
        )
        reimported = _row(row_index=1, txn_date=date(2026, 6, 11))
        rows = [new_row, reimported]
        fingerprints = client_ids(USER_ID, ACCOUNT_ID, rows, FORMAT)
        recorded = _candidate(occurred_at=date(2026, 6, 11), client_id=fingerprints[1])

        new_verdict, reimported_verdict = match_rows(rows, fingerprints, [recorded])

        assert reimported_verdict.match_status == StatementRowMatchStatus.exact.value
        assert reimported_verdict.matched_tx_id == recorded.id
        assert new_verdict.match_status == StatementRowMatchStatus.new.value
        assert new_verdict.decision == StatementRowDecision.import_.value

    def test_a_transfer_can_only_ever_be_similar(self) -> None:
        """A hand-recorded transfer is a candidate, never a settled verdict.

        A statement of ONE account cannot prove the counter account, so an exact
        match would let the bank's P2P line disappear against a transfer that may
        have nothing to do with it. As ``similar`` it is shown and the user decides.
        """
        row = _row()
        fingerprints = client_ids(USER_ID, ACCOUNT_ID, [row], FORMAT)
        # Same date as the row, so nothing but the transfer flag can be the reason
        # this is not an exact match.
        transfer = _candidate(is_transfer=True)

        [verdict] = match_rows([row], fingerprints, [transfer])

        assert verdict.match_status == StatementRowMatchStatus.similar.value
        assert verdict.candidate_tx_ids == [transfer.id]

    def test_candidates_are_ranked_by_date_then_text(self) -> None:
        """The best candidate is the closest one; text only breaks a tie.

        The merchant string of a hand-typed row and the bank's description rarely
        agree, so text can order candidates but must never decide whether there is
        a match at all.
        """
        # Window 06-09..06-13, with 06-10 and 06-12 excluded: a candidate ON either
        # of the row's own dates would be an EXACT match, not a ranked one.
        row = _row(
            txn_date=date(2026, 6, 10),
            booked_date=date(2026, 6, 12),
            description="SHOP WARSZAWA 12",
        )
        fingerprints = client_ids(USER_ID, ACCOUNT_ID, [row], FORMAT)
        far_right_text = _candidate(
            occurred_at=date(2026, 6, 13), merchant="Shop Warszawa"
        )
        near_wrong_text = _candidate(occurred_at=date(2026, 6, 11), merchant="Cafe")
        near_right_text = _candidate(occurred_at=date(2026, 6, 9), merchant="Shop")

        [verdict] = match_rows(
            [row], fingerprints, [far_right_text, near_wrong_text, near_right_text]
        )

        assert verdict.match_status == StatementRowMatchStatus.similar.value
        # The closest candidate WITH the text hit wins; the text hit three days
        # away does not, because date proximity is the stronger signal. Every
        # candidate is still reported — ranking never drops one.
        assert verdict.matched_tx_id == near_right_text.id
        assert set(verdict.candidate_tx_ids) == {
            far_right_text.id,
            near_wrong_text.id,
            near_right_text.id,
        }


class TestFingerprint:
    def test_identical_rows_get_distinct_stable_ids(self) -> None:
        """Two byte-identical payments differ by occurrence index — and only that.

        Without the index the two would collapse into one id and the second payment
        could never be imported; with a GLOBAL line number instead, the same
        operation in an overlapping statement would get a different id and be
        imported twice. Determinism across runs is what makes the whole B-1 replay
        mechanism work.
        """
        rows = [_row(row_index=0), _row(row_index=1)]

        first_run = client_ids(USER_ID, ACCOUNT_ID, rows, FORMAT)
        second_run = client_ids(USER_ID, ACCOUNT_ID, rows, FORMAT)

        assert first_run == second_run
        assert first_run[0] != first_run[1]
        # The SAME two rows in a statement that starts three lines earlier keep
        # their ids: the index counts identical rows, not file positions.
        shifted = [_row(row_index=7), _row(row_index=8)]
        assert client_ids(USER_ID, ACCOUNT_ID, shifted, FORMAT) == first_run

    def test_the_id_depends_on_the_account_and_the_row(self) -> None:
        """Same line, other account (or other amount) → another id.

        The fingerprint is a per-user, per-account key: the same coffee bought on
        two cards is two payments, and a changed amount is a different operation.
        """
        row = _row()
        other_account = uuid.UUID("33333333-3333-3333-3333-333333333333")

        [mine] = client_ids(USER_ID, ACCOUNT_ID, [row], FORMAT)
        [theirs] = client_ids(USER_ID, other_account, [row], FORMAT)
        [other_amount] = client_ids(
            USER_ID, ACCOUNT_ID, [_row(amount_minor=5_001)], FORMAT
        )

        assert len({mine, theirs, other_amount}) == 3

    def test_income_and_expense_of_the_same_size_differ(self) -> None:
        """The canonical carries the SIGNED amount, so a refund is not the purchase.

        A magnitude-only key would fingerprint "-25.40 shop" and "+25.40 refund"
        identically, and importing one would mark the other as already present.
        """
        expense = _row(kind=TransactionKind.expense.value)
        income = _row(kind=TransactionKind.income.value)

        assert client_ids(USER_ID, ACCOUNT_ID, [expense], FORMAT) != client_ids(
            USER_ID,
            ACCOUNT_ID,
            [income],
            FORMAT,
        )

    def test_the_priorbank_canonical_is_pinned(self) -> None:
        """This id is CONTRACT: it is stored on every transaction Priorbank created.

        The canonical string is not an implementation detail — ``client_id`` is what
        makes a re-upload a no-op, so a refactor that changes a separator, a field
        order or a date's spelling would re-import every user's whole history as
        new money. The literal below can only change together with a new version
        tag (``prior:v2``), never by accident; a second bank being added must not
        move it either, which is the whole reason the tag became per-format.
        """
        row = ParsedRow(
            row_index=0,
            section=StatementSection.contract.value,
            txn_date=date(2026, 6, 10),
            txn_time=None,
            booked_date=date(2026, 6, 12),
            description="SKLEP WARSZAWA",
            bank_category="Товары и услуги",
            kind=TransactionKind.expense.value,
            amount_minor=143_963,
            original_amount_minor=180_000,
            original_currency="PLN",
            fee_minor=-115,
            raw={},
            possible_transfer=False,
        )

        assert client_ids(USER_ID, ACCOUNT_ID, [row], FORMAT) == [
            uuid.UUID("8af617b4-5b26-5490-8ed6-6be1d64b9657")
        ]

    def test_the_canon_version_is_a_property_of_the_format(self) -> None:
        """Each format fingerprints under its own tag, and every format HAS one.

        Pinned against ``FORMAT_IDS`` — the UNION of the two registries since
        pdf-reconcile: an async EXTRACTOR is as much a format as a parser is, and
        the one read by a model is the one whose canon must be versioned most
        deliberately.

        Same line, two banks: the ids must differ, or one bank's statement could
        report another's rows as already imported. And a parser missing from the
        version map would fail an upload with a KeyError deep inside the service
        instead of a refusal — so the two registries are checked against each other
        here rather than discovered in production.
        """
        row = _row()

        assert set(FINGERPRINT_VERSIONS) == set(FORMAT_IDS)
        assert client_ids(USER_ID, ACCOUNT_ID, [row], FORMAT) != client_ids(
            USER_ID, ACCOUNT_ID, [row], CREDO_FORMAT
        )
