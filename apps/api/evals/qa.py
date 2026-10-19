"""Score the cited Q&A: groundedness, citation recall, cost, latency (rag D-E3).

From ``apps/api``::

    uv run python evals/qa.py --provider fake --mode replay   # what CI runs
    uv run python evals/qa.py --provider fake --mode record   # (re)cut the fixture
    ANTHROPIC_API_KEY=… uv run python evals/qa.py --provider anthropic --mode record

Retrieval happens IN MEMORY here (the fake embedder over the committed corpus,
`evals/retrieval.py`'s own functions), because this runner measures the MODEL and
not the ranking: the question it answers is "how often did the server have to
correct the model's citations", and the only thing the retrieval has to do for
that is hand over a plausible, reproducible set of operations. Everything after
that is the app's own code: ``services/advisor_qa.answer_question`` builds the
prompt, calls ``structured()`` and verifies what comes back, exactly as
``routers/advisor_qa.py`` does, with no database and no FastAPI in sight.

The two numbers:

* **groundedness** = ``1 - dropped / citations_before_drop`` — the share of the
  model's OWN references that survived the verifier. The post-verifier list is
  a subset of the retrieved set by construction (``_verify``), so the number
  worth reporting is how often that construction had to intervene. With the fake
  provider it is 1.0 BY CONSTRUCTION (the fake cites only keys it was handed),
  which makes the floor below a guard on the plumbing — the keys the eval builds,
  the document the prompt carries, the verifier's membership test — rather than a
  quality bar.
* **citation recall** = ``|cited ∩ (gold ∩ retrieved)| / |gold ∩ retrieved|``.
  Gold the retrieval never found cannot be cited, so it is not counted against
  the model; this is the product claim "the answer links to the operations it
  used" and nothing more.

The total handed to the prompt is the eval's own, built the way
``tx_totals.converted_total_for_rows`` builds the server's: operations in
``BASE_CURRENCY`` are summed, operations in another currency are NOT — they are
reported as ``unconverted_count``, which is the arm the server takes when it has
no rate. There are no exchange rates in an eval and inventing one would make the
only money figure in the prompt a fiction.
"""

import logging
import sys
from pathlib import Path

if __package__ in {None, ""}:
    # See ``run.py``: the documented command is the script path, while pytest
    # imports this same file as ``evals.qa``.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import argparse
import asyncio
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from budget_api.domain.money import to_major_string
from budget_api.llm import LLMError, Usage
from budget_api.services.advisor_qa import (
    PROMPT_VERSION,
    QaOperation,
    QaTotal,
    answer_question,
)
from budget_api.services.tx_search import SCORE_DIGITS
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
    ms_text,
    pct,
    percentile,
    ratio,
    replay_file,
    slug,
    start_fixture,
    total_cost,
    validate_run,
    write_report,
)
from evals.gen_retrieval import BASE_CURRENCY, CORPUS_PATH, QUERIES_PATH, Doc, Query
from evals.retrieval import (
    build_embedder,
    embed_corpus,
    load_corpus,
    load_queries,
    rank_keys,
)

logger = logging.getLogger("evals.qa")

#: How many operations one question is answered from — the wire default of
#: ``AdvisorQaAsk.limit`` and ``GET /transactions/search?limit=``. It is part of
#: the prompt, so changing it invalidates the replay fixture.
QA_LIMIT = 20

#: The floors ``tests/test_evals_regression.py`` holds the replay run to.
#:
#: PLACEHOLDERS, calibrated on the SYNTHETIC fixture: the committed replay store
#: is recorded from ``FakeProvider("fake")``, which cites every operation sharing
#: a literal word with the question and invents nothing — so groundedness is
#: 1.0 by construction and the recall below is a word-overlap matcher's score
#: over a fake-embedder retrieval, not a model's. Both must be re-set from the
#: first real ``--mode live`` run, and raising either is only allowed with a
#: report to point at (grooming ruling R3).
QA_MIN_GROUNDEDNESS = 0.99
QA_MIN_CITATION_RECALL = 0.20


