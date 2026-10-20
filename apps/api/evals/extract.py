"""Score the Alfa-PDF extraction over the synthetic dataset: fields, rows, cost.

From ``apps/api``::

    uv run python evals/extract.py --provider fake --mode replay   # what CI runs
    uv run python evals/extract.py --provider fake --mode live
    uv run python evals/extract.py --provider fake --mode record   # (re)cut the fixture
    ANTHROPIC_API_KEY=… uv run python evals/extract.py --provider anthropic \
        --mode record

Nothing here reimplements the extraction. It builds the provider the app builds
and calls the same :func:`budget_api.services.statement_import.alfa_pdf
.extract_from_text` with the production ``ExtractConfig`` defaults, over the TEXT
``text_lines`` would hand it (D-E2: exactly one pytest opens a PDF, and the evals
never do). The only difference is the quota callback, which always says yes.

What is measured, and why each number is separate:

* **per-field accuracy** — date, the signed amount, currency, the FX original
  pair, merchant — over the GOLD rows, so a row the model never answered counts
  as wrong on every field. Merchant is reported on its own because it is the one
  field with no second source: the amounts are checked against the header
  anchors, the merchant is checked against nothing but the gold.
* **exact row count** per statement: a statement with one row too few or too many
  is a statement whose self-check cannot pass, whatever the fields say.
* **self-check agreement** — does the extractor's ``SelfCheck`` match what the
  generator PUT in the file? Three of the twelve committed statements hide one
  operation line while keeping it in the printed totals, so this number says
  whether the arithmetic guard works, not whether the model is good.
* **calls / tokens / cost / latency**, from the provider's own ``Usage`` (the
  extraction reports them only to the log, so the evals wrap the provider).

Honesty rules (``common.py``): ``--prompt-version`` must equal the build's, a
replay store that cannot answer raises instead of scoring 0%, and a ``fake``
report says in its own first lines that it is synthetic.
"""

import logging
import sys
from pathlib import Path

if __package__ in {None, ""}:
    # See ``run.py``: the documented command is the script path, and the module
    # is also imported as ``evals.extract`` by the regression test.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import argparse
