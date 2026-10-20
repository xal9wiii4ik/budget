"""The CI regression of the evals pipeline: replay only, no network, no DB.

What these tests are for, and what they are NOT for: they pin the MECHANICS of
the three measured passes — categorize (batching, dedupe, fan-out, validation,
scoring), the Alfa extraction (chunking, key assignment, the server-side money
conversion, the self-check) and the reconcile loop (pre-match, the tool steps,
key resolution, terminal validation) — against recorded fixtures. Every accuracy
and recall number they check is the synthetic ``FakeProvider`` number, NOT a
model quality bar: see each floor's own docstring and grooming ruling R3.
"""

import json
import shutil
from pathlib import Path

import pytest

from budget_api.services.categorize import PROMPT_VERSION_V1, PROMPT_VERSION_V2
from budget_api.services.categorize_examples import SELECTION_VERSION
from evals import extract, qa, reconcile, retrieval
from evals.common import REPLAY_DIR, REPORTS_DIR
from evals.run import (
    CATEGORIES_PATH,
    DATASET_PATH,
    EVALS_MIN_ACCURACY_V2,
    EvalError,
    evaluate,
    load_categories,
    load_dataset,
    split_dataset,
)


class TestReplayRegression:
    async def test_replay_scores_exactly_what_the_fake_scores(self) -> None:
        """The committed fixture must reproduce an in-process fake run exactly.

        This is the guard that matters: the replay store is keyed by the whole
        request (prompt, schema, batch contents, max_tokens), so any change to
        prompt text, batching, dedupe or key assignment makes the two runs
        disagree — either by a miss (next test) or by a different score here.

        No floor is asserted on the fake any more: what it scores is a fact about
        a substring matcher, and the quality floor now hangs off a real model's
        recorded run (the test below). The EQUALITY is the whole point here.
        """
        replayed = await evaluate(
            provider_name="fake", mode="replay", prompt_version=PROMPT_VERSION_V1
        )
        in_process = await evaluate(
            provider_name="fake", mode="live", prompt_version=PROMPT_VERSION_V1
        )

        assert replayed.accuracy == in_process.accuracy
        assert replayed.correct == in_process.correct
        assert replayed.unsure == in_process.unsure
        assert replayed.calls == in_process.calls

    async def test_the_recorded_qwen_v2_run_replays_above_its_floor(self) -> None:
        """The one REAL floor: a local model's recorded few-shot run, replayed.

        Fixture ``replay/ollama-qwen2.5-7b-categorize-v2-test.jsonl`` plus its
        examples sidecar, from the live record run of 2026-10-20 reported in
        ``evals/reports/ollama-qwen2.5-7b-categorize-v2-test.md`` (63 test rows,
        63.5% overall, 64.3% unseen). ``EVALS_MIN_ACCURACY_V2`` sits ~1 pp below
        that, so this fails on a mechanical regression — batching, dedupe,
        validation, fan-out, the example SELECTION the sidecar pins — and not on
        float noise. It needs no network, no key, no database and no embedding
        artifact, which is exactly why the examples are recorded beside the
        answers (grooming D7).

        A replay run must name the provider/model the fixture was cut from: the
        replay key contains them, so defaults would miss every entry.
        """
        report = await evaluate(
            provider_name="ollama",
            model="qwen2.5:7b",
            prompt_version=PROMPT_VERSION_V2,
            split="test",
            mode="replay",
        )

        assert report.effective_prompt_version == PROMPT_VERSION_V2
        assert report.examples_per_call > 0
        assert report.accuracy >= EVALS_MIN_ACCURACY_V2

    async def test_a_replay_miss_fails_loudly_instead_of_scoring_zero(
        self, tmp_path: Path
    ) -> None:
        """An empty store must raise, never report 0% as if the model were bad.

        ``replay_miss`` is NOT one of ``categorize``'s aborting codes, so the
        pass degrades per batch and returns an empty result mapping — exactly
        the shape that would otherwise be published as "accuracy 0.0%".
        """
        with pytest.raises(EvalError) as error:
            await evaluate(
                provider_name="fake",
                mode="replay",
                prompt_version=PROMPT_VERSION_V1,
                replay_dir=tmp_path,
            )

        message = str(error.value)
        assert "answered 0/" in message
        assert "--mode record" in message

    async def test_a_sidecar_cut_by_another_selection_refuses_the_v2_replay(
        self, tmp_path: Path
    ) -> None:
        """The header pin is the ONLY thing standing between a v2 number and a lie.

        The sidecar's batches are keyed by dataset row ids, so one cut by a
        different selection algorithm still answers every batch of this run: the
        replay would score fine and publish a number about examples this build
        cannot reproduce. Nothing else fails if the check is deleted — the
        fixture still matches, because the recorded requests carry the recorded
        examples (grooming D7). Hence this test.
        """
        stem = "ollama-qwen2.5-7b-categorize-v2-test"
        shutil.copy(REPLAY_DIR / f"{stem}.jsonl", tmp_path / f"{stem}.jsonl")
        body = json.loads(
            (REPLAY_DIR / f"{stem}.examples.json").read_text(encoding="utf-8")
        )
        body["selection_version"] = "examples-v0"
        (tmp_path / f"{stem}.examples.json").write_text(
            json.dumps(body), encoding="utf-8"
        )

        with pytest.raises(EvalError) as error:
            await evaluate(
                provider_name="ollama",
                model="qwen2.5:7b",
                prompt_version=PROMPT_VERSION_V2,
                split="test",
                mode="replay",
                replay_dir=tmp_path,
            )

        message = str(error.value)
        assert "examples-v0" in message
        assert SELECTION_VERSION in message
        assert "--mode record" in message


