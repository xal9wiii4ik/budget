"""Score the retrieval half of search: recall@k, MRR, and the score distribution.

From ``apps/api``::

    uv run python evals/retrieval.py --embedder fake    # what CI runs: no artifact
    uv run python evals/retrieval.py --embedder onnx    # the REAL 118 MB model

No database, no FastAPI app, no LLM: the corpus is turned into the canonical
document by :func:`budget_api.services.tx_text.tx_text` and handed straight to an
``Embedder`` (``budget_api.embeddings``), which is the same pair of functions
``services/tx_index.py`` runs in the sweep. What this runner therefore measures
is exactly the retrieval the server does — minus the SQL filter, which is the
list route's own tested code.

**The fake embedder is not a model.** ``embeddings/fake.py`` is a hashed bag of
words: it finds a passage that shares a WORD with the query and is blind to
meaning, to morphology and to language, so ``apteka`` and ``Аптека`` are
strangers to it. Its report exists to show the pipeline and to pin the mechanics
in CI (``tests/test_evals_regression.py``), and it opens with a banner saying so.
A number anyone may quote comes from ``--embedder onnx`` and lands in a report
whose first lines say ``real: true`` and name the manifest revision and the
artifact's sha256 (``docs/conventions.md``).

Metric definitions, stated once here because a recall number with an unstated
denominator is unreadable:

* **recall@k is CAPPED** — ``|gold ∩ top-k| / min(|gold|, k)``. Several queries
  (the country ones) have more gold rows than ``k``, and an uncapped denominator
  would report a ceiling of 0.6 as a model failure.
* **MRR** is over the FIRST gold hit of each query, 0 when none is in the top 20.
* **per-language recall@10** is the macro mean over the queries written in that
  language — the cross-lingual claim of the whole scope, since a document in one
  language is asked about in three.
* **the score percentiles** are over every ``(query, document)`` pair, split by
  whether the pair is gold. They are the evidence behind D-R3 ("no default
  ``min_score``"): if the two distributions overlap, any absolute cut-off drops
  true hits.
"""

import logging
import sys
from pathlib import Path

if __package__ in {None, ""}:
    # See ``run.py``: the documented command is the script path, while pytest
    # imports this same file as ``evals.retrieval``.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import argparse
import math
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import numpy as np
from numpy.typing import NDArray

from budget_api.embeddings import (
    Embedder,
    EmbedderLoadError,
    FakeEmbedder,
    OnnxEmbedder,
    load_manifest,
)
from budget_api.services.tx_text import TEXT_VERSION, TextFacts, tx_text
from evals.common import (
    REPORTS_DIR,
    EvalError,
    json_integer,
    json_object,
    json_optional_text,
    json_strings,
    json_text,
    ms_text,
    pct,
    setting_int,
    setting_str,
    slug,
    write_report,
)
from evals.gen_retrieval import CORPUS_PATH, QUERIES_PATH, Doc, Query

logger = logging.getLogger("evals.retrieval")

EMBEDDERS = ("fake", "onnx")

#: The ``k``s every report carries, and the depth the ranking is cut at.
RECALL_AT = (5, 10, 20)

#: The floor ``tests/test_evals_regression.py`` holds the FAKE run to.
#:
#: PLACEHOLDER, calibrated on the fake embedder: ``embeddings/fake.py`` is a
#: hashed bag of words, so it answers a query only where the query and the
#: document share a literal word — which on a deliberately tri-lingual dataset is
#: a minority of the gold pairs. Whatever that scores is what this number tracks
#: (a hair below it), so the test fails on a real mechanical regression — the
#: document template, the key assignment, the cosine, the top-k order — and not
#: on float noise. It is NOT a quality bar for the real model: the committed
#: ``--embedder onnx`` report is, and raising this floor is only allowed with
#: that report to point at.
RETRIEVAL_MIN_RECALL_AT_10 = 0.45

#: Which percentiles of the two score distributions the report prints.
_PERCENTILES = (0.05, 0.25, 0.5, 0.75, 0.95)


@dataclass(frozen=True)
class QueryResult:
    """One query's ranking, already reduced to the numbers a report needs."""

    id: str
    language: str
    theme: str
    gold: int
    #: ``k → |gold ∩ top-k|``.
    hits: Mapping[int, int]
    #: 1-based rank of the first gold document, ``None`` if none ranked in the
    #: deepest ``k``.
    first_gold_rank: int | None

    def recall(self, at: int) -> float:
        """Capped recall at ``at`` — see the module docstring."""
        return self.hits[at] / min(self.gold, at)

    @property
    def reciprocal_rank(self) -> float:
        return 0.0 if self.first_gold_rank is None else 1.0 / self.first_gold_rank