import asyncio
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from budget_api.llm import Usage
from budget_api.services.statement_import.alfa_pdf import (
    PROMPT_VERSION,
    ExtractConfig,
    StatementExtractionError,
    extract_from_text,
)
from budget_api.services.statement_import.types import (
    ParsedRow,
    ParsedStatement,
    StatementParseError,
)
from evals import common
from evals.common import (
    MODES,
    PROVIDERS,
    REPLAY_DIR,
    REPORTS_DIR,
    EvalError,
    UsageProvider,
    cost_text,
    default_model,
    eval_provider,
    json_integer,
    json_objects,
    json_strings,
    json_text,
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
from evals.gen_alfa import DATASET_PATH

logger = logging.getLogger("evals.extract")

#: The floor ``tests/test_evals_regression.py`` holds the four STRUCTURAL fields
#: to (date, signed amount, currency, FX original pair).
#:
#: FAKE-CALIBRATED FLOOR, to be re-set after the first live run: the committed
#: fixture is recorded from ``FakeProvider("fake")``, whose extract arm is one
#: regex over the layout this dataset prints — it reads all four fields of every
#: line, so it scores 1.0 and this number sits a hair below. It is NOT a model
#: quality bar: what it catches is a mechanical regression (chunking, key
#: assignment, the server-side money conversion, the original-pair rule).
EXTRACT_MIN_ACCURACY = 0.99

#: The same floor for the merchant field, which is the one the fake is BAD at.
#:
#: FAKE-CALIBRATED FLOOR, to be re-set after the first live run: the fake only
#: knows the card-purchase phrase, so it answers nothing for the ERIP line and
#: the two transfer lines of every statement and scores 0.833 — the floor is a
#: hair below that, and a real model is expected to be far above it.
EXTRACT_MIN_MERCHANT_ACCURACY = 0.82

#: Statements whose ``SelfCheck`` came out as the generator built it.
#:
#: FAKE-CALIBRATED FLOOR, to be re-set after the first live run: the fake reads
#: every line, so every consistent statement passes and every statement with a
#: hidden line fails on ``balance`` — 1.0, floor a hair below. A real model that
#: misreads one digit will score lower here, and that is the number to read.
EXTRACT_MIN_SELF_CHECK = 0.99

#: Field names, in report order. ``currency`` is a field of the model's answer
#: and not of ``ParsedRow``: the extractor REFUSES a row whose currency is not
#: the header's (D-E6), so it is scored as "this row exists and the statement's
#: currency is the gold one" — 1.0 for every statement that extracted at all.
FIELDS = ("date", "amount", "currency", "original_pair", "merchant")


@dataclass(frozen=True)
class GoldRow:
    """What a correct reading of one operation line returns."""

    key: str
    day: date
    kind: str
    amount_minor: int
    original_amount_minor: int | None
    original_currency: str | None
    #: ``""`` means "this line names no merchant" — the extractor's own spelling
    #: for a sentence-shaped format (``types.display_name``), never ``None``.
    merchant: str


@dataclass(frozen=True)
class GoldStatement:
    """One generated statement: the text to read, and what it should produce."""

    id: str
    currency: str
    period_from: date
    period_to: date
    opening_minor: int
    closing_minor: int
    income_minor: int
    expense_minor: int
    lines: tuple[str, ...]
    rows: tuple[GoldRow, ...]
    #: ``passed`` or ``failed`` — see ``gen_alfa.py``'s ``--mismatch-share``.
    expect_self_check: str


@dataclass(frozen=True)
class FieldStat:
    """Per-field accuracy over the GOLD rows (an unanswered row counts wrong)."""

    name: str
    correct: int
    support: int

    @property
    def accuracy(self) -> float:
        return ratio(self.correct, self.support)


@dataclass(frozen=True)
class ExtractReport:
    """Everything one extraction run measured. Rendered to markdown and JSON."""

    provider: str
    model: str
    prompt_version: str
    mode: str
    generated_at: datetime
    dataset: str
    statements: int
    extracted: int
    #: ``StatementExtractionError`` code (or ``parse_error``) → how many
    #: statements died of it. An extraction that failed scores zero rows.
    failures: Mapping[str, int]
    rows_gold: int
    rows_returned: int
    rows_all_fields: int
    row_count_exact: int
    fields: tuple[FieldStat, ...]
    self_check_as_expected: int
    self_check_passed: int
    self_check_failed: int
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
    def structural_accuracy(self) -> float:
        """The WORST of the four non-merchant fields: the honest headline.

        An average would let a field at 0% hide behind three at 100%, and each of
        these four is load-bearing on its own (a wrong date imports money into
        the wrong month, a wrong amount is a wrong balance).
        """
        return min(
            (stat.accuracy for stat in self.fields if stat.name != "merchant"),
            default=0.0,
        )

    @property
    def merchant_accuracy(self) -> float:
        return next(
            (stat.accuracy for stat in self.fields if stat.name == "merchant"), 0.0
        )

    @property
    def self_check_agreement(self) -> float:
        return ratio(self.self_check_as_expected, self.statements)

    def to_markdown(self) -> str:
        lines = [
            f"# Extraction evals — {self.provider}/{self.model}"
            f" ({self.prompt_version})",
            "",
        ]
        lines += synthetic_banner(self.provider)
        lines += [
            f"- mode: `{self.mode}`",
            f"- run at: {self.generated_at.isoformat(timespec='seconds')}",
            f"- dataset: `{self.dataset}` ({self.statements} statements,"
            f" {self.rows_gold} gold rows), synthetic by construction",
            "",
            "## Rows",
            "",
            f"- statements extracted: {self.extracted}/{self.statements}"
            + (f" — failures: {self._failures_text()}" if self.failures else ""),
            f"- exact row count: {pct(ratio(self.row_count_exact, self.statements))}"
            f" ({self.row_count_exact}/{self.statements} statements)",
            f"- rows returned: {self.rows_returned} (gold: {self.rows_gold})",
            f"- rows right in EVERY field:"
            f" {pct(ratio(self.rows_all_fields, self.rows_gold))}"
            f" ({self.rows_all_fields}/{self.rows_gold})",
            "",
            "## Per-field accuracy",
            "",
            "| field | rows | correct | accuracy |",
            "| --- | --- | --- | --- |",
        ]
        for stat in self.fields:
            lines.append(
                f"| {stat.name} | {stat.support} | {stat.correct} |"
                f" {pct(stat.accuracy)} |"
            )
        lines += [
            "",
            "Denominator is the GOLD rows, so a line the model did not answer"
            " counts as wrong in every field. `currency` is 1.0 for any statement"
            " that extracted at all: the server REFUSES a row whose currency is"
            " not the header's, so a disagreement shows up as a failed extraction"
            " instead.",
            "",
            "## Self-check (the arithmetic guard, not the model)",
            "",
            f"- as the generator built it:"
            f" {pct(self.self_check_agreement)}"
            f" ({self.self_check_as_expected}/{self.statements})",
            f"- passed: {self.self_check_passed} · failed: {self.self_check_failed}",
            "",
            "## Cost and latency",
            "",
            f"- calls: {self.calls}",
            f"- tokens in/out: {self.input_tokens}/{self.output_tokens}",
            f"- cost: {cost_text(self.cost_usd)}",
            f"- latency p50/p95: {ms_text(self.latency_p50_ms)}"
            f" / {ms_text(self.latency_p95_ms)}",
            "",
        ]
        return "\n".join(lines)

    def _failures_text(self) -> str:
        return ", ".join(
            f"{code}={count}" for code, count in sorted(self.failures.items())
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
            "statements": self.statements,
            "extracted": self.extracted,
            "failures": dict(sorted(self.failures.items())),
            "rows_gold": self.rows_gold,
            "rows_returned": self.rows_returned,
            "rows_all_fields": self.rows_all_fields,
            "row_count_exact": self.row_count_exact,
            "structural_accuracy": round(self.structural_accuracy, 4),
            "merchant_accuracy": round(self.merchant_accuracy, 4),
            "self_check_agreement": round(self.self_check_agreement, 4),
            "self_check_passed": self.self_check_passed,
            "self_check_failed": self.self_check_failed,
            "by_field": [
                {
                    "name": stat.name,
                    "support": stat.support,
                    "correct": stat.correct,
                    "accuracy": round(stat.accuracy, 4),
                }
                for stat in self.fields
            ],
            "calls": self.calls,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cost_usd": None if self.cost_usd is None else str(self.cost_usd),
            "latency_p50_ms": self.latency_p50_ms,
            "latency_p95_ms": self.latency_p95_ms,
        }


def production_config() -> ExtractConfig:
    """The config the server runs with, read from ``Settings``' FIELD DEFAULTS.

    Field defaults rather than ``Settings()``: constructing Settings would read
    the environment and the local ``.env``, so the chunk size (and with it the
    exact request a replay fixture is keyed by) would depend on whose machine the
    regression test runs on. The defaults ARE the production values.
    """
    return ExtractConfig(
        lines_per_call=setting_int("extract_lines_per_call"),
        concurrency=setting_int("extract_concurrency"),
        time_budget_seconds=setting_float("extract_time_budget_seconds"),
        max_lines=setting_int("extract_max_lines"),
    )


def load_dataset(path: Path, *, limit: int | None = None) -> tuple[GoldStatement, ...]:
    """Read ``statements.jsonl``. A malformed line is an error, never a skip."""
    statements: list[GoldStatement] = []
    for number, body in enumerate(common.jsonl(path), 1):
        where = f"{path}:{number}"
        period = json_strings(body, "period", where)
        if len(period) != 2:
            raise EvalError(f"{where}: 'period' must be [from, to]")
        statements.append(
            GoldStatement(
                id=json_text(body, "id", where),
                currency=json_text(body, "currency", where),
                period_from=date.fromisoformat(period[0]),
                period_to=date.fromisoformat(period[1]),
                opening_minor=json_integer(body, "opening_minor", where),
                closing_minor=json_integer(body, "closing_minor", where),
                income_minor=json_integer(body, "income_minor", where),
                expense_minor=json_integer(body, "expense_minor", where),
                lines=tuple(json_strings(body, "lines", where)),
                rows=tuple(_gold_rows(body, where)),
                expect_self_check=json_text(body, "expect_self_check", where),
            )
        )
        if limit is not None and len(statements) >= limit:
            break
    return tuple(statements)


def _gold_rows(body: Mapping[str, Any], where: str) -> list[GoldRow]:
    rows: list[GoldRow] = []
    for index, entry in enumerate(json_objects(body, "gold_rows", where), 1):
        spot = f"{where} gold row {index}"
        merchant: Any = entry.get("merchant")
        if not isinstance(merchant, str):
            # ``""`` is a VALUE here ("no merchant on this line"), so this field
            # cannot go through ``json_text``, which refuses the empty string.
            raise EvalError(f"{spot}: 'merchant' must be a string")
        rows.append(
            GoldRow(
                key=json_text(entry, "key", spot),
                day=date.fromisoformat(json_text(entry, "date", spot)),
                kind=json_text(entry, "kind", spot),
                amount_minor=json_integer(entry, "amount_minor", spot),
                original_amount_minor=common.json_optional_integer(
                    entry, "original_amount_minor", spot
                ),
                original_currency=common.json_optional_text(
                    entry, "original_currency", spot
                ),
                merchant=merchant,
            )
        )
    if not rows:
        raise EvalError(f"{where}: no gold rows")
    return rows


async def evaluate_extraction(
    *,
    provider_name: str,
    model: str | None = None,
    prompt_version: str = PROMPT_VERSION,
    mode: str = "replay",
    limit: int | None = None,
    dataset_path: Path = DATASET_PATH,
    replay_dir: Path = REPLAY_DIR,
    api_key: str = "",
) -> ExtractReport:
    """Extract every statement of the dataset and measure it. No files written.

    Writing is the CLI's job (and the recorder's), so the regression test can
    call this in-process and compare two modes without touching the repo.
    """
    validate_run(provider_name, mode, prompt_version, PROMPT_VERSION)
    resolved_model = model or default_model(provider_name)
    config = common.for_provider(production_config(), provider_name)
    statements = load_dataset(dataset_path, limit=limit)
    replay_path = replay_file(replay_dir, provider_name, resolved_model, prompt_version)
    provider = UsageProvider(
        eval_provider(
            provider_name,
            resolved_model,
            mode=mode,
            replay_path=replay_path,
            api_key=api_key,
        )
    )

    outcomes: list[ParsedStatement | None] = []
    failures: dict[str, int] = {}
    for gold in statements:
        try:
            outcomes.append(
                await extract_from_text(
                    gold.lines,
                    provider,
                    config,
                    lambda _lines: True,
                    user_id="evals",
                )
            )
        except StatementExtractionError as exc:
            failures[exc.code] = failures.get(exc.code, 0) + 1
            outcomes.append(None)
        except StatementParseError:
            # The generator's own text should always parse; if it does not, the
            # anchors or the table header moved and the dataset must be re-cut.
            failures["parse_error"] = failures.get("parse_error", 0) + 1
            outcomes.append(None)
    extracted = sum(outcome is not None for outcome in outcomes)
    if mode == "replay" and failures.get("replay_miss"):
        raise common.replay_miss(
            replay_path,
            extracted,
            len(statements),
            "statements",
            f"codes={','.join(sorted(failures))}",
        )
    return _report(
        provider_name=provider_name,
        model=resolved_model,
        prompt_version=prompt_version,
        mode=mode,
        dataset=dataset_path.name,
        statements=statements,
        outcomes=outcomes,
        failures=failures,
        calls=provider.calls,
    )


def _field_hits(
    gold: GoldRow, row: ParsedRow | None, *, currency: str, gold_currency: str
) -> dict[str, bool]:
    """Which of the five fields this row got right. A missing row gets none."""
    if row is None:
        return dict.fromkeys(FIELDS, False)
    return {
        "date": row.txn_date == gold.day and row.booked_date == gold.day,
        "amount": row.amount_minor == gold.amount_minor and row.kind == gold.kind,
        "currency": currency == gold_currency,
        "original_pair": (
            row.original_amount_minor == gold.original_amount_minor
            and row.original_currency == gold.original_currency
        ),
        "merchant": row.merchant == gold.merchant,
    }


def _report(
    *,
    provider_name: str,
    model: str,
    prompt_version: str,
    mode: str,
    dataset: str,
    statements: Sequence[GoldStatement],
    outcomes: Sequence[ParsedStatement | None],
    failures: Mapping[str, int],
    calls: Sequence[Usage],
) -> ExtractReport:
    correct: dict[str, int] = dict.fromkeys(FIELDS, 0)
    rows_gold = 0
    rows_returned = 0
    rows_all_fields = 0
    row_count_exact = 0
    self_check_as_expected = 0
    self_check_passed = 0
    self_check_failed = 0
    for gold, outcome in zip(statements, outcomes, strict=True):
        rows_gold += len(gold.rows)
        rows = () if outcome is None else outcome.rows
        rows_returned += len(rows)
        row_count_exact += int(len(rows) == len(gold.rows))
        for index, gold_row in enumerate(gold.rows):
            # POSITIONAL pairing: ``row_index`` is assigned over the kept rows in
            # FILE order and the gold rows are in that same order, so row i is
            # the reading of gold row i. A statement that returned fewer rows
            # scores the missing ones as wrong rather than shifting the rest.
            row = rows[index] if index < len(rows) else None
            hits = _field_hits(
                gold_row,
                row,
                currency=outcome.currency if outcome is not None else "",
                gold_currency=gold.currency,
            )
            for field, hit in hits.items():
                correct[field] += int(hit)
            rows_all_fields += int(all(hits.values()))
        if outcome is None or outcome.self_check is None:
            continue
        status = outcome.self_check.status
        self_check_passed += int(status == "passed")
        self_check_failed += int(status == "failed")
        self_check_as_expected += int(status == gold.expect_self_check)
    latencies = [usage.latency_ms for usage in calls]
    return ExtractReport(
        provider=provider_name,
        model=model,
        prompt_version=prompt_version,
        mode=mode,
        generated_at=datetime.now(UTC),
        dataset=dataset,
        statements=len(statements),
        extracted=sum(outcome is not None for outcome in outcomes),
        failures=dict(failures),
        rows_gold=rows_gold,
        rows_returned=rows_returned,
        rows_all_fields=rows_all_fields,
        row_count_exact=row_count_exact,
        fields=tuple(
            FieldStat(name=field, correct=correct[field], support=rows_gold)
            for field in FIELDS
        ),
        self_check_as_expected=self_check_as_expected,
        self_check_passed=self_check_passed,
        self_check_failed=self_check_failed,
        calls=len(calls),
        input_tokens=sum(usage.input_tokens for usage in calls),
        output_tokens=sum(usage.output_tokens for usage in calls),
        cost_usd=total_cost(calls),
        latency_p50_ms=percentile(latencies, 0.5),
        latency_p95_ms=percentile(latencies, 0.95),
    )


def _parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Evaluate the Alfa-PDF extraction over the synthetic dataset."
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
        help="first N statements only (a fixture recorded without it still hits:"
        " one statement = its own calls)",
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
            evaluate_extraction(
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
        f"extract-{slug(report.provider)}-{slug(report.model)}-{report.prompt_version}"
    )
    paths = write_report(args.reports_dir, stem, report.to_markdown(), report.to_json())
    # Program OUTPUT (the report itself), not logging.
    print(report.to_markdown())
    for path in paths:
        print(f"written: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