@dataclass(frozen=True)
class QuestionResult:
    """One question's outcome, already reduced to the numbers a report needs."""

    id: str
    language: str
    retrieved: int
    #: ``gold ∩ retrieved`` — what could possibly have been cited.
    citable: int
    cited: int
    #: Of the cited keys, how many are in ``gold ∩ retrieved``.
    cited_gold: int
    #: Citations the verifier refused (unknown or duplicate key).
    dropped: int
    failure: str | None

    @property
    def citations_before_drop(self) -> int:
        return self.cited + self.dropped


@dataclass(frozen=True)
class QaReport:
    """Everything one run measured. Rendered to markdown and JSON as is."""

    provider: str
    model: str
    prompt_version: str
    mode: str
    generated_at: datetime
    dataset: str
    questions: int
    answered: int
    citations: int
    dropped: int
    citable: int
    cited_gold: int
    silent: int
    failures: Mapping[str, int]
    calls: int
    cost_usd: Decimal | None
    latency_p50_ms: int | None
    latency_p95_ms: int | None

    @property
    def synthetic(self) -> bool:
        return self.provider == "fake"

    @property
    def groundedness(self) -> float:
        """Share of the model's own citations that survived the verifier."""
        before = self.citations + self.dropped
        return 1.0 - ratio(self.dropped, before)

    @property
    def citation_recall(self) -> float:
        return ratio(self.cited_gold, self.citable)

    def to_markdown(self) -> str:
        lines = [
            f"# Q&A evals — {self.provider}/{self.model} ({self.prompt_version})",
            "",
        ]
        if self.synthetic:
            lines += [
                "> **SYNTHETIC RUN — not a model quality number.** Retrieval is",
                "> the hashed-bag-of-words `embeddings/fake.py` and the answers",
                "> come from `llm/fake.py`, which cites every operation sharing a",
                "> literal word with the question and invents nothing. This report",
                "> exists to show the pipeline and to pin its mechanics in CI. No",
                "> real-model numbers exist until someone runs `--mode live`.",
                "",
            ]
        lines += [
            f"- mode: `{self.mode}`",
            f"- run at: {self.generated_at.isoformat(timespec='seconds')}",
            f"- dataset: `{self.dataset}`"
            f" ({self.questions} questions, top {QA_LIMIT} operations each)",
            f"- retrieval: in-memory, fake embedder, base currency {BASE_CURRENCY}",
            "",
            "## Groundedness",
            "",
            f"- **groundedness: {pct(self.groundedness)}**"
            f" ({self.dropped} of {self.citations + self.dropped} citations dropped"
            " by the verifier — unknown or duplicate keys)",
            f"- answered: {self.answered}/{self.questions}"
            + (f" — failures: {dict(self.failures)}" if self.failures else ""),
            f"- answers citing nothing: {self.silent}"
            ' — an allowed answer ("the operations do not answer this")',
            "",
            "## Citation recall",
            "",
            f"- **citation recall: {pct(self.citation_recall)}**"
            f" ({self.cited_gold}/{self.citable} of the gold operations the"
            " retrieval actually returned)",
            f"- citations kept: {self.citations}",
            "",
            "## Cost and latency",
            "",
            f"- calls: {self.calls}",
            f"- cost: {cost_text(self.cost_usd)}",
            f"- latency p50/p95: {ms_text(self.latency_p50_ms)}"
            f" / {ms_text(self.latency_p95_ms)}",
            "",
        ]
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
            "limit": QA_LIMIT,
            "questions": self.questions,
            "answered": self.answered,
            "groundedness": round(self.groundedness, 4),
            "citations": self.citations,
            "dropped_citations": self.dropped,
            "citation_recall": round(self.citation_recall, 4),
            "citable": self.citable,
            "cited_gold": self.cited_gold,
            "silent": self.silent,
            "failures": dict(self.failures),
            "calls": self.calls,
            "cost_usd": None if self.cost_usd is None else str(self.cost_usd),
            "latency_p50_ms": self.latency_p50_ms,
            "latency_p95_ms": self.latency_p95_ms,
        }