@dataclass(frozen=True)
class GroupStat:
    """Recall@10 for a group of queries (a language, or a theme)."""

    name: str
    queries: int
    recall_at_10: float


@dataclass(frozen=True)
class RetrievalReport:
    """Everything one run measured. Rendered to markdown and JSON as is."""

    embedder: str
    model: str
    text_version: str
    generated_at: datetime
    corpus: int
    queries: int
    gold_pairs: int
    recall: Mapping[int, float]
    mrr: float
    by_language: tuple[GroupStat, ...]
    by_theme: tuple[GroupStat, ...]
    gold_scores: Mapping[str, float]
    other_scores: Mapping[str, float]
    embed_ms: int
    query_ms: int
    #: ``{repo, revision, model_sha256}`` for the real artifact; empty for the
    #: fake, which has nothing to pin.
    artifact: Mapping[str, str]

    @property
    def real(self) -> bool:
        """A number anyone may quote comes only from a real artifact."""
        return self.embedder != "fake"

    def to_markdown(self) -> str:
        lines = [
            f"# Retrieval evals — {self.embedder}/{self.model} ({self.text_version})",
            "",
        ]
        lines += self._banner()
        lines += [
            f"- run at: {self.generated_at.isoformat(timespec='seconds')}",
            f"- corpus: {self.corpus} documents through `services/tx_text.py`"
            f" (`{self.text_version}`)",
            f"- queries: {self.queries} in three languages,"
            f" {self.gold_pairs} gold pairs",
            f"- embedding: {ms_text(self.embed_ms)} for the corpus,"
            f" {ms_text(self.query_ms)} for the queries",
            "",
            "## Recall and MRR",
            "",
            "Capped recall: `|gold ∩ top-k| / min(|gold|, k)`, macro over queries."
            " MRR is over the first gold hit.",
            "",
            "| metric | value |",
            "| --- | --- |",
        ]
        for at in RECALL_AT:
            lines.append(f"| recall@{at} | {pct(self.recall[at])} |")
        lines += [
            f"| MRR | {self.mrr:.4f} |",
            "",
            "## Per language (recall@10)",
            "",
            "| language | queries | recall@10 |",
            "| --- | --- | --- |",
        ]
        for stat in self.by_language:
            lines.append(f"| {stat.name} | {stat.queries} | {pct(stat.recall_at_10)} |")
        lines += [
            "",
            "## Per theme (recall@10)",
            "",
            "| theme | queries | recall@10 |",
            "| --- | --- | --- |",
        ]
        for stat in self.by_theme:
            lines.append(f"| {stat.name} | {stat.queries} | {pct(stat.recall_at_10)} |")
        lines += [
            "",
            "## Score distribution (cosine, gold vs non-gold pairs)",
            "",
            "Every `(query, document)` pair, split by gold. Overlapping bands are"
            " why there is no default `min_score` (D-R3).",
            "",
            "| pairs | "
            + " | ".join(f"p{int(share * 100):02d}" for share in _PERCENTILES)
            + " |",
            "| --- |" + " --- |" * len(_PERCENTILES),
        ]
        for name, scores in (
            ("gold", self.gold_scores),
            ("non-gold", self.other_scores),
        ):
            cells = " | ".join(
                f"{scores[_percentile_name(share)]:.4f}" for share in _PERCENTILES
            )
            lines.append(f"| {name} | {cells} |")
        lines.append("")
        return "\n".join(lines)

    def _banner(self) -> list[str]:
        if not self.real:
            return [
                "> **SYNTHETIC RUN — not a model quality number.** The `fake`",
                "> embedder in `embeddings/fake.py` is a hashed bag of words: it",
                "> matches a literal shared WORD and knows nothing of meaning,",
                "> morphology or language. This report exists to show the pipeline",
                "> and to pin its mechanics in CI. The real numbers are in the",
                "> `--embedder onnx` report beside this one.",
                "",
            ]
        return [
            f"> **real: true** — produced by the pinned artifact"
            f" `{self.artifact.get('repo', '')}`",
            f"> at revision `{self.artifact.get('revision', '')}`,",
            f"> `model.onnx` sha256 `{self.artifact.get('model_sha256', '')}`,",
            "> verified by `embeddings/manifest.py` before the session was built.",
            "> The dataset is synthetic (`evals/gen_retrieval.py`); the MODEL and",
            "> the numbers below are not.",
            "",
        ]

    def to_json(self) -> dict[str, Any]:
        return {
            "embedder": self.embedder,
            "model": self.model,
            "text_version": self.text_version,
            "real": self.real,
            "synthetic": not self.real,
            "artifact": dict(self.artifact),
            "generated_at": self.generated_at.isoformat(timespec="seconds"),
            "corpus": self.corpus,
            "queries": self.queries,
            "gold_pairs": self.gold_pairs,
            "recall": {f"at_{at}": round(self.recall[at], 4) for at in RECALL_AT},
            "mrr": round(self.mrr, 4),
            "by_language": [_group_json(stat) for stat in self.by_language],
            "by_theme": [_group_json(stat) for stat in self.by_theme],
            "gold_scores": {
                key: round(value, 4) for key, value in self.gold_scores.items()
            },
            "other_scores": {
                key: round(value, 4) for key, value in self.other_scores.items()
            },
            "embed_ms": self.embed_ms,
            "query_ms": self.query_ms,
        }


