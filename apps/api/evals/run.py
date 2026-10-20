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

Since ``categorize-v2`` it also runs the LEAKAGE-FREE split and the few-shot
selector (grooming D7). ``--split test`` cuts the dataset deterministically into a
history pool (the examples) and a disjoint test slice (the rows being scored), so
no row can ever be its own example::

    uv run python evals/run.py --provider ollama --model qwen2.5:7b \
        --prompt-version categorize-v2 --split test --mode record

In ``live``/``record`` the history is embedded with the REAL onnx artifact — the
same ``Embedder`` the server indexes with, because the production pool IS the
stored index. In ``record`` the examples chosen per batch are written beside the
fixture (``<stem>.examples.json``) and ``replay`` loads them into a static
selector, which is what lets CI reproduce a real run with no artifact at all.

Honesty rules this file is built around:

* ``--prompt-version`` must be one the build speaks (``PROMPT_VERSIONS``) or the
  run is refused: a report naming a prompt it did not use is worse than no
  report. The report carries BOTH the requested version and the EFFECTIVE one,
  because a v2 run whose batches found no examples really did send v1.
* ``categorize-v2`` without ``--split test`` is refused: with no history slice
  there is no pool, and a "v2" report over v1 requests would be a lie.
* a v2 ``live``/``record`` run with no embedding artifact is refused too — it
  never falls back to the fake embedder, which would make the report a number
  about a hash (``docs/conventions.md``).
* a replay store that cannot answer a row raises :class:`EvalError` — the one
  thing a regression test must never see is a silent 0%.
* a report says which model produced it, in its own first lines: the real-model
  numbers are the ``ollama-*`` reports in ``evals/reports/`` (recorded with
  ``--mode record`` against a local Ollama), and the ``fake-*`` one carries a
  SYNTHETIC banner instead of a quality claim — it measures the pipeline, not a
  model.

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
import json
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, cast

import numpy as np

from budget_api.embeddings import Embedder, EmbedderLoadError
from budget_api.enums import CategoryKind
from budget_api.llm import Usage
from budget_api.services.categorize import (
    PROMPT_VERSION,
    PROMPT_VERSION_V2,
    PROMPT_VERSIONS,
    CategorizeConfig,
    CategorizeResult,
    CategoryOption,
    ExampleSelector,
    Operation,
    categorize,
)
from budget_api.services.categorize_examples import (
    SELECTION_VERSION,
    Example,
    ExamplePool,
    SelectionLimits,
)
from budget_api.services.categorize_pool import PoolExampleSelector
from budget_api.services.tx_text import TextFacts, tx_text
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
    json_objects,
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
    total_cost,
    validate_run,
    write_report,
)
from evals.retrieval import build_embedder

logger = logging.getLogger("evals.run")

#: ``none`` = the whole dataset, exactly the pre-v2 run (and what the committed
#: v1 fixtures were recorded over). ``test`` = the leakage-free slice.
SPLITS = ("none", "test")

#: Every ``TEST_EVERY``-th row of each LABEL goes to the test slice, the rest to
#: the history pool. Stratified so a label never lands entirely on one side, and
#: positional (dataset order) so the split is a function of the committed file
#: alone — no seed, no shuffle, no hash of a text that an anonymizer might change.
TEST_EVERY = 3

DATASET_PATH = DATASET_DIR / "owner-categorize-v1.jsonl"
CATEGORIES_PATH = DATASET_DIR / "categories.json"

#: Re-exported under the names they had before the ``common.py`` lift: this
#: module's public surface did not move, only its implementation.
MODEL_SETTINGS = common.MODEL_SETTINGS
replay_header = common.replay_header

