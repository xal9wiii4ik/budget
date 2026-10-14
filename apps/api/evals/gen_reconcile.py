"""Generate the synthetic reconciliation cases the reconcile eval is scored on.

From ``apps/api``::

    uv run python evals/gen_reconcile.py --seed 20261014 --cases 6

writes ``dataset/synthetic-reconcile-v1.jsonl`` — one JSON object per case: the
statement rows the Alfa extractor would have produced, the app transactions the
user would already hold for the same account and period, and the gold set of
``(kind, row_id, transaction_id)`` triples.

**The gold is written FROM the perturbation log, so it cannot disagree with what
was done.** Each case starts with the app transactions as an exact COPY of the
statement rows — i.e. a perfectly reconciled account, which ``prematch`` settles
without a single model call — and a seeded RNG then applies ONE perturbation per
family:

* a transaction is dropped        → the row is ``missing_in_app``;
* a transaction is added          → it is ``extra_in_app``;
* a transaction's amount is moved → ``amount_differs``;
* a transaction's date is moved 1-3 days → ``date_differs``;
* the FX row's transaction is moved by a "conversion" difference →
  ``fx_difference`` (the row carries the foreign original pair, which is the only
  thing that distinguishes this kind from ``amount_differs``).

Four rows are involved (the dropped one, the amount, the date and the FX), so the
remaining rows MUST settle exactly: ``settled`` is that number, and a run that
reports fewer has a matcher regression, not a model problem.

Everything is invented. No owner data, no real merchant, no real amount: the
descriptions reuse ``gen_alfa``'s shapes because a reconciliation row IS what
that extractor produced.
"""

import logging
import sys
from pathlib import Path

if __package__ in {None, ""}:
    # See ``run.py``: the documented command is the script path, and the module
    # is also imported as ``evals.gen_reconcile`` by the regression test.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import argparse
import json
import random
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from budget_api.enums import DiscrepancyKind, TransactionKind
from evals.common import DATASET_DIR
from evals.gen_alfa import CITIES, CURRENCY, MERCHANT_PHRASE, MERCHANTS, PEOPLE

logger = logging.getLogger("evals.gen_reconcile")

DATASET_PATH = DATASET_DIR / "synthetic-reconcile-v1.jsonl"

#: The seed and the size of the COMMITTED set. Changing either re-cuts the
#: dataset, which invalidates ``replay/fake-fake-reconcile-v1.jsonl`` (the rows
#: travel in the tool results, which are part of the replay key) — re-record it
#: in the same pass.
DEFAULT_SEED = 20261014
DEFAULT_CASES = 6

#: Fixed, so the same seed produces the same ids forever: a dataset whose uuids
#: moved on every run would make the gold triples unreadable across revisions.
NS_RECONCILE_EVAL = uuid.UUID("5f6c6f3a-1e6b-4a2f-9a1e-2d1f0b7c5a01")

#: Rows per case. Big enough that the four perturbed rows are a minority (so a
#: run that settles nothing is visibly broken), small enough that the committed
#: replay fixture stays readable.
ROWS_PER_CASE = 12

#: Amount spacing, in minor units: wide enough that no perturbation can make one
#: transaction accidentally match ANOTHER row (which would settle the wrong pair
#: and make the gold a lie).
_AMOUNT_STEP = 4_000
_AMOUNT_BASE = 1_500
_AMOUNT_JITTER = 500
#: How far a perturbation moves an amount — well inside the spacing above.
_AMOUNT_SHIFT = (150, 300)
_FX_SHIFT = (40, 120)


@dataclass(frozen=True)
class Perturbation:
    """One deliberate difference, and the gold item it must produce."""

    kind: str
    row_id: uuid.UUID | None
    transaction_id: uuid.UUID | None


def _id(case: str, what: str, index: int) -> uuid.UUID:
    return uuid.uuid5(NS_RECONCILE_EVAL, f"{case}:{what}:{index}")


