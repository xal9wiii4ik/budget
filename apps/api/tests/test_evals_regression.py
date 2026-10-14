"""The CI regression of the evals pipeline: replay only, no network, no DB.

What these three tests are for, and what they are NOT for: they pin the
MECHANICS of the categorize pass (batching, dedupe, fan-out, validation,
scoring) against a recorded fixture. The accuracy number they check is the
synthetic ``FakeProvider`` number — not a model quality bar (see
``EVALS_MIN_ACCURACY``'s docstring and grooming ruling R3).
"""

from pathlib import Path

import pytest

from evals.run import (
    CATEGORIES_PATH,
    DATASET_PATH,
    EVALS_MIN_ACCURACY,
    EvalError,
    evaluate,
    load_categories,
    load_dataset,
)


class TestReplayRegression:
    async def test_replay_scores_exactly_what_the_fake_scores(self) -> None:
        """The committed fixture must reproduce an in-process fake run exactly.

        This is the guard that matters: the replay store is keyed by the whole
        request (prompt, schema, batch contents, max_tokens), so any change to
        prompt text, batching, dedupe or key assignment makes the two runs
        disagree — either by a miss (next test) or by a different score here.
        """
        replayed = await evaluate(provider_name="fake", mode="replay")
        in_process = await evaluate(provider_name="fake", mode="live")

        assert replayed.accuracy == in_process.accuracy
        assert replayed.correct == in_process.correct
        assert replayed.unsure == in_process.unsure
        assert replayed.calls == in_process.calls
        assert replayed.accuracy >= EVALS_MIN_ACCURACY

    async def test_a_replay_miss_fails_loudly_instead_of_scoring_zero(
        self, tmp_path: Path
    ) -> None:
        """An empty store must raise, never report 0% as if the model were bad.

        ``replay_miss`` is NOT one of ``categorize``'s aborting codes, so the
        pass degrades per batch and returns an empty result mapping — exactly
        the shape that would otherwise be published as "accuracy 0.0%".
        """
        with pytest.raises(EvalError) as error:
            await evaluate(provider_name="fake", mode="replay", replay_dir=tmp_path)

        message = str(error.value)
        assert "answered 0/" in message
        assert "--mode record" in message


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
