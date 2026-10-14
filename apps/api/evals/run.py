"""Score the categorize pass over the committed dataset: accuracy, cost, latency.

From ``apps/api``::

    uv run python evals/run.py --provider fake --mode live
    uv run python evals/run.py --provider fake --mode record     # (re)cut the fixture
    uv run python evals/run.py --provider fake --mode replay     # what CI runs
    ANTHROPIC_API_KEY=… uv run python evals/run.py --provider anthropic --mode record

The three modes are the whole point of the file: ``live`` spends money (or a local
Ollama), ``record`` spends it ONCE and writes every answer to
``evals/replay/<provider>-<model>-<prompt-version>.jsonl``, and ``replay`` reads
that store back with no network at all — which is how
``tests/test_evals_regression.py`` can assert an accuracy number in CI without a
key and without a bill.

What this module does NOT do: nothing here reimplements the pass. It builds the
same provider the app builds (``llm.registry.build_provider``) and calls the same
:func:`budget_api.services.categorize.categorize` with the production
``CategorizeConfig`` defaults, so a number in a report is a number about the
shipped code. The only difference is the quota callback, which always says yes.

Honesty rules this file is built around:

* ``--prompt-version`` must equal the code's ``PROMPT_VERSION`` or the run is
  refused: a report naming a prompt it did not use is worse than no report.
* a replay store that cannot answer a row raises :class:`EvalError` — the one
  thing a regression test must never see is a silent 0%.
* no number in ``evals/reports/`` comes from a real model until someone runs
  ``--mode live``/``record`` with a key; the committed report is the fake's, and
  it says so in its own first lines.

The machinery every runner shares (the provider, the replay store, percentiles,
the report writer) lives in :mod:`evals.common`; this file is the categorize
runner and nothing else.
"""

import logging
import sys
from pathlib import Path

if __package__ in {None, ""}:
    # ``uv run python evals/run.py`` puts THIS directory on ``sys.path``, not the
    # project root, so ``evals.common`` would not be importable. The documented
    # command is the script path (README, this docstring), and pytest imports the
    # same file as ``evals.run`` — both have to work, so the script arm fixes the
    # path before the package imports below.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import argparse
import asyncio
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, cast

from budget_api.enums import CategoryKind
from budget_api.llm import Usage
from budget_api.services.categorize import (
    PROMPT_VERSION,
    CategorizeConfig,
    CategorizeResult,
    CategoryOption,
    Operation,
    categorize,
)
from evals import common
from evals.common import (
    DATASET_DIR,
    MODES,
    PROVIDERS,
    REPLAY_DIR,
    REPORTS_DIR,
    EvalError,
    cost_text,
    default_model,
    eval_provider,
    json_integer,
    json_object,
    json_text,
    json_uuid,
    ms_text,
    pct,
    percentile,
    replay_file,
    setting_float,
    setting_int,
    slug,
    start_fixture,
    total_cost,
    validate_run,
    write_report,
)

logger = logging.getLogger("evals.run")

DATASET_PATH = DATASET_DIR / "owner-categorize-v1.jsonl"
CATEGORIES_PATH = DATASET_DIR / "categories.json"

#: Re-exported under the names they had before the ``common.py`` lift: this
#: module's public surface did not move, only its implementation.
MODEL_SETTINGS = common.MODEL_SETTINGS
replay_header = common.replay_header

#: The floor ``tests/test_evals_regression.py`` holds the replay run to.
#:
#: PLACEHOLDER, calibrated on the SYNTHETIC fixture: the committed replay store
#: is recorded from ``FakeProvider("fake")``, a substring matcher that answers a
#: category only when its NAME appears in the operation text. Whatever that
#: scores on the owner's dataset is what this number tracks (a hair below it, so
#: the test fails on a real mechanical regression — batching, dedupe, validation,
#: fan-out — and not on float noise). It is NOT a quality bar for a model and
#: must be re-set from the first real ``--mode live`` run. Nothing was tuned to
#: make it look good: raising it is only allowed with a report to point at
#: (grooming ruling R3).
#:
#: As recorded: the fake scores 21/215 = 9.8% on ``owner-categorize-v1`` (it was
#: 24/221 before the owner's review dropped the six pay/tax rows, three of which
#: it matched by name) — it
#: matches a category only where the owner's own note happens to repeat the
#: category's name ("Сигареты", "Продукты"), and answers "none" to every real
#: merchant. A substring matcher is supposed to look like this.
EVALS_MIN_ACCURACY = 0.09