async def evaluate_qa(
    *,
    provider_name: str = "fake",
    model: str | None = None,
    prompt_version: str = PROMPT_VERSION,
    mode: str = "replay",
    limit: int | None = None,
    corpus_path: Path = CORPUS_PATH,
    queries_path: Path = QUERIES_PATH,
    replay_dir: Path = REPLAY_DIR,
    api_key: str = "",
) -> QaReport:
    """Answer every question of the dataset and measure. No files are written."""
    validate_run(provider_name, mode, prompt_version, PROMPT_VERSION)
    resolved_model = model or default_model(provider_name)
    docs = load_corpus(corpus_path)
    queries = load_queries(queries_path)[: limit or None]
    retrieved = _retrieve(docs, queries)

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

    results: list[QuestionResult] = []
    for query in queries:
        results.append(await _answer(provider, query, retrieved[query.id]))
    answered = sum(1 for result in results if result.failure is None)
    if mode == "replay" and answered < len(queries):
        raise common.replay_miss(
            replay_path,
            answered,
            len(queries),
            "questions",
            ",".join(sorted({result.failure or "" for result in results} - {""})),
        )
    return _report(
        provider_name=provider_name,
        model=resolved_model,
        prompt_version=prompt_version,
        mode=mode,
        dataset=queries_path.name,
        results=results,
        calls=provider.calls,
    )


def _retrieve(
    docs: Sequence[Doc], queries: Sequence[Query]
) -> dict[str, tuple[tuple[Doc, float], ...]]:
    """Query id → the top ``QA_LIMIT`` ``(document, score)`` pairs, best first.

    The fake embedder, deliberately: a replay fixture recorded against the real
    artifact would make CI depend on 118 MB of weights, and the Q&A is measured
    over "a plausible retrieved set", not over the ranking (which
    ``evals/retrieval.py`` measures on its own).
    """
    embedder = build_embedder("fake")
    embedder.load()
    passages = embed_corpus(embedder, docs)
    asked = embedder.embed([query.text for query in queries], kind="query")
    scores = asked @ passages.T
    by_key = {doc.key: doc for doc in docs}
    keys = [doc.key for doc in docs]
    position = {key: index for index, key in enumerate(keys)}
    retrieved: dict[str, tuple[tuple[Doc, float], ...]] = {}
    for row, query in enumerate(queries):
        ranked = rank_keys(keys, scores[row], QA_LIMIT)
        retrieved[query.id] = tuple(
            # Rounded like the wire (``tx_search.SCORE_DIGITS``): the score
            # travels INSIDE the prompt, so an unrounded float32 would make the
            # replay key depend on the last bit of a dot product.
            (by_key[key], round(float(scores[row, position[key]]), SCORE_DIGITS))
            for key in ranked
        )
    return retrieved


async def _answer(
    provider: UsageProvider, query: Query, hits: Sequence[tuple[Doc, float]]
) -> QuestionResult:
    """One question through the app's own pass, scored against the gold set."""
    keyed = {f"o{index}": hit for index, hit in enumerate(hits, start=1)}
    operations = [_operation(key, doc, score) for key, (doc, score) in keyed.items()]
    gold = set(query.gold)
    citable = {key for key, (doc, _) in keyed.items() if doc.key in gold}
    try:
        answered = await answer_question(
            provider,
            question=query.text,
            language=query.language,
            base_currency=BASE_CURRENCY,
            total=_total([doc for doc, _ in hits]),
            operations=operations,
            user_id="evals",
        )
    except LLMError as exc:
        return QuestionResult(
            id=query.id,
            language=query.language,
            retrieved=len(hits),
            citable=len(citable),
            cited=0,
            cited_gold=0,
            dropped=0,
            failure=exc.code,
        )
    return QuestionResult(
        id=query.id,
        language=query.language,
        retrieved=len(hits),
        citable=len(citable),
        cited=len(answered.cited_keys),
        cited_gold=sum(1 for key in answered.cited_keys if key in citable),
        dropped=answered.dropped,
        failure=None,
    )


