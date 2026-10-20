"""Score the reconcile agent over the synthetic cases: precision/recall per kind.

From ``apps/api``::

    uv run python evals/reconcile.py --provider fake --mode replay   # what CI runs
    uv run python evals/reconcile.py --provider fake --mode live
    uv run python evals/reconcile.py --provider fake --mode record  # cut a fixture
    ANTHROPIC_API_KEY=… uv run python evals/reconcile.py --provider anthropic \\
        --mode record

Nothing here reimplements the agent. It calls the same
:func:`budget_api.services.reconcile.prematch` and
:func:`budget_api.services.reconcile.reconcile` the route calls, with the
production ``ReconcileConfig`` defaults; the dataset supplies the FACTS the
router would have assembled from the ORM, which is why this runner needs no
database and no FastAPI app.

What is measured:

* **``prematch`` first.** ``settled`` is compared against the number the
  generator says MUST settle. A run that settles fewer has a matcher regression
  and every number below it is about the wrong input.
* **precision and recall per kind**, over ``(kind, row_id, transaction_id)``
  triples. Per kind and never averaged: the two one-sided kinds
  (``missing_in_app``, ``extra_in_app``) are cheap to get right and the three
  difference kinds are the whole point of having a model, so one mean would hide
  exactly the number worth reading.
* **silence**: ``unmentioned_rows``/``unmentioned_transactions``, the open items
  the model said nothing about. Silence is an ALLOWED answer (the prompt says
  so), and the app shows the count — so it is reported, not punished.
* **steps / calls / tokens / cost / latency** from the loop's own ``Usage`` list.

Honesty rules (``common.py``): ``--prompt-version`` must equal the build's, a
replay store that cannot answer raises instead of scoring 0%, and a ``fake``
report says in its own first lines that it is synthetic.
"""

import logging
import sys
from pathlib import Path

if __package__ in {None, ""}:
    # See ``run.py``: the documented command is the script path, and the module
    # is also imported as ``evals.reconcile`` by the regression test.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import argparse
import asyncio
import os
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from budget_api.enums import DiscrepancyKind
from budget_api.llm import Usage
from budget_api.services.reconcile import (
    PROMPT_VERSION,
    ReconcileConfig,
    ReconcileOutcome,
    RowFact,
    TxFact,
    prematch,
    reconcile,
)
from evals import common
from evals.common import (
    MODES,
    PROVIDERS,
    REPLAY_DIR,
    REPORTS_DIR,
    EvalError,
    cost_text,
    default_model,
    eval_provider,
    json_integer,
    json_objects,
    json_optional_integer,
    json_optional_text,
    json_optional_uuid,
    json_strings,
    json_text,
    json_uuid,
    ms_text,
    pct,
    percentile,
    ratio,
    replay_file,
    setting_float,
    setting_int,
    slug,
    start_fixture,
    synthetic_banner,
    total_cost,
    validate_run,
    write_report,
)
from evals.gen_reconcile import DATASET_PATH

logger = logging.getLogger("evals.reconcile")

#: The floor ``tests/test_evals_regression.py`` holds the two ONE-SIDED kinds'
#: recall to (``missing_in_app``, ``extra_in_app``).
#:
#: FAKE-CALIBRATED FLOOR, to be re-set after the first live run: the committed
#: fixture is recorded from ``FakeProvider("fake")``, whose scripted arm reports
#: EVERY open row as missing and EVERY open transaction as extra — so recall on
#: these two is 1.0 by construction (and their precision is poor, which the
#: report prints). What this floor catches is the loop breaking: a terminal call
#: that stops arriving, keys that stop resolving, validation dropping items.
RECONCILE_MIN_RECALL = 0.99

#: Pairs ``prematch`` must settle without any model at all.
#:
#: FAKE-CALIBRATED FLOOR — except this one is not about the fake at all: the
#: generator builds every untouched transaction as an exact copy of its row, so
#: ``settled`` is a property of ``matching.match_rows``, not of the provider.
#: 1.0 is the only acceptable value; the floor exists to name the number.
RECONCILE_MIN_SETTLED = 1.0