@dataclass(frozen=True)
class DatasetRow:
    """One labelled operation of the committed dataset."""

    id: str
    kind: str
    amount_minor: int
    currency: str
    country: str | None
    text: str
    label: str


@dataclass(frozen=True)
class LabelStat:
    """Per-label accuracy. ``support`` is how many dataset rows carry the label."""

    name: str
    kind: str
    support: int
    correct: int

    @property
    def accuracy(self) -> float:
        return self.correct / self.support if self.support else 0.0


@dataclass(frozen=True)
class EvalReport:
    """Everything one run measured. Rendered to markdown and to JSON as is."""

    provider: str
    model: str
    prompt_version: str
    mode: str
    generated_at: datetime
    dataset: str
    threshold: float
    rows: int
    correct: int
    unsure: int
    flagged: int
    absent: int
    calls: int
    cost_usd: Decimal | None
    latency_p50_ms: int | None
    latency_p95_ms: int | None
    ambiguity_ceiling: float
    aborted_reason: str | None
    by_kind: tuple[LabelStat, ...]
    by_label: tuple[LabelStat, ...]

    @property
    def accuracy(self) -> float:
        """Correct / ALL dataset rows. Unsure and unanswered rows count as wrong.

        Deliberately not "correct / answered": a pass that answers "none" to
        everything is useless, and hiding that behind a high accuracy on the few
        rows it did answer is exactly the trick this file exists to prevent. The
        unsure and absent rates below say which kind of wrong it was.
        """
        return self.correct / self.rows if self.rows else 0.0

    @property
    def synthetic(self) -> bool:
        return self.provider == "fake"

    def to_markdown(self) -> str:
        lines = [
            f"# Evals — {self.provider}/{self.model} ({self.prompt_version})",
            "",
        ]
        if self.synthetic:
            lines += [
                "> **SYNTHETIC RUN — not a model quality number.** The `fake`",
                "> provider is a substring matcher in `llm/fake.py`; this report",
                "> exists to show the pipeline and to pin its mechanics in CI.",
                "> No real-model numbers exist until someone runs `--mode live`.",
                "",
            ]
        lines += [
            f"- mode: `{self.mode}`",
            f"- run at: {self.generated_at.isoformat(timespec='seconds')}",
            f"- dataset: `{self.dataset}` ({self.rows} rows), pending owner review",
            f"- confidence threshold: {self.threshold}",
            "",
            "## Accuracy",
            "",
            f"- **accuracy: {pct(self.accuracy)}** ({self.correct}/{self.rows})",
            f"- ambiguity ceiling: {pct(self.ambiguity_ceiling)}"
            " — rows sharing a (text, kind) under different labels make the rest"
            " unreachable for ANY model",
            f"- unsure rate: {pct(self.unsure / self.rows if self.rows else 0)}"
            f' ({self.unsure}) — answered "none" or unusable; counted as wrong',
            f"- flagged for review:"
            f" {pct(self.flagged / self.rows if self.rows else 0)}"
            f" ({self.flagged}) — below threshold or unsure",
            f"- unanswered rows: {self.absent}"
            + (f" — aborted: `{self.aborted_reason}`" if self.aborted_reason else ""),
            "",
            "## Cost and latency",
            "",
            f"- calls: {self.calls}",
            f"- cost: {cost_text(self.cost_usd)}",
            f"- latency p50/p95: {ms_text(self.latency_p50_ms)}"
            f" / {ms_text(self.latency_p95_ms)}",
            "",
            "## By kind",
            "",
            "| kind | rows | correct | accuracy |",
            "| --- | --- | --- | --- |",
        ]
        for stat in self.by_kind:
            suffix = (
                " (degenerate: a single label in this kind)"
                if stat.name == "income"
                else ""
            )
            lines.append(
                f"| {stat.name}{suffix} | {stat.support} | {stat.correct} |"
                f" {pct(stat.accuracy)} |"
            )
        lines += [
            "",
            "## By label",
            "",
            "| label | kind | support | correct | accuracy |",
            "| --- | --- | --- | --- | --- |",
        ]
        for stat in self.by_label:
            lines.append(
                f"| {stat.name} | {stat.kind} | {stat.support} | {stat.correct} |"
                f" {pct(stat.accuracy)} |"
            )
        lines.append("")
        return "\n".join(lines)

    def to_json(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "model": self.model,
            "prompt_version": self.prompt_version,
            "mode": self.mode,
            "synthetic": self.synthetic,
            "generated_at": self.generated_at.isoformat(timespec="seconds"),
            "dataset": self.dataset,
            "owner_reviewed": "2026-10-14",
            "threshold": self.threshold,
            "rows": self.rows,
            "accuracy": round(self.accuracy, 4),
            "correct": self.correct,
            "unsure": self.unsure,
            "flagged": self.flagged,
            "absent": self.absent,
            "aborted_reason": self.aborted_reason,
            "ambiguity_ceiling": round(self.ambiguity_ceiling, 4),
            "calls": self.calls,
            "cost_usd": None if self.cost_usd is None else str(self.cost_usd),
            "latency_p50_ms": self.latency_p50_ms,
            "latency_p95_ms": self.latency_p95_ms,
            "by_kind": [_stat_json(stat) for stat in self.by_kind],
            "by_label": [_stat_json(stat) for stat in self.by_label],
        }