def evaluate_retrieval(
    *,
    embedder_name: str = "fake",
    model_dir: Path | None = None,
    manifest_path: Path | None = None,
    corpus_path: Path = CORPUS_PATH,
    queries_path: Path = QUERIES_PATH,
) -> RetrievalReport:
    """Embed the corpus, rank every query against it, measure. Writes nothing.

    Writing is the CLI's job, so the regression test can run this in-process and
    compare it with the committed report without touching the repo.
    """
    docs = load_corpus(corpus_path)
    queries = load_queries(queries_path)
    embedder = build_embedder(
        embedder_name, model_dir=model_dir, manifest_path=manifest_path
    )
    try:
        embedder.load()
    except EmbedderLoadError as exc:
        # The app answers a missing artifact with one warning and a 503; a
        # measurement has nothing to degrade to, so it refuses out loud.
        raise EvalError(
            f"the artifact is not usable ({exc}) — fetch it first:"
            " uv run python -I scripts/fetch_model.py --manifest model_manifest.json"
            " --dest models/multilingual-e5-small"
        ) from exc

    started = time.perf_counter()
    passages = embed_corpus(embedder, docs)
    embed_ms = int((time.perf_counter() - started) * 1000)
    started = time.perf_counter()
    # One call for the whole query set: the SERVER embeds exactly one query per
    # request, so this number is a batch cost to divide, not a per-request one.
    asked = embedder.embed([query.text for query in queries], kind="query")
    query_ms = int((time.perf_counter() - started) * 1000)

    # Both sides are L2-normalised by the Embedder contract, so the dot product
    # IS the cosine — the same identity ``services/tx_search.py`` relies on.
    scores = asked @ passages.T
    keys = [doc.key for doc in docs]
    results: list[QueryResult] = []
    gold_scores: list[float] = []
    other_scores: list[float] = []
    for row, query in enumerate(queries):
        results.append(_rank(query, keys, scores[row]))
        gold = set(query.gold)
        for column, key in enumerate(keys):
            value = float(scores[row, column])
            (gold_scores if key in gold else other_scores).append(value)
    return _report(
        embedder=embedder,
        docs=docs,
        queries=queries,
        results=results,
        gold_scores=gold_scores,
        other_scores=other_scores,
        embed_ms=embed_ms,
        query_ms=query_ms,
        manifest_path=manifest_path,
    )


def build_embedder(
    name: str, *, model_dir: Path | None = None, manifest_path: Path | None = None
) -> Embedder:
    """The embedder the APP would build for ``EMBEDDINGS_PROVIDER=<name>``.

    Paths and threads come from ``Settings``' FIELD DEFAULTS, not from a
    constructed ``Settings``: reading the environment would make a report (and
    the fixture a replay is keyed by) depend on whose machine it ran on.
    """
    if name == "fake":
        return FakeEmbedder()
    if name != "onnx":
        raise EvalError(f"unknown embedder {name!r}, expected one of {EMBEDDERS}")
    return OnnxEmbedder(
        model_dir or Path(setting_str("embeddings_model_dir")),
        manifest_path or Path(setting_str("embeddings_manifest_path")),
        threads=setting_int("embeddings_threads"),
    )