class TestDatasetSplit:
    def test_the_split_is_disjoint_deterministic_and_stratified(self) -> None:
        """The property every few-shot number depends on: no row is its own example.

        Three claims, because each of them silently ruins the measurement on its
        own: OVERLAP would let a test row be shown its own answer; a
        NON-DETERMINISTIC cut would make two runs of the same fixture score
        differently (and unreplayable, since the examples are part of the
        request); and a label landing entirely on one side would either make it
        unmeasurable or leave it with no example at all, which is precisely the
        rare-category case v2 exists for.
        """
        rows = load_dataset(DATASET_PATH)
        history, test = split_dataset(rows, split="test")

        assert {row.id for row in history} & {row.id for row in test} == set()
        assert len(history) + len(test) == len(rows)
        assert split_dataset(rows, split="test") == (history, test)
        assert split_dataset(rows, split="none") == ((), tuple(rows))
        supports: dict[str, int] = {}
        for row in rows:
            supports[row.label] = supports.get(row.label, 0) + 1
        on_both = {row.label for row in history} & {row.label for row in test}
        assert {label for label, n in supports.items() if n >= 3} <= on_both


class TestDatasetIntegrity:
    def test_every_dataset_label_is_a_category_of_the_same_kind(self) -> None:
        """``categories.json`` and the JSONL are generated together — and drift.

        A label present in the dataset but missing from the category file would
        make that row unanswerable (the model is never offered the label) and
        silently cost accuracy; a kind disagreement would do it per batch, since
        batches are cut per kind.
        """
        rows = load_dataset(DATASET_PATH)
        options = load_categories(CATEGORIES_PATH)
        by_name = {option.name: option for option in options}

        assert {row.label for row in rows} == set(by_name)
        assert len({option.id for option in options}) == len(options)
        for row in rows:
            assert by_name[row.label].kind.value == row.kind


class TestExtractReplayRegression:
    async def test_replay_scores_exactly_what_the_fake_scores(self) -> None:
        """The committed extraction fixture must reproduce an in-process run.

        The replay store is keyed by the whole request (the system prompt, the
        response schema with its enumerated line keys, the chunk's lines,
        ``max_tokens``), so any change to the prompt, the chunking or the line
        keys makes the two runs disagree — either by a miss (which RAISES,
        naming the unanswered statements) or by a different score here.
        """
        replayed = await extract.evaluate_extraction(
            provider_name="fake", mode="replay"
        )
        in_process = await extract.evaluate_extraction(
            provider_name="fake", mode="live"
        )

        assert replayed.failures == in_process.failures == {}
        assert replayed.rows_returned == in_process.rows_returned
        assert replayed.fields == in_process.fields
        assert replayed.row_count_exact == in_process.row_count_exact
        assert replayed.self_check_as_expected == in_process.self_check_as_expected
        assert replayed.calls == in_process.calls

        assert replayed.row_count_exact == replayed.statements
        assert replayed.structural_accuracy >= extract.EXTRACT_MIN_ACCURACY
        assert replayed.merchant_accuracy >= extract.EXTRACT_MIN_MERCHANT_ACCURACY
        assert replayed.self_check_agreement >= extract.EXTRACT_MIN_SELF_CHECK


class TestReconcileReplayRegression:
    async def test_replay_scores_exactly_what_the_fake_scores(self) -> None:
        """The committed reconcile fixture must reproduce an in-process run.

        Three steps per case (rows tool → transactions tool → terminal report),
        and the tool RESULTS are part of the replay key — so a change to the
        payloads, to the opaque keys or to the pre-match split makes the two runs
        disagree. ``settled`` is the pre-match number and involves no provider at
        all: it is the guard that the dataset is still being handed over whole.
        """
        replayed = await reconcile.evaluate_reconciliation(
            provider_name="fake", mode="replay"
        )
        in_process = await reconcile.evaluate_reconciliation(
            provider_name="fake", mode="live"
        )

        assert replayed.aborts == in_process.aborts == {}
        assert replayed.settled == in_process.settled
        assert replayed.by_kind == in_process.by_kind
        assert replayed.predicted_items == in_process.predicted_items
        assert replayed.steps == in_process.steps
        assert replayed.calls == in_process.calls

        assert replayed.settled_rate >= reconcile.RECONCILE_MIN_SETTLED
        assert (
            replayed.recall_of(reconcile.ONE_SIDED_KINDS)
            >= reconcile.RECONCILE_MIN_RECALL
        )