#: The floor ``tests/test_evals_regression.py`` holds the REAL qwen v2 replay to.
#:
#: Calibrated on a LIVE run and a hair (~1 pp) below its OVERALL accuracy on the
#: test split, so the test fails on a mechanical regression — batching, dedupe,
#: validation, fan-out, the example selection — and not on float noise. The run
#: it comes from is named in the test's docstring; raising it is only allowed
#: with a newer report to point at (grooming ruling R3).
#:
#: It replaced the fake-calibrated ``EVALS_MIN_ACCURACY`` (9%), which was a
#: number about a substring matcher: the fake replay test keeps its EQUALITY
#: assertion (replay reproduces an in-process run exactly), which is the part
#: that pins the pipeline's mechanics, and the quality floor is now held against
#: a real model (grooming D7).
#:
#: As recorded: qwen2.5:7b scored 40/63 = 63.5% OVERALL on the test split under
#: ``categorize-v2`` (``reports/ollama-qwen2.5-7b-categorize-v2-test.md``,
#: 2026-10-20), with 64.3% on the unseen subset and an 87.3% ambiguity ceiling.
EVALS_MIN_ACCURACY_V2 = 0.62


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
class SubsetStat:
    """One half of the test slice: rows whose text the history HAS or has not.

    The split is leakage-free by construction (a row is never its own example),
    but a merchant the user filed before legitimately appears again — in the app
    those rows are what the few-shot examples are FOR, and in production most of
    them would never reach the model at all (the merchant map answers them first,
    ``routers/statement_imports._categorize_rows``). So the two subsets answer two
    different questions and are never averaged into one claim: ``seen`` is "does
    it copy the user's own past decision", ``unseen`` is "did it generalise".
    """

    name: str
    rows: int
    correct: int
    unsure: int
    flagged: int

    @property
    def accuracy(self) -> float:
        return ratio(self.correct, self.rows)


