"""``services/categorize_examples.select`` — the three bounds of a v2 document.

No DB, no embedder, no app: the module is pure, so the vectors here are written
by hand. Scores are therefore EXACT and the assertions are about the selection
rules, not about whether a model finds two merchants similar.

The vectors are 2-D unit vectors (the Embedder contract is L2-normalised rows, and
the dot product being the cosine is all this module assumes), so a pool row's
score against the query is just how aligned they are.
"""

import uuid

import numpy as np

from budget_api.services.categorize_examples import (
    Example,
    ExamplePool,
    SelectionLimits,
    select,
)

FOOD = uuid.uuid4()
TAXI = uuid.uuid4()
GIFTS = uuid.uuid4()
ARCHIVED = uuid.uuid4()


def _unit(angle: float) -> list[float]:
    return [float(np.cos(angle)), float(np.sin(angle))]


def _pool(*rows: tuple[str, uuid.UUID, float]) -> ExamplePool:
    """``(text, category, angle)`` triples → a pool whose scores are known."""
    return ExamplePool(
        texts=tuple(text for text, _, _ in rows),
        category_ids=tuple(category for _, category, _ in rows),
        matrix=np.array([_unit(angle) for _, _, angle in rows], dtype=np.float32),
    )


#: The query: one operation, pointing at angle 0.
QUERY = np.array([_unit(0.0)], dtype=np.float32)


def _limits(**overrides: int) -> SelectionLimits:
    body = {"per_operation": 3, "max_examples": 40, "max_chars": 4000}
    body.update(overrides)
    return SelectionLimits(**body)


class TestEligibility:
    def test_ineligible_category_dropped_and_a_repeated_decision_shown_once(
        self,
    ) -> None:
        """The whole archived/other-kind guard, and it has to be here.

        The pool is per USER and the options are per BATCH (one kind, visible,
        non-archived), so an ineligible row is a normal thing to find in it. If
        it survived, the document would offer the model an example whose category
        is not even in the schema's enum — a key it cannot answer and must not be
        taught to want.

        The same pool pins the DEDUPE key, ``(text.casefold(), category_id)``: a
        user who shops at one place weekly has that decision in the pool many
        times, under whatever spelling each statement used. Repeating it would
        spend the count and character budgets on one merchant and crowd the rest
        of the user's categories out of the prompt. The newest spelling (the
        better-scoring row here) is the one that survives.
        """
        pool = _pool(
            ("Archived shop", ARCHIVED, 0.0),  # the best score in the pool
            ("BIEDRONKA", FOOD, 0.05),
            ("Biedronka", FOOD, 0.4),  # the same decision, another spelling
            ("Uber", TAXI, 1.2),
        )

        picked = select(pool, QUERY, category_ids=[FOOD, TAXI], limits=_limits())

        assert picked == (
            Example(text="BIEDRONKA", category_id=FOOD),
            Example(text="Uber", category_id=TAXI),
        )


class TestCoverage:
    def test_a_category_no_neighbour_names_still_gets_its_best_row(self) -> None:
        """Coverage is what makes a rare personal category reachable at all.

        With ``per_operation=1`` the similarity pass picks ONE row — a grocery
        one. Without the coverage pass the model would never see that "Подарки"
        is a thing this user uses, and a gift shop would land in the catch-all.
        The row it adds is that category's best, not an arbitrary one.
        """
        pool = _pool(
            ("Biedronka", FOOD, 0.0),
            ("Zabka", FOOD, 0.1),
            ("Gift shop far", GIFTS, 1.4),
            ("Gift shop near", GIFTS, 0.9),
        )

        picked = select(
            pool, QUERY, category_ids=[FOOD, GIFTS], limits=_limits(per_operation=1)
        )

        assert picked == (
            Example(text="Biedronka", category_id=FOOD),
            Example(text="Gift shop near", category_id=GIFTS),
        )


class TestCaps:
    def test_both_caps_bite_and_the_best_scoring_rows_survive(self) -> None:
        """The prompt's cost is bounded by a COUNT and by a CHARACTER budget.

        Both are per batch and the examples ride in every batch of every import,
        so each cap is asserted on its own: the count cap cuts the tail of a long
        pool, and the character budget stops the scan even when the count would
        allow more. What survives is the top of the score order in both cases.
        """
        pool = _pool(*[(f"shop {index:02d}", FOOD, index * 0.1) for index in range(10)])

        by_count = select(
            pool,
            QUERY,
            category_ids=[FOOD],
            limits=_limits(per_operation=10, max_examples=3),
        )
        # "shop 00" is 7 characters: three fit in 25, the fourth does not.
        by_chars = select(
            pool,
            QUERY,
            category_ids=[FOOD],
            limits=_limits(per_operation=10, max_chars=25),
        )

        assert [example.text for example in by_count] == [
            "shop 00",
            "shop 01",
            "shop 02",
        ]
        assert [example.text for example in by_chars] == [
            "shop 00",
            "shop 01",
            "shop 02",
        ]
