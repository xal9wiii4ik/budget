"""Advisor request DTO + the error envelope (D9).

Chat memory is CLIENT-CARRIED (OQ-2 default, confirmed at grooming): there is no
chat table and no server-side session, so the whole conversation arrives on every
ask. That makes the caps below the only thing standing between a runaway client
and an unbounded Anthropic bill, which is why they live in the schema (where they
are declared contract) rather than in the router.

All three caps are plain Pydantic validation, so they surface as
``HTTPValidationError`` and the route declares NO business 422 arm (backend
Disagreement 3, upheld at R1): declaring an ``AdvisorError`` 422 the route can
never emit would be the AM-5 "the generated type lies about one arm" failure,
inverted. ``AdvisorError`` is still the declared model of the 429 and 503 arms.
"""

from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

#: Cap on ONE question, applied AFTER stripping (a wall of whitespace is not a
#: 2000-character question).
QUESTION_MAX = 2000
#: Cap on ONE carried turn, and on the sum of all of them. A turn is a model answer
#: or a past question, so the per-turn bound is generous; the SUM is the one that
#: actually bounds the prompt, since ten maxed-out turns would be 80k characters.
TURN_MAX = 8000
HISTORY_MAX_TURNS = 10
HISTORY_MAX_CHARS = 8000


class AdvisorTurn(BaseModel):
    """One replayed turn. ``role`` is the Anthropic role, not a user role."""

    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=TURN_MAX)


class AdvisorAsk(BaseModel):
    question: str
    # ``list[AdvisorTurn]`` (not bare ``list``) as the factory: it is the same empty
    # list at runtime, and it keeps the element type known under pyright strict.
    history: list[AdvisorTurn] = Field(
        default_factory=list[AdvisorTurn], max_length=HISTORY_MAX_TURNS
    )

    @field_validator("question")
    @classmethod
    def _clean_question(cls, v: str) -> str:
        """Trim; blank is an ERROR (not silently dropped); cap AFTER the trim.

        Unlike ``clean_note``, a blank here cannot degrade to ``None``: an empty
        question would be sent to Anthropic as a paid no-op.
        """
        v = v.strip()
        if not v:
            raise ValueError("question must not be blank")
        if len(v) > QUESTION_MAX:
            raise ValueError(f"question must be at most {QUESTION_MAX} characters")
        return v

    @model_validator(mode="after")
    def _cap_history_size(self) -> "AdvisorAsk":
        total = sum(len(turn.content) for turn in self.history)
        if total > HISTORY_MAX_CHARS:
            raise ValueError(
                f"history must be at most {HISTORY_MAX_CHARS} characters in total"
            )
        return self


class AdvisorError(BaseModel):
    """The 503 ``AI_NOT_CONFIGURED`` / 429 ``RATE_LIMITED`` envelope.

    Mirrors ``ReceiptError``/``StatsError``: one ``detail`` string code across the
    API. NOT the shape of a mid-stream failure — that is an SSE ``error`` frame
    inside a 200 (see the route's response description).
    """

    detail: str