def _operation(key: str, doc: Doc, score: float) -> QaOperation:
    return QaOperation(
        key=key,
        occurred_at=date.fromisoformat(doc.occurred_at),
        kind=doc.kind,
        amount=to_major_string(doc.amount_minor, doc.currency),
        currency=doc.currency,
        merchant=doc.merchant,
        note=doc.note,
        category=doc.category,
        country=doc.country,
        account=doc.account,
        score=score,
    )


def _total(docs: Sequence[Doc]) -> QaTotal:
    """The server's three buckets, minus the one an eval has no rates for."""
    income = sum(
        doc.amount_minor
        for doc in docs
        if doc.kind == "income" and doc.currency == BASE_CURRENCY
    )
    expense = sum(
        doc.amount_minor
        for doc in docs
        if doc.kind == "expense" and doc.currency == BASE_CURRENCY
    )
    return QaTotal.from_minor(
        income_minor=income,
        expense_minor=expense,
        currency=BASE_CURRENCY,
        unconverted_count=sum(1 for doc in docs if doc.currency != BASE_CURRENCY),
    )


def _report(
    *,
    provider_name: str,
    model: str,
    prompt_version: str,
    mode: str,
    dataset: str,
    results: Sequence[QuestionResult],
    calls: Sequence[Usage],
) -> QaReport:
    failures: dict[str, int] = {}
    for result in results:
        if result.failure is not None:
            failures[result.failure] = failures.get(result.failure, 0) + 1
    latencies = [usage.latency_ms for usage in calls]
    return QaReport(
        provider=provider_name,
        model=model,
        prompt_version=prompt_version,
        mode=mode,
        generated_at=datetime.now(UTC),
        dataset=dataset,
        questions=len(results),
        answered=sum(1 for result in results if result.failure is None),
        citations=sum(result.cited for result in results),
        dropped=sum(result.dropped for result in results),
        citable=sum(result.citable for result in results),
        cited_gold=sum(result.cited_gold for result in results),
        silent=sum(
            1 for result in results if result.failure is None and result.cited == 0
        ),
        failures=failures,
        calls=len(calls),
        cost_usd=total_cost(calls),
        latency_p50_ms=percentile(latencies, 0.5),
        latency_p95_ms=percentile(latencies, 0.95),
    )


def _parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Measure the cited Q&A pass (groundedness, citation recall)."
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
        help="first N questions only (the fixture still answers them)",
    )
    parser.add_argument("--corpus", type=Path, default=CORPUS_PATH)
    parser.add_argument("--queries", type=Path, default=QUERIES_PATH)
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
            evaluate_qa(
                provider_name=provider_name,
                model=model,
                prompt_version=args.prompt_version,
                mode=args.mode,
                limit=args.limit,
                corpus_path=args.corpus,
                queries_path=args.queries,
                replay_dir=replay_dir,
                api_key=os.environ.get("ANTHROPIC_API_KEY", ""),
            )
        )
    except EvalError as exc:
        print(f"evals: {exc}", file=sys.stderr)
        return 2
    stem = f"qa-{slug(report.provider)}-{slug(report.model)}-{report.prompt_version}"
    paths = write_report(args.reports_dir, stem, report.to_markdown(), report.to_json())
    # Program OUTPUT (the report itself), not logging.
    print(report.to_markdown())
    for path in paths:
        print(f"written: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