async def evaluate(
    *,
    provider_name: str,
    model: str | None = None,
    prompt_version: str = PROMPT_VERSION,
    mode: str = "replay",
    threshold: float | None = None,
    limit: int | None = None,
    dataset_path: Path = DATASET_PATH,
    categories_path: Path = CATEGORIES_PATH,
    replay_dir: Path = REPLAY_DIR,
    api_key: str = "",
) -> EvalReport:
    """Run the pass over the dataset and measure it. No files are written here.

    Writing is the CLI's job (and the recorder's), so the regression test can
    call this in-process and compare two modes without touching the repo.
    """
    validate_run(provider_name, mode, prompt_version, PROMPT_VERSION)
    resolved_model = model or default_model(provider_name)
    config = production_config(threshold)
    rows = load_dataset(dataset_path, limit=limit)
    categories = load_categories(categories_path)
    gold = _gold(rows, categories)

    replay_path = replay_file(replay_dir, provider_name, resolved_model, prompt_version)
    provider = eval_provider(
        provider_name,
        resolved_model,
        mode=mode,
        replay_path=replay_path,
        api_key=api_key,
    )

    outcome = await categorize(
        provider,
        [_operation(row) for row in rows],
        categories,
        config,
        lambda _rows: True,
        user_id="evals",
    )
    missing = [row.id for row in rows if row.id not in outcome.results]
    if mode == "replay" and missing:
        raise common.replay_miss(
            replay_path,
            len(rows) - len(missing),
            len(rows),
            "rows",
            f"aborted_reason={outcome.aborted_reason}",
        )
    return _report(
        provider_name=provider_name,
        model=resolved_model,
        prompt_version=prompt_version,
        mode=mode,
        dataset=dataset_path.name,
        config=config,
        rows=rows,
        gold=gold,
        results=outcome.results,
        calls=outcome.calls,
        aborted_reason=outcome.aborted_reason,
    )


def production_config(threshold: float | None = None) -> CategorizeConfig:
    """The config the server runs with, read from ``Settings``' FIELD DEFAULTS.

    Field defaults rather than ``Settings()``: constructing Settings would read
    the environment and the local ``.env``, so the batch size (and with it the
    exact request a replay fixture is keyed by) would depend on whose machine the
    regression test runs on. The defaults ARE the production values.
    """
    return CategorizeConfig(
        threshold=(
            threshold
            if threshold is not None
            else setting_float("categorize_confidence_threshold")
        ),
        batch_size=setting_int("categorize_batch_size"),
        concurrency=setting_int("categorize_concurrency"),
        time_budget_seconds=setting_float("categorize_time_budget_seconds"),
        max_rows=setting_int("categorize_max_rows_per_import"),
    )