KINDS = tuple(kind.value for kind in DiscrepancyKind)
ONE_SIDED_KINDS = (
    DiscrepancyKind.missing_in_app.value,
    DiscrepancyKind.extra_in_app.value,
)
DIFFERENCE_KINDS = tuple(kind for kind in KINDS if kind not in ONE_SIDED_KINDS)

#: One finding: the kind and the two sides it names (``None`` where the kind
#: carries no id). The whole scoring is set arithmetic over these.
Triple = tuple[str, uuid.UUID | None, uuid.UUID | None]


@dataclass(frozen=True)
class GoldCase:
    """One generated case: the facts, and the differences that were seeded in."""

    id: str
    currency: str
    language: str
    period_from: date
    period_to: date
    rows: tuple[RowFact, ...]
    transactions: tuple[TxFact, ...]
    gold: tuple[Triple, ...]
    #: How many ``(row, transaction)`` pairs ``prematch`` must settle by itself.
    settled: int


@dataclass(frozen=True)
class KindStat:
    """Precision and recall for one discrepancy kind, over triples."""

    name: str
    support: int
    predicted: int
    hits: int

    @property
    def precision(self) -> float:
        return ratio(self.hits, self.predicted)

    @property
    def recall(self) -> float:
        return ratio(self.hits, self.support)


@dataclass(frozen=True)
class ReconcileReport:
    """Everything one reconciliation run measured. Rendered to markdown and JSON."""

    provider: str
    model: str
    prompt_version: str
    mode: str
    generated_at: datetime
    dataset: str
    cases: int
    reported: int
    #: ``aborted_reason`` → how many cases ended that way (no report at all).
    aborts: Mapping[str, int]
    settled: int
    settled_expected: int
    gold_items: int
    predicted_items: int
    unmentioned_rows: int
    unmentioned_transactions: int
    by_kind: tuple[KindStat, ...]
    steps: int
    calls: int
    input_tokens: int
    output_tokens: int
    cost_usd: Decimal | None
    latency_p50_ms: int | None
    latency_p95_ms: int | None

    @property
    def synthetic(self) -> bool:
        return self.provider == "fake"

    @property
    def settled_rate(self) -> float:
        return ratio(self.settled, self.settled_expected)

    def recall_of(self, kinds: Sequence[str]) -> float:
        """The WORST recall among ``kinds`` — a mean would hide a kind at zero."""
        return min(
            (stat.recall for stat in self.by_kind if stat.name in kinds), default=0.0
        )

    def to_markdown(self) -> str:
        lines = [
            f"# Reconciliation evals — {self.provider}/{self.model}"
            f" ({self.prompt_version})",
            "",
        ]
        lines += synthetic_banner(self.provider)
        lines += [
            f"- mode: `{self.mode}`",
            f"- run at: {self.generated_at.isoformat(timespec='seconds')}",
            f"- dataset: `{self.dataset}` ({self.cases} cases,"
            f" {self.gold_items} seeded differences), synthetic by construction",
            "",
            "## Pre-match (no model involved)",
            "",
            f"- settled by the server: {pct(self.settled_rate)}"
            f" ({self.settled} of {self.settled_expected} pairs that must settle)",
            "",
            "## The loop",
            "",
            f"- cases with a report: {self.reported}/{self.cases}"
            + (f" — aborted: {self._aborts_text()}" if self.aborts else ""),
            f"- items reported: {self.predicted_items} (gold: {self.gold_items})",
            f"- open items left unmentioned: {self.unmentioned_rows} rows,"
            f" {self.unmentioned_transactions} transactions"
            " — silence is an allowed answer, the app shows the count",
            "",
            "## Per kind",
            "",
            "| kind | gold | reported | right | precision | recall |",
            "| --- | --- | --- | --- | --- | --- |",
        ]
        for stat in self.by_kind:
            lines.append(
                f"| {stat.name} | {stat.support} | {stat.predicted} | {stat.hits} |"
                f" {pct(stat.precision)} | {pct(stat.recall)} |"
            )
        lines += [
            "",
            "A triple counts as right only when the kind AND both ids match the"
            " seeded difference: reporting the right pair under the wrong kind is"
            " a miss on one kind and a false positive on another, which is what"
            " the user would see.",
            "",
            "## Cost and latency",
            "",
            f"- steps: {self.steps} ({ratio(self.steps, self.cases):.1f} per case)",
            f"- calls: {self.calls}",
            f"- tokens in/out: {self.input_tokens}/{self.output_tokens}",
            f"- cost: {cost_text(self.cost_usd)}",
            f"- latency p50/p95: {ms_text(self.latency_p50_ms)}"
            f" / {ms_text(self.latency_p95_ms)}",
            "",
        ]
        return "\n".join(lines)

    def _aborts_text(self) -> str:
        return ", ".join(
            f"{reason}={count}" for reason, count in sorted(self.aborts.items())
        )

    def to_json(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "model": self.model,
            "prompt_version": self.prompt_version,
            "mode": self.mode,
            "synthetic": self.synthetic,
            "generated_at": self.generated_at.isoformat(timespec="seconds"),
            "dataset": self.dataset,
            "cases": self.cases,
            "reported": self.reported,
            "aborts": dict(sorted(self.aborts.items())),
            "settled": self.settled,
            "settled_expected": self.settled_expected,
            "settled_rate": round(self.settled_rate, 4),
            "gold_items": self.gold_items,
            "predicted_items": self.predicted_items,
            "unmentioned_rows": self.unmentioned_rows,
            "unmentioned_transactions": self.unmentioned_transactions,
            "one_sided_recall": round(self.recall_of(ONE_SIDED_KINDS), 4),
            "difference_recall": round(self.recall_of(DIFFERENCE_KINDS), 4),
            "by_kind": [
                {
                    "name": stat.name,
                    "support": stat.support,
                    "predicted": stat.predicted,
                    "hits": stat.hits,
                    "precision": round(stat.precision, 4),
                    "recall": round(stat.recall, 4),
                }
                for stat in self.by_kind
            ],
            "steps": self.steps,
            "calls": self.calls,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cost_usd": None if self.cost_usd is None else str(self.cost_usd),
            "latency_p50_ms": self.latency_p50_ms,
            "latency_p95_ms": self.latency_p95_ms,
        }