def _description(rng: random.Random, kind: str, index: int) -> tuple[str, str]:
    """``(description, merchant)`` for one row — the extractor's own pair."""
    if kind == TransactionKind.income.value:
        if index % 2:
            person = rng.choice(PEOPLE)
            return f"Зачисление перевода {person}", person
        return (
            "Зачисление заработной платы согласно ведомости"
            f" № {rng.randrange(100, 999)} организацией ООО ПРИДУМАННЫЕ РЕШЕНИЯ",
            "",
        )
    merchant = MERCHANTS[index % len(MERCHANTS)]
    return (
        f"{rng.randrange(10_000_000, 99_999_999)} {rng.choice(CITIES)}"
        f" {MERCHANT_PHRASE} {merchant}",
        merchant,
    )


def _row(
    case: str,
    rng: random.Random,
    index: int,
    day: date,
    *,
    fx: bool,
) -> dict[str, Any]:
    kind = (
        TransactionKind.income.value
        if index in {2, 7}
        else TransactionKind.expense.value
    )
    description, merchant = _description(rng, kind, index)
    amount = _AMOUNT_BASE + index * _AMOUNT_STEP + rng.randrange(_AMOUNT_JITTER)
    original = rng.randrange(5_000, 50_000) if fx else None
    return {
        "id": str(_id(case, "row", index)),
        "row_index": index,
        # The row's fingerprint. The app transactions of these cases are the
        # user's OWN (hand-typed), so none of them carries it — every settled
        # pair below is settled by VALUE, which is the harder arm to keep right.
        "client_id": str(_id(case, "client", index)),
        "txn_date": day.isoformat(),
        "booked_date": day.isoformat(),
        "kind": kind,
        "amount_minor": amount,
        "currency": CURRENCY,
        "original_amount_minor": original,
        "original_currency": "RUB" if fx else None,
        "description": description,
        "merchant": merchant,
    }


def _transaction(case: str, index: int, row: dict[str, Any]) -> dict[str, Any]:
    """The app's own record of that row: same money, same day, no fingerprint."""
    merchant: Any = row["merchant"]
    transaction: dict[str, Any] = {
        "id": str(_id(case, "tx", index)),
        "client_id": None,
        "occurred_at": row["txn_date"],
        "kind": row["kind"],
        "amount_minor": row["amount_minor"],
        "currency": CURRENCY,
        "merchant": merchant or None,
        "note": None,
        "is_transfer": False,
        "is_debt_movement": False,
    }
    return transaction