def load_dataset(path: Path, *, limit: int | None = None) -> tuple[DatasetRow, ...]:
    """Read the JSONL dataset. A malformed line is an error, never a skip."""
    rows: list[DatasetRow] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        body = json_object(line, f"{path}:{number}")
        country: Any = body.get("country")
        rows.append(
            DatasetRow(
                id=json_text(body, "id", f"{path}:{number}"),
                kind=json_text(body, "kind", f"{path}:{number}"),
                amount_minor=json_integer(body, "amount_minor", f"{path}:{number}"),
                currency=json_text(body, "currency", f"{path}:{number}"),
                country=country if isinstance(country, str) and country else None,
                text=json_text(body, "text", f"{path}:{number}"),
                label=json_text(body, "label", f"{path}:{number}"),
            )
        )
        if limit is not None and len(rows) >= limit:
            break
    if not rows:
        raise EvalError(f"dataset {path} has no rows")
    return tuple(rows)


def load_categories(path: Path) -> tuple[CategoryOption, ...]:
    """Read ``categories.json`` into the options the pass offers the model."""
    body = json_object(path.read_text(encoding="utf-8"), str(path))
    labels: Any = body.get("labels")
    if not isinstance(labels, list):
        raise EvalError(f"{path}: no 'labels' array")
    options: list[CategoryOption] = []
    for index, label in enumerate(cast(list[Any], labels), 1):
        if not isinstance(label, dict):
            raise EvalError(f"{path}: label {index} is not an object")
        entry = cast(dict[str, Any], label)
        where = f"{path} label {index}"
        options.append(
            CategoryOption(
                id=json_uuid(entry, "id", where),
                name=json_text(entry, "name", where),
                kind=_kind(json_text(entry, "kind", where), where),
            )
        )
    if not options:
        raise EvalError(f"{path}: empty label set")
    return tuple(options)


def _operation(row: DatasetRow) -> Operation:
    return Operation(
        key=row.id,
        text=row.text,
        amount_minor=row.amount_minor,
        currency=row.currency,
        country=row.country,
        kind=_kind(row.kind, f"dataset row {row.id}"),
    )


def _gold(
    rows: Sequence[DatasetRow], categories: Sequence[CategoryOption]
) -> dict[str, CategoryOption]:
    """Dataset row id → the category its label names. Integrity check included."""
    by_name = {option.name: option for option in categories}
    gold: dict[str, CategoryOption] = {}
    for row in rows:
        option = by_name.get(row.label)
        if option is None:
            raise EvalError(
                f"dataset row {row.id} is labelled {row.label!r}, which is not in"
                " categories.json — regenerate both with evals/anonymize.py"
            )
        if option.kind.value != row.kind:
            raise EvalError(
                f"dataset row {row.id} is {row.kind} but its label {row.label!r}"
                f" is {option.kind.value}"
            )
        gold[row.id] = option
    return gold