@dataclass(frozen=True)
class EvalReport:
    """Everything one run measured. Rendered to markdown and to JSON as is."""

    provider: str
    model: str
    #: The version ASKED for (``--prompt-version``), which names the fixture.
    prompt_version: str
    #: The version that went OUT. v2 degrades to v1 per batch when it has no
    #: examples (D5), so these two can legitimately disagree — and a reader must
    #: see it rather than take a v1 number for a v2 one.
    effective_prompt_version: str
    mode: str
    split: str
    #: Rows in the history pool: the examples came from these and from nothing
    #: else. 0 for ``--split none``.
    history_rows: int
    generated_at: datetime
    dataset: str
    threshold: float
    rows: int
    correct: int
    unsure: int
    flagged: int
    absent: int
    calls: int
    tokens_in: int
    tokens_out: int
    #: Examples per CALL, averaged — the prompt's cost in one number.
    examples_per_call: float
    cost_usd: Decimal | None
    latency_p50_ms: int | None
    latency_p95_ms: int | None
    ambiguity_ceiling: float
    aborted_reason: str | None
    seen: SubsetStat
    unseen: SubsetStat
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
                "> The real-model numbers are in the `ollama-*` reports beside",
                "> this one; nothing here may be quoted as a quality number.",
                "",
            ]
        lines += [
            f"- mode: `{self.mode}`",
            f"- run at: {self.generated_at.isoformat(timespec='seconds')}",
            f"- dataset: `{self.dataset}` ({self.rows} rows scored),"
            " owner-reviewed 2026-10-14",
            f"- split: `{self.split}`"
            + (
                f" — {self.history_rows} history rows (the example pool),"
                f" {self.rows} test rows, disjoint by construction"
                if self.split != "none"
                else " — the whole dataset, no example pool"
            ),
            f"- prompt sent: `{self.effective_prompt_version}`"
            + (
                f" (asked for `{self.prompt_version}`; batches with no examples"
                " are sent as v1 — grooming D5)"
                if self.effective_prompt_version != self.prompt_version
                else ""
            ),
            f"- examples per call: {self.examples_per_call:.1f}",
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
            "## Seen vs unseen",
            "",
            "A test row is **seen** when its `(text.casefold(), kind)` also"
            " occurs in the"
            " history pool — the row few-shot examples exist for (and the row a"
            " merchant map would answer in production). **unseen** is the"
            " generalisation half. Never averaged into one claim.",
            "",
            "| subset | rows | correct | accuracy | unsure | flagged |",
            "| --- | --- | --- | --- | --- | --- |",
        ]
        for stat in (self.unseen, self.seen):
            lines.append(
                f"| {stat.name} | {stat.rows} | {stat.correct} |"
                f" {pct(stat.accuracy)} | {stat.unsure} | {stat.flagged} |"
            )
        lines += [
            "",
            "## Cost and latency",
            "",
            f"- calls: {self.calls}",
            f"- tokens in/out: {self.tokens_in} / {self.tokens_out}",
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
            "effective_prompt_version": self.effective_prompt_version,
            "mode": self.mode,
            "split": self.split,
            "history_rows": self.history_rows,
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
            "seen": _subset_json(self.seen),
            "unseen": _subset_json(self.unseen),
            "calls": self.calls,
            "tokens_in": self.tokens_in,
            "tokens_out": self.tokens_out,
            "examples_per_call": round(self.examples_per_call, 2),
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
    split: str = "none",
    threshold: float | None = None,
    limit: int | None = None,
    dataset_path: Path = DATASET_PATH,
    categories_path: Path = CATEGORIES_PATH,
    replay_dir: Path = REPLAY_DIR,
    api_key: str = "",
) -> EvalReport:
    """Run the pass over the dataset and measure it. Writes no REPORT.

    Writing the report is the CLI's job, so the regression test can call this
    in-process and compare two modes without touching the repo. The two things a
    ``record`` run does write are its fixture (truncated here, then appended to
    by the recording provider) and its examples sidecar beside it — both are the
    recording, not the report.
    """
    validate_run(provider_name, mode, prompt_version, PROMPT_VERSION, PROMPT_VERSIONS)
    if split not in SPLITS:
        raise EvalError(f"unknown split {split!r}, expected one of {SPLITS}")
    if prompt_version == PROMPT_VERSION_V2 and split != "test":
        raise EvalError(
            f"{PROMPT_VERSION_V2} needs --split test: the example pool IS the"
            " dataset's history half, and with no pool every batch would be sent"
            " as a v1 request while the report said v2"
        )
    resolved_model = model or default_model(provider_name)
    config = common.for_provider(
        production_config(threshold, prompt_version), provider_name
    )
    all_rows = load_dataset(dataset_path, limit=limit)
    history, rows = split_dataset(all_rows, split=split)
    categories = load_categories(categories_path)
    gold = _gold(all_rows, categories)

    stem = run_stem(provider_name, resolved_model, prompt_version, split)
    replay_path = replay_file(
        replay_dir, provider_name, resolved_model, prompt_version, _suffix(split)
    )
    provider = eval_provider(
        provider_name,
        resolved_model,
        mode=mode,
        replay_path=replay_path,
        api_key=api_key,
    )
    selector, recorder, static = _selector(
        prompt_version, mode, split, history, gold, replay_dir / f"{stem}.examples.json"
    )
    # LAST, after every refusal above. Truncating the fixture is the one
    # destructive thing a run does to a COMMITTED artifact, so it may not happen
    # until nothing can still say no: the version/split validation, the provider
    # build, the onnx artifact and a non-empty history pool have all passed by
    # here. A refused record run leaves an existing fixture byte-identical.
    if mode == "record":
        start_fixture(replay_path, provider_name)

    outcome = await categorize(
        provider,
        [_operation(row) for row in rows],
        categories,
        config,
        lambda _rows: True,
        user_id="evals",
        examples=selector,
    )
    if static is not None and static.misses:
        raise EvalError(
            f"the examples sidecar {static.path} does not describe this run"
            f" ({static.misses} batch(es) unanswered): it was cut over other"
            " batches or another dataset. Re-record with --mode record"
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
    if recorder is not None:
        recorder.write(
            prompt_version=prompt_version, split=split, history_rows=len(history)
        )
    return _report(
        provider_name=provider_name,
        model=resolved_model,
        prompt_version=prompt_version,
        effective_prompt_version=outcome.prompt_version,
        mode=mode,
        split=split,
        dataset=dataset_path.name,
        config=config,
        rows=rows,
        history=history,
        gold=gold,
        results=outcome.results,
        calls=outcome.calls,
        examples_used=outcome.examples_used,
        aborted_reason=outcome.aborted_reason,
    )


def production_config(
    threshold: float | None = None, prompt_version: str = PROMPT_VERSION
) -> CategorizeConfig:
    """The config the server runs with, read from ``Settings``' FIELD DEFAULTS.

    Field defaults rather than ``Settings()``: constructing Settings would read
    the environment and the local ``.env``, so the batch size (and with it the
    exact request a replay fixture is keyed by) would depend on whose machine the
    regression test runs on. The defaults ARE the production values.

    ``prompt_version`` is the ONE field the CLI overrides: measuring the old
    prompt against the new one on the same slice is the entire point of the flag.
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
        prompt_version=prompt_version,
    )


def selection_limits() -> SelectionLimits:
    """The selector's knobs, from the same FIELD DEFAULTS as everything else."""
    return SelectionLimits(
        per_operation=setting_int("categorize_examples_per_operation"),
        max_examples=setting_int("categorize_examples_max"),
        max_chars=setting_int("categorize_examples_max_chars"),
    )


def run_stem(provider_name: str, model: str, prompt_version: str, split: str) -> str:
    """``<provider>-<model>-<prompt>[-test]`` — fixture, sidecar and report."""
    return f"{slug(provider_name)}-{slug(model)}-{prompt_version}{_suffix(split)}"


def _suffix(split: str) -> str:
    return "" if split == "none" else f"-{split}"


def split_dataset(
    rows: Sequence[DatasetRow], *, split: str = "none"
) -> tuple[tuple[DatasetRow, ...], tuple[DatasetRow, ...]]:
    """``(history, test)`` — disjoint by construction (grooming D7).

    Stratified per LABEL and positional: within each label, in dataset order,
    every ``TEST_EVERY``-th row goes to the test slice. So every label with at
    least ``TEST_EVERY`` rows is represented on both sides, the history keeps the
    2:1 majority of each label, and the whole thing is a pure function of the
    committed file — re-running it on another machine cannot move one row.

    A test row is NEVER in the history, which is what makes the few-shot numbers
    honest: no row can be shown its own answer.
    """
    if split == "none":
        return (), tuple(rows)
    seen: dict[str, int] = {}
    history: list[DatasetRow] = []
    test: list[DatasetRow] = []
    for row in rows:
        index = seen.get(row.label, 0)
        seen[row.label] = index + 1
        (test if index % TEST_EVERY == TEST_EVERY - 1 else history).append(row)
    return tuple(history), tuple(test)


class RecordingSelector:
    """A real selector that remembers what it chose, per batch, for the sidecar.

    The wrapper exists so ``replay`` can reproduce a recorded run WITHOUT the
    embedding artifact (grooming D7): the fixture is keyed by the whole request,
    the request contains the examples, so the examples have to be replayable too.
    Batches are addressed by their operation keys — in the evals those are dataset
    row ids, which makes the sidecar readable and makes a re-cut dataset or a
    changed batch size a loud miss rather than a different number.
    """

    def __init__(self, inner: ExampleSelector, path: Path, limits: SelectionLimits):
        self._inner = inner
        self._limits = limits
        self.path = path
        self.chosen: list[tuple[tuple[str, ...], tuple[Example, ...]]] = []

    async def select(
        self, operations: Sequence[Operation], options: Sequence[CategoryOption]
    ) -> Sequence[Example]:
        picked = tuple(await self._inner.select(operations, options))
        self.chosen.append((tuple(operation.key for operation in operations), picked))
        return picked

    def write(self, *, prompt_version: str, split: str, history_rows: int) -> None:
        """One JSON file beside the fixture. Overwritten, like the fixture is."""
        body = {
            # The pin a replay checks: a sidecar cut by a DIFFERENT selection
            # algorithm or under different limits describes a run this build
            # cannot reproduce, and a silent mismatch would publish a number
            # about a selection nobody can see.
            "selection_version": SELECTION_VERSION,
            "limits": {
                "per_operation": self._limits.per_operation,
                "max_examples": self._limits.max_examples,
                "max_chars": self._limits.max_chars,
            },
            "prompt_version": prompt_version,
            "split": split,
            "history_rows": history_rows,
            "note": (
                "the few-shot examples chosen per batch by"
                " services/categorize_examples.select over the history half of"
                " the split; replay loads them so CI needs no embedding artifact"
            ),
            "batches": [
                {
                    "operations": list(keys),
                    "examples": [
                        {"text": example.text, "category_id": str(example.category_id)}
                        for example in picked
                    ],
                }
                for keys, picked in self.chosen
            ],
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps(body, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        logger.info(
            "recorded %d batches of examples into %s", len(self.chosen), self.path
        )


class StaticSelector:
    """The recorded selection, replayed. No embedder, no artifact, no network.

    A batch the sidecar does not describe is COUNTED, not raised: ``categorize``
    degrades a failing selector to the v1 request on purpose (it may never fail
    an upload), so an exception here would come back as a confusing replay miss
    two layers up. ``evaluate`` reads the counter and refuses the run by name.
    """

    def __init__(
        self, batches: Mapping[tuple[str, ...], tuple[Example, ...]], path: Path
    ):
        self._batches = batches
        self.path = path
        self.misses = 0

    async def select(
        self, operations: Sequence[Operation], options: Sequence[CategoryOption]
    ) -> Sequence[Example]:
        picked = self._batches.get(tuple(operation.key for operation in operations))
        if picked is None:
            self.misses += 1
            return ()
        return picked


def _selector(
    prompt_version: str,
    mode: str,
    split: str,
    history: Sequence[DatasetRow],
    gold: Mapping[str, CategoryOption],
    sidecar: Path,
) -> tuple[ExampleSelector | None, RecordingSelector | None, StaticSelector | None]:
    """The v2 example source for this mode, or ``None`` for a v1 run."""
    if prompt_version != PROMPT_VERSION_V2:
        return None, None, None
    limits = selection_limits()
    if mode == "replay":
        batches = load_examples(
            sidecar,
            limits,
            prompt_version=prompt_version,
            split=split,
            history_rows=len(history),
        )
        static = StaticSelector(batches, sidecar)
        return static, None, static
    embedder = history_embedder()
    pool = history_pool(embedder, history, gold)
    if pool.size == 0:
        raise EvalError(
            f"{PROMPT_VERSION_V2} needs a history pool and this run has none"
            " (an empty history half — did --limit cut it away?)"
        )
    live = PoolExampleSelector(pool, embedder, limits)
    if mode != "record":
        return live, None, None
    recorder = RecordingSelector(live, sidecar, limits)
    return recorder, recorder, None


def history_embedder() -> Embedder:
    """The REAL onnx artifact, loaded — never the fake one for a real report.

    The production pool is the stored index, and that index is produced by this
    exact artifact (``embeddings/manifest.py`` verifies its sha256 first). A
    hashed bag of words would rank examples by shared literal words and the
    report would be a number about a hash, which ``docs/conventions.md`` forbids
    for anything quotable. So a missing artifact REFUSES the run.
    """
    embedder = build_embedder("onnx")
    try:
        embedder.load()
    except EmbedderLoadError as exc:
        raise EvalError(
            f"the embedding artifact is not usable ({exc}) — a v2 live/record run"
            " needs it, and falling back to the fake embedder would make this"
            " report a number about a hash. Fetch it first:"
            " uv run python -I scripts/fetch_model.py --manifest model_manifest.json"
            " --dest models/multilingual-e5-small"
        ) from exc
    return embedder


def history_pool(
    embedder: Embedder,
    history: Sequence[DatasetRow],
    gold: Mapping[str, CategoryOption],
) -> ExamplePool:
    """The history half as the app's pool: PASSAGE vectors of ``tx_text`` docs.

    Mirrors what the server has stored (grooming D7): a pool vector is the
    canonical document of a CATEGORIZED transaction, so the facts fed here are
    (merchant = the row's text, category = its label, kind), with the note, the
    country and the account absent as they are in the anonymized dataset. The
    example TEXT shown to the model stays the bare row text — the same shape a
    statement row has.
    """
    passages = [
        tx_text(
            TextFacts(
                merchant=row.text,
                note=None,
                category_name=row.label,
                kind=row.kind,
                country=None,
                account_name=None,
            )
        )
        for row in history
    ]
    if not passages:
        return ExamplePool(
            texts=(), category_ids=(), matrix=np.zeros((0, embedder.dim), np.float32)
        )
    # In ``embeddings_batch_size`` chunks, exactly as the sweep embeds.
    size = setting_int("embeddings_batch_size")
    chunks = [
        embedder.embed(passages[start : start + size], kind="passage")
        for start in range(0, len(passages), size)
    ]
    return ExamplePool(
        texts=tuple(row.text for row in history),
        category_ids=tuple(gold[row.id].id for row in history),
        matrix=np.vstack(chunks).astype(np.float32),
    )


def load_examples(
    path: Path,
    limits: SelectionLimits,
    *,
    prompt_version: str,
    split: str,
    history_rows: int,
) -> dict[tuple[str, ...], tuple[Example, ...]]:
    """Read the sidecar, refusing one this build or this RUN would not produce.

    Two refusals, both on the header. The selection pin (``selection_version``
    plus the three limits) is about the CODE: a sidecar cut by another algorithm
    describes a selection this build does not make. The run pin
    (``prompt_version``, ``split``, ``history_rows``) is about the ARGUMENTS: a
    sidecar recorded over another slice can still answer every batch — the keys
    are dataset row ids — and would then replay stale examples under a
    mislabelled seen/unseen split.
    """
    if not path.exists():
        raise EvalError(
            f"no examples sidecar at {path} — a {PROMPT_VERSION_V2} replay needs"
            " the selection its fixture was recorded with: re-record with"
            " --mode record"
        )
    body = json_object(path.read_text(encoding="utf-8"), str(path))
    recorded_version = json_text(body, "selection_version", str(path))
    recorded = body.get("limits")
    expected = {
        "per_operation": limits.per_operation,
        "max_examples": limits.max_examples,
        "max_chars": limits.max_chars,
    }
    if recorded_version != SELECTION_VERSION or recorded != expected:
        raise EvalError(
            f"{path} was cut by selection {recorded_version!r} under {recorded}"
            f" — this build selects {SELECTION_VERSION!r} under {expected}."
            " Re-record with --mode record rather than report a number about a"
            " selection this code does not make"
        )
    recorded_run = {
        "prompt_version": json_text(body, "prompt_version", str(path)),
        "split": json_text(body, "split", str(path)),
        "history_rows": json_integer(body, "history_rows", str(path)),
    }
    expected_run = {
        "prompt_version": prompt_version,
        "split": split,
        "history_rows": history_rows,
    }
    if recorded_run != expected_run:
        raise EvalError(
            f"{path} was recorded for {recorded_run} — this run is"
            f" {expected_run}. Re-record with --mode record rather than replay"
            " one slice's examples against another's rows"
        )
    batches: dict[tuple[str, ...], tuple[Example, ...]] = {}
    for index, batch in enumerate(json_objects(body, "batches", str(path)), 1):
        where = f"{path} batch {index}"
        keys = tuple(common.json_strings(batch, "operations", where))
        batches[keys] = tuple(
            Example(
                text=json_text(entry, "text", where),
                category_id=json_uuid(entry, "category_id", where),
            )
            for entry in json_objects(batch, "examples", where)
        )
    return batches


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
    effective_prompt_version: str,
    mode: str,
    split: str,
    dataset: str,
    config: CategorizeConfig,
    rows: Sequence[DatasetRow],
    history: Sequence[DatasetRow],
    gold: Mapping[str, CategoryOption],
    results: Mapping[str, CategorizeResult],
    calls: Sequence[Usage],
    examples_used: int,
    aborted_reason: str | None,
) -> EvalReport:
    correct = 0
    unsure = 0
    flagged = 0
    absent = 0
    per_label: dict[str, LabelStat] = {}
    per_kind: dict[str, LabelStat] = {}
    known = {(row.text.casefold(), row.kind) for row in history}
    subsets: dict[str, list[DatasetRow]] = {"seen": [], "unseen": []}
    for row in rows:
        result = results.get(row.id)
        hit = result is not None and result.category_id == gold[row.id].id
        correct += int(hit)
        if result is None:
            absent += 1
        else:
            unsure += int(result.category_id is None)
            flagged += int(result.needs_review)
        is_seen = (row.text.casefold(), row.kind) in known
        subsets["seen" if is_seen else "unseen"].append(row)
        per_label[row.label] = _bump(per_label.get(row.label), row.label, row.kind, hit)
        # The per-kind rows reuse LabelStat with the kind in BOTH fields: one
        # renderer, one JSON shape, and "expense" is the group's name here.
        per_kind[row.kind] = _bump(per_kind.get(row.kind), row.kind, row.kind, hit)
    latencies = [usage.latency_ms for usage in calls]
    return EvalReport(
        provider=provider_name,
        model=model,
        prompt_version=prompt_version,
        effective_prompt_version=effective_prompt_version,
        mode=mode,
        split=split,
        history_rows=len(history),
        generated_at=datetime.now(UTC),
        dataset=dataset,
        threshold=config.threshold,
        rows=len(rows),
        correct=correct,
        unsure=unsure,
        flagged=flagged,
        absent=absent,
        calls=len(calls),
        tokens_in=sum(usage.input_tokens for usage in calls),
        tokens_out=sum(usage.output_tokens for usage in calls),
        examples_per_call=ratio(examples_used, len(calls)),
        cost_usd=total_cost(calls),
        latency_p50_ms=percentile(latencies, 0.5),
        latency_p95_ms=percentile(latencies, 0.95),
        ambiguity_ceiling=ambiguity_ceiling(rows),
        aborted_reason=aborted_reason,
        seen=_subset("seen", subsets["seen"], gold, results),
        unseen=_subset("unseen", subsets["unseen"], gold, results),
        by_kind=tuple(sorted(per_kind.values(), key=lambda stat: stat.name)),
        by_label=tuple(
            sorted(per_label.values(), key=lambda stat: (-stat.support, stat.name))
        ),
    )


def _subset(
    name: str,
    rows: Sequence[DatasetRow],
    gold: Mapping[str, CategoryOption],
    results: Mapping[str, CategorizeResult],
) -> SubsetStat:
    """One subset's four numbers, scored the same way the whole slice is."""
    answers = [(row, results.get(row.id)) for row in rows]
    return SubsetStat(
        name=name,
        rows=len(rows),
        correct=sum(
            1
            for row, result in answers
            if result is not None and result.category_id == gold[row.id].id
        ),
        unsure=sum(
            1
            for _, result in answers
            if result is not None and result.category_id is None
        ),
        flagged=sum(
            1 for _, result in answers if result is not None and result.needs_review
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


def _subset_json(stat: SubsetStat) -> dict[str, Any]:
    return {
        "rows": stat.rows,
        "correct": stat.correct,
        "accuracy": round(stat.accuracy, 4),
        "unsure": stat.unsure,
        "flagged": stat.flagged,
    }


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
        choices=PROMPT_VERSIONS,
        default=PROMPT_VERSION,
        help="one of the versions this build speaks; it names the fixture too",
    )
    parser.add_argument("--mode", choices=MODES, default="replay")
    parser.add_argument(
        "--split",
        choices=SPLITS,
        default="none",
        help=(
            "'test' scores the leakage-free slice and uses the rest as the"
            " few-shot history pool (required by categorize-v2); 'none' is the"
            " whole dataset"
        ),
    )
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
    # The fixture is truncated inside ``evaluate``, not here: every refusal it
    # can raise has to run BEFORE a committed recording is wiped.
    try:
        report = asyncio.run(
            evaluate(
                provider_name=provider_name,
                model=model,
                prompt_version=args.prompt_version,
                mode=args.mode,
                split=args.split,
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
    stem = run_stem(report.provider, report.model, report.prompt_version, report.split)
    paths = write_report(args.reports_dir, stem, report.to_markdown(), report.to_json())
    # Program OUTPUT (the report itself), not logging.
    print(report.to_markdown())
    for path in paths:
        print(f"written: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
