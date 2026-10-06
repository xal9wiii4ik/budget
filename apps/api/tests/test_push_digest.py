"""The digest's two pure rules: where a tap lands, and how a long list is cut.

Privacy (no amounts) and language choice are proven end-to-end through the job in
``test_push_jobs.py``; these two are pure branches the job tests cannot reach
one by one.
"""

import uuid
from datetime import date

from budget_api.domain.push_digest import DigestInput, GoalItemRef, Lang, build_digest

ON = date(2026, 8, 5)
GOAL_A = uuid.UUID("00000000-0000-0000-0000-00000000000a")
GOAL_B = uuid.UUID("00000000-0000-0000-0000-00000000000b")


def _input(
    *,
    goal_items: list[GoalItemRef] | None = None,
    charges: list[str] | None = None,
    deposits: list[str] | None = None,
    lang: Lang = "en",
) -> DigestInput:
    return DigestInput(
        goal_items=goal_items or [],
        charges=charges or [],
        deposits=deposits or [],
        lang=lang,
        on=ON,
    )


class TestDigest:
    def test_url_opens_the_screen_of_the_only_family_else_the_shared_one(self) -> None:
        one_goal = [
            GoalItemRef(GOAL_A, "Car", "Tyres"),
            GoalItemRef(GOAL_A, "Car", "Oil"),
        ]
        two_goals = [
            GoalItemRef(GOAL_A, "Car", "Tyres"),
            GoalItemRef(GOAL_B, "Trip", "Visa"),
        ]

        urls = [
            build_digest(item).url
            for item in (
                _input(goal_items=one_goal),
                _input(goal_items=two_goals),
                _input(charges=["Rent"]),
                _input(deposits=["Savings"]),
                _input(goal_items=one_goal, deposits=["Savings"]),
            )
        ]

        assert urls == [
            f"/goals/{GOAL_A}",
            "/goals",
            "/recurring",
            "/deposits",
            "/transactions",
        ]

    def test_body_spells_out_three_names_and_counts_the_rest(self) -> None:
        three = ["Rent", "Gym", "Phone"]
        five = [*three, "Water", "Power"]

        exact = build_digest(_input(charges=three))
        ru = build_digest(_input(charges=five, lang="ru"))
        en = build_digest(_input(charges=five))

        assert exact.body == "Rent, Gym, Phone"
        assert ru.body == "Rent, Gym, Phone и ещё 2"
        assert en.body == "Rent, Gym, Phone and 2 more"
        assert (ru.title, en.title) == ("Скоро", "Coming up")
        assert en.tag == "budget-reminder-2026-08-05"