class TestRetrievalRegression:
    def test_the_committed_fake_report_reproduces_an_in_process_run(self) -> None:
        """The committed report is this pipeline's fixture — nothing else pins it.

        There is no LLM and therefore no replay store here, so the committed
        ``reports/retrieval-fake-fake-tx-text-v1.json`` plays that role: an edit
        to the canonical document (``services/tx_text.py``), to ``FakeEmbedder``'s
        bucket hash, to the cosine or to the stable top-k order moves these
        numbers, and so does re-cutting the dataset without re-running the
        runner. Any of those is a fact somebody must look at, not a silent
        change of what every eval number means.

        ``RETRIEVAL_MIN_RECALL_AT_10`` is FAKE-CALIBRATED (see its docstring):
        it tracks what a hashed bag of words scores on a tri-lingual dataset and
        is not a quality bar for the real artifact.
        """
        report = retrieval.evaluate_retrieval(embedder_name="fake")
        fresh = report.to_json()
        committed = json.loads(
            (REPORTS_DIR / f"{retrieval.report_stem(report)}.json").read_text(
                encoding="utf-8"
            )
        )

        for field in (
            "model",
            "text_version",
            "synthetic",
            "corpus",
            "queries",
            "gold_pairs",
            "recall",
            "mrr",
            "by_language",
            "by_theme",
            "gold_scores",
            "other_scores",
        ):
            assert fresh[field] == committed[field], field
        assert report.recall[10] >= retrieval.RETRIEVAL_MIN_RECALL_AT_10


class TestQaReplayRegression:
    async def test_replay_scores_exactly_what_the_fake_scores(self) -> None:
        """The committed QA fixture must reproduce an in-process fake run.

        The replay store is keyed by the whole request — the system prompt, the
        response schema with its enumerated ``o*`` keys, the document with every
        retrieved operation and its rounded score — so a change to the prompt,
        to the schema, to the key assignment, to the eval's retrieval or to the
        dataset makes the two runs disagree: either by a miss (which RAISES,
        naming the unanswered questions) or by a different score here.
        Groundedness is the verifier's own number, and citation recall is
        measured against ``gold ∩ retrieved``.

        Both floors are FAKE-CALIBRATED (see their docstrings): the fake cites
        only keys it was handed, so its groundedness is 1.0 by construction and
        the recall is a word-overlap matcher's.
        """
        replayed = await qa.evaluate_qa(provider_name="fake", mode="replay")
        in_process = await qa.evaluate_qa(provider_name="fake", mode="live")

        assert replayed.failures == in_process.failures == {}
        assert replayed.answered == in_process.answered == replayed.questions
        assert replayed.citations == in_process.citations
        assert replayed.dropped == in_process.dropped
        assert replayed.citable == in_process.citable
        assert replayed.cited_gold == in_process.cited_gold
        assert replayed.calls == in_process.calls

        assert replayed.groundedness >= qa.QA_MIN_GROUNDEDNESS
        assert replayed.citation_recall >= qa.QA_MIN_CITATION_RECALL


class TestSyntheticAlfaDataset:
    def test_every_statement_closes_against_its_own_gold_rows(self) -> None:
        """The committed dataset's anchors are consistent BY CONSTRUCTION.

        This is what makes the extraction numbers readable: a ``passed``
        statement can only fail the self-check if the EXTRACTION is wrong, never
        because the generator printed a total that never matched its rows. The
        ``failed`` statements are the deliberate exception (one operation line is
        hidden from the text and left in the totals) — asserted too, because a
        defect that stopped being seeded would silently turn the self-check
        measurement into a constant 100%.
        """
        statements = extract.load_dataset(extract.DATASET_PATH)

        assert {statement.expect_self_check for statement in statements} == {
            "passed",
            "failed",
        }
        for statement in statements:
            income = sum(
                row.amount_minor for row in statement.rows if row.kind == "income"
            )
            expense = sum(
                row.amount_minor for row in statement.rows if row.kind == "expense"
            )
            closes = (
                statement.opening_minor + income - expense == statement.closing_minor
            )
            if statement.expect_self_check == "passed":
                assert closes, statement.id
                assert income == statement.income_minor, statement.id
                assert expense == -statement.expense_minor, statement.id
                assert all(
                    statement.period_from <= row.day <= statement.period_to
                    for row in statement.rows
                ), statement.id
            else:
                assert not closes, statement.id