def _report(
    *,
    provider_name: str,
    model: str,
    prompt_version: str,
    mode: str,
    dataset: str,
    config: CategorizeConfig,
    rows: Sequence[DatasetRow],
    gold: Mapping[str, CategoryOption],
    results: Mapping[str, CategorizeResult],
    calls: Sequence[Usage],
    aborted_reason: str | None,
) -> EvalReport:
    correct = 0
    unsure = 0
    flagged = 0
    absent = 0
    per_label: dict[str, LabelStat] = {}
    per_kind: dict[str, LabelStat] = {}
    for row in rows:
        result = results.get(row.id)
        hit = result is not None and result.category_id == gold[row.id].id
        correct += int(hit)
        if result is None:
            absent += 1
        else:
            unsure += int(result.category_id is None)
            flagged += int(result.needs_review)
        per_label[row.label] = _bump(per_label.get(row.label), row.label, row.kind, hit)
        # The per-kind rows reuse LabelStat with the kind in BOTH fields: one
        # renderer, one JSON shape, and "expense" is the group's name here.
        per_kind[row.kind] = _bump(per_kind.get(row.kind), row.kind, row.kind, hit)
    latencies = [usage.latency_ms for usage in calls]
    return EvalReport(
        provider=provider_name,
        model=model,
        prompt_version=prompt_version,
        mode=mode,
        generated_at=datetime.now(UTC),
        dataset=dataset,
        threshold=config.threshold,
        rows=len(rows),
        correct=correct,
        unsure=unsure,
        flagged=flagged,
        absent=absent,
        calls=len(calls),
        cost_usd=total_cost(calls),
        latency_p50_ms=percentile(latencies, 0.5),
        latency_p95_ms=percentile(latencies, 0.95),
        ambiguity_ceiling=ambiguity_ceiling(rows),
        aborted_reason=aborted_reason,
        by_kind=tuple(sorted(per_kind.values(), key=lambda stat: stat.name)),
        by_label=tuple(
            sorted(per_label.values(), key=lambda stat: (-stat.support, stat.name))
        ),
    )


def ambiguity_ceiling(rows: Sequence[DatasetRow]) -> float:
    """The best accuracy ANY model could reach on this dataset.

    Rows sharing ``(text.casefold(), kind)`` are the same question; when they
    carry different labels, the majority label is the most that can be right. The
    distinguishing detail lives in the owner's note, which the anonymizer drops —
    so this is the honest ceiling of a merchant-only dataset, and the number to
    read accuracy against (grooming ruling R5).
    """
    groups: dict[tuple[str, str], dict[str, int]] = {}
    for row in rows:
        counts = groups.setdefault((row.text.casefold(), row.kind), {})
        counts[row.label] = counts.get(row.label, 0) + 1
    if not rows:
        return 0.0
    return sum(max(counts.values()) for counts in groups.values()) / len(rows)


def _bump(stat: LabelStat | None, name: str, kind: str, hit: bool) -> LabelStat:
    if stat is None:
        return LabelStat(name=name, kind=kind, support=1, correct=int(hit))
    return LabelStat(
        name=stat.name,
        kind=stat.kind,
        support=stat.support + 1,
        correct=stat.correct + int(hit),
    )


def _stat_json(stat: LabelStat) -> dict[str, Any]:
    return {
        "name": stat.name,
        "kind": stat.kind,
        "support": stat.support,
        "correct": stat.correct,
        "accuracy": round(stat.accuracy, 4),
    }


def _kind(value: str, where: str) -> CategoryKind:
    try:
        return CategoryKind(value)
    except ValueError as exc:
        raise EvalError(f"{where}: {value!r} is not a category kind") from exc


def _parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Evaluate the LLM categorize pass over the owner's dataset."
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
        "--threshold",
        type=float,
        default=None,
        help="confidence below which a row is flagged (default: the app's)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help=(
            "first N rows only; it changes the batches, so a fixture recorded"
            " without it will MISS in replay mode"
        ),
    )
    parser.add_argument("--dataset", type=Path, default=DATASET_PATH)
    parser.add_argument("--replay-dir", type=Path, default=REPLAY_DIR)
    parser.add_argument("--reports-dir", type=Path, default=REPORTS_DIR)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    dataset: Path = args.dataset
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
            evaluate(
                provider_name=provider_name,
                model=model,
                prompt_version=args.prompt_version,
                mode=args.mode,
                threshold=args.threshold,
                limit=args.limit,
                dataset_path=dataset,
                categories_path=dataset.parent / "categories.json",
                replay_dir=replay_dir,
                api_key=os.environ.get("ANTHROPIC_API_KEY", ""),
            )
        )
    except EvalError as exc:
        print(f"evals: {exc}", file=sys.stderr)
        return 2
    stem = f"{slug(report.provider)}-{slug(report.model)}-{report.prompt_version}"
    paths = write_report(args.reports_dir, stem, report.to_markdown(), report.to_json())
    # Program OUTPUT (the report itself), not logging.
    print(report.to_markdown())
    for path in paths:
        print(f"written: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