def embed_corpus(embedder: Embedder, docs: Sequence[Doc]) -> NDArray[np.float32]:
    """The corpus as ``(n, dim)`` passage vectors, in ``docs`` order.

    In ``embeddings_batch_size`` chunks, exactly as the sweep embeds
    (``services/tx_index.py``): the batch size is part of what the real artifact
    costs, and a 42-row single call would measure a shape the server never uses.
    """
    texts = [document_text(doc) for doc in docs]
    size = setting_int("embeddings_batch_size")
    chunks = [
        embedder.embed(texts[start : start + size], kind="passage")
        for start in range(0, len(texts), size)
    ]
    return np.vstack(chunks).astype(np.float32)


def document_text(doc: Doc) -> str:
    """The canonical document — the app's own function, never a copy of it."""
    return tx_text(
        TextFacts(
            merchant=doc.merchant,
            note=doc.note,
            category_name=doc.category,
            kind=doc.kind,
            country=doc.country,
            account_name=doc.account,
        )
    )


def load_corpus(path: Path = CORPUS_PATH) -> tuple[Doc, ...]:
    """Read ``corpus.jsonl``. A malformed line is an error, never a skip."""
    docs: list[Doc] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        where = f"{path}:{number}"
        body = json_object(line, where)
        docs.append(
            Doc(
                key=json_text(body, "key", where),
                merchant=json_text(body, "merchant", where),
                note=json_optional_text(body, "note", where),
                category=json_optional_text(body, "category", where),
                kind=json_text(body, "kind", where),
                country=json_optional_text(body, "country", where),
                account=json_optional_text(body, "account", where),
                currency=json_text(body, "currency", where),
                amount_minor=json_integer(body, "amount_minor", where),
                occurred_at=json_text(body, "occurred_at", where),
                theme=json_text(body, "theme", where),
                language=json_text(body, "language", where),
                source=json_text(body, "source", where),
            )
        )
    if not docs:
        raise EvalError(f"corpus {path} has no documents")
    if len({doc.key for doc in docs}) != len(docs):
        # Keys index every gold set and every score lookup; a duplicate would
        # not fail anywhere, it would quietly measure the wrong document.
        raise EvalError(f"corpus {path} has duplicate keys")
    return tuple(docs)


def load_queries(path: Path = QUERIES_PATH) -> tuple[Query, ...]:
    """Read ``queries.jsonl``; a query with an empty gold set is an error."""
    queries: list[Query] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        where = f"{path}:{number}"
        body = json_object(line, where)
        gold = json_strings(body, "gold", where)
        if not gold:
            raise EvalError(f"{where}: empty gold set")
        queries.append(
            Query(
                id=json_text(body, "id", where),
                text=json_text(body, "text", where),
                language=json_text(body, "language", where),
                theme=json_text(body, "theme", where),
                gold=tuple(gold),
                source=json_text(body, "source", where),
            )
        )
    if not queries:
        raise EvalError(f"query set {path} has no queries")
    return tuple(queries)


def rank_keys(
    keys: Sequence[str], scores: NDArray[np.float32], limit: int
) -> list[str]:
    """Top ``limit`` keys, best first — the server's own tie rule.

    ``kind="stable"`` keeps the input order among equal scores, and the input
    order here is the corpus file's, exactly as ``services/tx_search.py`` keeps
    the SQL order (``occurred_at desc, id``) among ties. The default quicksort
    would make every tie non-deterministic and this whole report unreproducible.
    """
    order = np.argsort(-scores, kind="stable")[:limit]
    return [keys[int(index)] for index in order]


def _rank(
    query: Query, keys: Sequence[str], scores: NDArray[np.float32]
) -> QueryResult:
    ranked = rank_keys(keys, scores, max(RECALL_AT))
    gold = set(query.gold)
    first = next(
        (position for position, key in enumerate(ranked, 1) if key in gold), None
    )
    return QueryResult(
        id=query.id,
        language=query.language,
        theme=query.theme,
        gold=len(gold),
        hits={at: sum(1 for key in ranked[:at] if key in gold) for at in RECALL_AT},
        first_gold_rank=first,
    )