def case(index: int, rng: random.Random) -> dict[str, Any]:
    """One generated case: rows, transactions, gold — consistent by construction."""
    case_id = f"c{index + 1}"
    month = index % 12 + 1
    period_from = date(2026, month, 1)
    period_to = date(2026, month, 28)
    days = sorted(rng.sample(range(1, 29), ROWS_PER_CASE))
    fx_index = rng.randrange(ROWS_PER_CASE)
    # The ids are built ONCE and used by both the facts and the gold: reading a
    # uuid back out of the JSON dict is how a gold triple starts naming the
    # wrong side of a perturbation.
    row_ids = [_id(case_id, "row", position) for position in range(ROWS_PER_CASE)]
    tx_ids = [_id(case_id, "tx", position) for position in range(ROWS_PER_CASE)]
    extra_id = _id(case_id, "extra", 0)
    rows = [
        _row(
            case_id,
            rng,
            position,
            period_from.replace(day=day),
            fx=position == fx_index,
        )
        for position, day in enumerate(days)
    ]
    transactions = [
        _transaction(case_id, position, row) for position, row in enumerate(rows)
    ]

    dropped, amount_moved, date_moved = rng.sample(
        [position for position in range(ROWS_PER_CASE) if position != fx_index], 3
    )
    gold: list[Perturbation] = []

    # 1. The bank shows money the app does not hold.
    gold.append(
        Perturbation(DiscrepancyKind.missing_in_app.value, row_ids[dropped], None)
    )

    # 2. The same payment, recorded with a different amount.
    moved = transactions[amount_moved]
    shift = rng.randrange(*_AMOUNT_SHIFT) * rng.choice((-1, 1))
    moved["amount_minor"] = _amount_of(moved) + shift
    gold.append(
        Perturbation(
            DiscrepancyKind.amount_differs.value,
            row_ids[amount_moved],
            tx_ids[amount_moved],
        )
    )

    # 3. The same payment, recorded on another day. 1 day leaves it inside the
    #    matcher's ``similar`` window and 2-3 outside it — both are OPEN (only
    #    an ``exact`` verdict settles), so the model sees the pair either way.
    shifted = transactions[date_moved]
    days_off = rng.randrange(1, 4) * rng.choice((-1, 1))
    shifted["occurred_at"] = (_day_of(shifted) + timedelta(days=days_off)).isoformat()
    gold.append(
        Perturbation(
            DiscrepancyKind.date_differs.value,
            row_ids[date_moved],
            tx_ids[date_moved],
        )
    )

    # 4. The FX row: the app holds the amount the user converted by hand, which
    #    is not what the bank finally charged.
    converted = transactions[fx_index]
    converted["amount_minor"] = _amount_of(converted) + rng.randrange(*_FX_SHIFT)
    gold.append(
        Perturbation(
            DiscrepancyKind.fx_difference.value, row_ids[fx_index], tx_ids[fx_index]
        )
    )

    # 5. Money the app holds and the bank does not show. Its amount is outside
    #    the rows' spacing, so it cannot settle against any of them.
    extra: dict[str, Any] = {
        "id": str(extra_id),
        "client_id": None,
        "occurred_at": period_from.replace(day=days[-1]).isoformat(),
        "kind": TransactionKind.expense.value,
        "amount_minor": _AMOUNT_BASE + ROWS_PER_CASE * _AMOUNT_STEP + 7_777,
        "currency": CURRENCY,
        "merchant": "KIOSK BEZ CHEKA",
        "note": "наличными, без чека",
        "is_transfer": False,
        "is_debt_movement": False,
    }
    gold.append(Perturbation(DiscrepancyKind.extra_in_app.value, None, extra_id))

    kept = [
        transaction
        for position, transaction in enumerate(transactions)
        if position != dropped
    ] + [extra]
    return {
        "id": case_id,
        "currency": CURRENCY,
        "language": "ru",
        "period": [period_from.isoformat(), period_to.isoformat()],
        "rows": rows,
        "transactions": kept,
        "gold": [
            {
                "kind": item.kind,
                "row_id": None if item.row_id is None else str(item.row_id),
                "transaction_id": (
                    None if item.transaction_id is None else str(item.transaction_id)
                ),
            }
            for item in gold
        ],
        # The four rows above are open; everything else must settle by value.
        "settled": ROWS_PER_CASE - 4,
    }


def _amount_of(transaction: dict[str, Any]) -> int:
    value: Any = transaction["amount_minor"]
    assert isinstance(value, int)  # built as an int two functions above
    return value


def _day_of(transaction: dict[str, Any]) -> date:
    value: Any = transaction["occurred_at"]
    assert isinstance(value, str)  # built as an ISO date two functions above
    return date.fromisoformat(value)


def generate(*, seed: int, cases: int) -> list[dict[str, Any]]:
    """The whole dataset. Same seed and size ⇒ byte-identical output."""
    if cases < 1:
        raise ValueError("--cases must be at least 1")
    rng = random.Random(seed)
    return [case(index, rng) for index in range(cases)]


def write(rows: Sequence[dict[str, Any]], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = "".join(
        json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in rows
    )
    path.write_text(body, encoding="utf-8")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Generate the synthetic reconciliation dataset (reconcile eval)."
    )
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--cases", type=int, default=DEFAULT_CASES)
    parser.add_argument("--out", type=Path, default=DATASET_PATH)
    args = parser.parse_args(argv)
    rows = generate(seed=args.seed, cases=args.cases)
    write(rows, args.out)
    # Program OUTPUT, not logging.
    print(
        f"written: {args.out} ({len(rows)} cases,"
        f" {sum(len(row['gold']) for row in rows)} gold items,"
        f" {sum(row['settled'] for row in rows)} pairs that must settle)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