def production_config() -> ReconcileConfig:
    """The config the server runs with, read from ``Settings``' FIELD DEFAULTS.

    Field defaults rather than ``Settings()``: constructing Settings would read
    the environment and the local ``.env``, so a budget (and with it the exact
    request a replay fixture is keyed by) would depend on whose machine the
    regression test runs on. The defaults ARE the production values.
    """
    return ReconcileConfig(
        max_steps=setting_int("reconcile_max_steps"),
        max_total_tokens=setting_int("reconcile_max_total_tokens"),
        time_budget_seconds=setting_float("reconcile_time_budget_seconds"),
        max_items_per_side=setting_int("reconcile_max_items_per_side"),
    )


def load_dataset(path: Path, *, limit: int | None = None) -> tuple[GoldCase, ...]:
    """Read ``synthetic-reconcile-v1.jsonl``. A malformed line is an error."""
    cases: list[GoldCase] = []
    for number, body in enumerate(common.jsonl(path), 1):
        where = f"{path}:{number}"
        period = json_strings(body, "period", where)
        if len(period) != 2:
            raise EvalError(f"{where}: 'period' must be [from, to]")
        cases.append(
            GoldCase(
                id=json_text(body, "id", where),
                currency=json_text(body, "currency", where),
                language=json_text(body, "language", where),
                period_from=date.fromisoformat(period[0]),
                period_to=date.fromisoformat(period[1]),
                rows=tuple(
                    _row_fact(entry, f"{where} row {index}")
                    for index, entry in enumerate(json_objects(body, "rows", where), 1)
                ),
                transactions=tuple(
                    _tx_fact(entry, f"{where} transaction {index}")
                    for index, entry in enumerate(
                        json_objects(body, "transactions", where), 1
                    )
                ),
                gold=tuple(
                    _triple(entry, f"{where} gold {index}")
                    for index, entry in enumerate(json_objects(body, "gold", where), 1)
                ),
                settled=json_integer(body, "settled", where),
            )
        )
        if limit is not None and len(cases) >= limit:
            break
    return tuple(cases)