def _report(
    *,
    embedder: Embedder,
    docs: Sequence[Doc],
    queries: Sequence[Query],
    results: Sequence[QueryResult],
    gold_scores: Sequence[float],
    other_scores: Sequence[float],
    embed_ms: int,
    query_ms: int,
    manifest_path: Path | None,
) -> RetrievalReport:
    return RetrievalReport(
        embedder=embedder.name,
        model=embedder.model,
        text_version=TEXT_VERSION,
        generated_at=datetime.now(UTC),
        corpus=len(docs),
        queries=len(queries),
        gold_pairs=sum(len(query.gold) for query in queries),
        recall={
            at: _mean([result.recall(at) for result in results]) for at in RECALL_AT
        },
        mrr=_mean([result.reciprocal_rank for result in results]),
        by_language=_groups(results, lambda result: result.language),
        by_theme=_groups(results, lambda result: result.theme),
        gold_scores=_distribution(gold_scores),
        other_scores=_distribution(other_scores),
        embed_ms=embed_ms,
        query_ms=query_ms,
        artifact=_artifact(embedder, manifest_path),
    )


def _artifact(embedder: Embedder, manifest_path: Path | None) -> dict[str, str]:
    """The pin a real report must carry: repo, revision, the model's sha256."""
    if embedder.name == "fake":
        return {}
    manifest = load_manifest(
        manifest_path or Path(setting_str("embeddings_manifest_path"))
    )
    model_sha = next(
        (entry.sha256 for entry in manifest.files if entry.local_name == "model.onnx"),
        "",
    )
    return {
        "repo": manifest.repo,
        "revision": manifest.revision,
        "model_sha256": model_sha,
    }


def _groups(
    results: Sequence[QueryResult], key: Callable[[QueryResult], str]
) -> tuple[GroupStat, ...]:
    grouped: dict[str, list[QueryResult]] = {}
    for result in results:
        grouped.setdefault(key(result), []).append(result)
    return tuple(
        GroupStat(
            name=name,
            queries=len(group),
            recall_at_10=_mean([result.recall(10) for result in group]),
        )
        for name, group in sorted(grouped.items())
    )


def _distribution(values: Sequence[float]) -> dict[str, float]:
    return {
        _percentile_name(share): _percentile(values, share) for share in _PERCENTILES
    }


def _percentile_name(share: float) -> str:
    return f"p{int(share * 100):02d}"


def _percentile(values: Sequence[float], share: float) -> float:
    """Nearest-rank percentile, like ``common.percentile`` but over floats."""
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, math.ceil(share * len(ordered)) - 1)
    return ordered[index]


def _mean(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _group_json(stat: GroupStat) -> dict[str, Any]:
    return {
        "name": stat.name,
        "queries": stat.queries,
        "recall_at_10": round(stat.recall_at_10, 4),
    }


def model_slug(model: str) -> str:
    """``intfloat/multilingual-e5-small@614241f/model.onnx`` → the middle part.

    The report stem has to name the artifact (two reports from two models must
    never overwrite each other) without carrying a repo owner and a file
    extension through a filename: the revision-stamped model name is the part
    that identifies it.
    """
    parts = model.split("/")
    return slug(parts[1] if len(parts) == 3 else model)


def report_stem(report: RetrievalReport) -> str:
    return (
        f"retrieval-{report.embedder}-{model_slug(report.model)}-{report.text_version}"
    )


def _parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Measure retrieval over the committed corpus (recall@k, MRR)."
    )
    parser.add_argument("--embedder", choices=EMBEDDERS, default="fake")
    parser.add_argument(
        "--model-dir",
        type=Path,
        default=None,
        help="the onnx artifact directory (default: the app's EMBEDDINGS_MODEL_DIR)",
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=None,
        help="the pin verified before the session is built (default: the app's)",
    )
    parser.add_argument("--corpus", type=Path, default=CORPUS_PATH)
    parser.add_argument("--queries", type=Path, default=QUERIES_PATH)
    parser.add_argument("--reports-dir", type=Path, default=REPORTS_DIR)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        report = evaluate_retrieval(
            embedder_name=args.embedder,
            model_dir=args.model_dir,
            manifest_path=args.manifest,
            corpus_path=args.corpus,
            queries_path=args.queries,
        )
    except EvalError as exc:
        print(f"evals: {exc}", file=sys.stderr)
        return 2
    paths = write_report(
        args.reports_dir, report_stem(report), report.to_markdown(), report.to_json()
    )
    # Program OUTPUT (the report itself), not logging.
    print(report.to_markdown())
    for path in paths:
        print(f"written: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