def _row_fact(entry: Mapping[str, Any], where: str) -> RowFact:
    merchant: Any = entry.get("merchant")
    if not isinstance(merchant, str | None):
        raise EvalError(f"{where}: 'merchant' must be a string or null")
    return RowFact(
        id=json_uuid(entry, "id", where),
        row_index=json_integer(entry, "row_index", where),
        client_id=json_uuid(entry, "client_id", where),
        txn_date=date.fromisoformat(json_text(entry, "txn_date", where)),
        booked_date=date.fromisoformat(json_text(entry, "booked_date", where)),
        kind=json_text(entry, "kind", where),
        amount_minor=json_integer(entry, "amount_minor", where),
        currency=json_text(entry, "currency", where),
        original_amount_minor=json_optional_integer(
            entry, "original_amount_minor", where
        ),
        original_currency=json_optional_text(entry, "original_currency", where),
        description=json_text(entry, "description", where),
        merchant=merchant,
    )


def _tx_fact(entry: Mapping[str, Any], where: str) -> TxFact:
    return TxFact(
        id=json_uuid(entry, "id", where),
        client_id=json_optional_uuid(entry, "client_id", where),
        occurred_at=date.fromisoformat(json_text(entry, "occurred_at", where)),
        kind=json_text(entry, "kind", where),
        amount_minor=json_integer(entry, "amount_minor", where),
        currency=json_text(entry, "currency", where),
        merchant=json_optional_text(entry, "merchant", where),
        note=json_optional_text(entry, "note", where),
        is_transfer=bool(entry.get("is_transfer")),
        is_debt_movement=bool(entry.get("is_debt_movement")),
    )


def _triple(entry: Mapping[str, Any], where: str) -> Triple:
    kind = json_text(entry, "kind", where)
    if kind not in KINDS:
        raise EvalError(f"{where}: {kind!r} is not a discrepancy kind")
    return (
        kind,
        json_optional_uuid(entry, "row_id", where),
        json_optional_uuid(entry, "transaction_id", where),
    )


async def evaluate_reconciliation(
    *,
    provider_name: str,
    model: str | None = None,
    prompt_version: str = PROMPT_VERSION,
    mode: str = "replay",
    limit: int | None = None,
    dataset_path: Path = DATASET_PATH,
    replay_dir: Path = REPLAY_DIR,
    api_key: str = "",
) -> ReconcileReport:
    """Reconcile every case of the dataset and measure it. No files written.

    Writing is the CLI's job (and the recorder's), so the regression test can
    call this in-process and compare two modes without touching the repo.
    """
    validate_run(provider_name, mode, prompt_version, PROMPT_VERSION)
    resolved_model = model or default_model(provider_name)
    config = common.for_provider(production_config(), provider_name)
    cases = load_dataset(dataset_path, limit=limit)
    replay_path = replay_file(replay_dir, provider_name, resolved_model, prompt_version)
    provider = eval_provider(
        provider_name,
        resolved_model,
        mode=mode,
        replay_path=replay_path,
        api_key=api_key,
    )

    settled = 0
    outcomes: list[ReconcileOutcome] = []
    for case in cases:
        pre = prematch(case.rows, case.transactions)
        settled += len(pre.settled)
        outcomes.append(
            await reconcile(
                provider,
                pre,
                config,
                period_from=case.period_from,
                period_to=case.period_to,
                currency=case.currency,
                language=case.language,
                user_id="evals",
            )
        )
    reported = sum(outcome.report is not None for outcome in outcomes)
    if mode == "replay" and any(
        outcome.aborted_reason == "replay_miss" for outcome in outcomes
    ):
        raise common.replay_miss(
            replay_path, reported, len(cases), "cases", "aborted_reason=replay_miss"
        )
    return _report(
        provider_name=provider_name,
        model=resolved_model,
        prompt_version=prompt_version,
        mode=mode,
        dataset=dataset_path.name,
        cases=cases,
        outcomes=outcomes,
        settled=settled,
    )


def _report(
    *,
    provider_name: str,
    model: str,
    prompt_version: str,
    mode: str,
    dataset: str,
    cases: Sequence[GoldCase],
    outcomes: Sequence[ReconcileOutcome],
    settled: int,
) -> ReconcileReport:
    support: dict[str, int] = dict.fromkeys(KINDS, 0)
    predicted: dict[str, int] = dict.fromkeys(KINDS, 0)
    hits: dict[str, int] = dict.fromkeys(KINDS, 0)
    gold_items = 0
    predicted_items = 0
    unmentioned_rows = 0
    unmentioned_transactions = 0
    steps = 0
    calls: list[Usage] = []
    aborts: dict[str, int] = {}
    for case, outcome in zip(cases, outcomes, strict=True):
        gold = set(case.gold)
        gold_items += len(gold)
        for kind, _row_id, _transaction_id in gold:
            support[kind] += 1
        steps += outcome.steps
        calls.extend(outcome.calls)
        if outcome.report is None:
            reason = outcome.aborted_reason or "unknown"
            aborts[reason] = aborts.get(reason, 0) + 1
            continue
        report = outcome.report
        unmentioned_rows += report.unmentioned_rows
        unmentioned_transactions += report.unmentioned_transactions
        for item in report.items:
            triple: Triple = (item.kind, item.row_id, item.transaction_id)
            predicted_items += 1
            if item.kind in predicted:
                predicted[item.kind] += 1
            if triple in gold:
                hits[item.kind] += 1
    latencies = [usage.latency_ms for usage in calls]
    return ReconcileReport(
        provider=provider_name,
        model=model,
        prompt_version=prompt_version,
        mode=mode,
        generated_at=datetime.now(UTC),
        dataset=dataset,
        cases=len(cases),
        reported=sum(outcome.report is not None for outcome in outcomes),
        aborts=aborts,
        settled=settled,
        settled_expected=sum(case.settled for case in cases),
        gold_items=gold_items,
        predicted_items=predicted_items,
        unmentioned_rows=unmentioned_rows,
        unmentioned_transactions=unmentioned_transactions,
        by_kind=tuple(
            KindStat(
                name=kind,
                support=support[kind],
                predicted=predicted[kind],
                hits=hits[kind],
            )
            for kind in KINDS
        ),
        steps=steps,
        calls=len(calls),
        input_tokens=sum(usage.input_tokens for usage in calls),
        output_tokens=sum(usage.output_tokens for usage in calls),
        cost_usd=total_cost(calls),
        latency_p50_ms=percentile(latencies, 0.5),
        latency_p95_ms=percentile(latencies, 0.95),
    )


def _parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Evaluate the reconcile agent over the synthetic cases."
    )
    parser.add_argument("--provider", choices=PROVIDERS, default="fake")
    parser.add_argument(
        "--model", default=None, help="defaults to the app's model for the provider"
    )
    parser.add_argument(
        "--prompt-version",
        default=PROMPT_VERSION,
        help="must equal the build's PROMPT_VERSION; a mismatch refuses the run",
    )
    parser.add_argument("--mode", choices=MODES, default="replay")
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="first N cases only (a fixture recorded without it still hits: one"
        " case = its own loop)",
    )
    parser.add_argument("--dataset", type=Path, default=DATASET_PATH)
    parser.add_argument("--replay-dir", type=Path, default=REPLAY_DIR)
    parser.add_argument("--reports-dir", type=Path, default=REPORTS_DIR)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    provider_name: str = args.provider
    model: str = args.model or default_model(provider_name)
    replay_dir: Path = args.replay_dir
    if args.mode == "record":
        start_fixture(
            replay_file(replay_dir, provider_name, model, args.prompt_version),
            provider_name,
        )
    try:
        report = asyncio.run(
            evaluate_reconciliation(
                provider_name=provider_name,
                model=model,
                prompt_version=args.prompt_version,
                mode=args.mode,
                limit=args.limit,
                dataset_path=args.dataset,
                replay_dir=replay_dir,
                api_key=os.environ.get("ANTHROPIC_API_KEY", ""),
            )
        )
    except EvalError as exc:
        print(f"evals: {exc}", file=sys.stderr)
        return 2
    stem = (
        f"reconcile-{slug(report.provider)}-{slug(report.model)}"
        f"-{report.prompt_version}"
    )
    paths = write_report(args.reports_dir, stem, report.to_markdown(), report.to_json())
    # Program OUTPUT (the report itself), not logging.
    print(report.to_markdown())
    for path in paths:
        print(f"written: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
