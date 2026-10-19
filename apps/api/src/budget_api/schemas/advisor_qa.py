"""``POST /advisor/qa`` — the cited Q&A request and response (rag §7).

Imports the hit and the total from ``schemas/tx_search.py`` and never the other
way round: the Q&A is a CONSUMER of retrieval. ``citations`` is literally
``TransactionSearchHit`` (ruling ASK-2), so one client component renders a search
result row and a citation, and the total is literally ``SearchTotal`` over the
RETRIEVED rows in the profile base currency (ruling ASK-3) — the server's number
is the only sum anybody may trust, including when the answer text quotes a figure.

``question``'s caps are the ``AdvisorAsk`` ones and they are plain Pydantic, so a
blank question is an ``HTTPValidationError`` here while a blank ``q`` on
``GET /transactions/search`` is the business code ``SEARCH_QUERY_BLANK``. That
asymmetry is deliberate (ruling on open Q2): a query PARAMETER cannot carry a
strip-then-reject validator, and inventing a second business code for the body
would make the web handle two shapes for one mistake.
"""

import uuid
from datetime import date

from pydantic import BaseModel, Field, field_validator

from budget_api.enums import TransactionKind
from budget_api.schemas.advisor import QUESTION_MAX
from budget_api.schemas.tx_search import SearchTotal, TransactionSearchHit


class AdvisorQaAsk(BaseModel):
    """One question plus the retrieval window it should be answered over."""

    question: str
    #: ``limit``, never ``k`` (amendment A6) — the same name and the same bounds
    #: as the search route's, so "how many operations" means one thing.
    limit: int = Field(default=20, ge=1, le=50)
    #: The filter subset the search route takes, minus ``category_id`` and
    #: ``country``: v1's web surface offers no control for any of them (the
    #: narrowing is the search mode's job), and these four are the ones a
    #: follow-up form would plausibly grow first.
    from_: date | None = Field(default=None, alias="from")
    to: date | None = None
    account_id: uuid.UUID | None = None
    kind: TransactionKind | None = None

    @field_validator("question")
    @classmethod
    def _clean_question(cls, v: str) -> str:
        """Trim; blank is an ERROR; cap AFTER the trim — the ``AdvisorAsk`` rule.

        A blank question cannot degrade to "no question": it would be a paid
        no-op on the provider, and here it would also be a retrieval over an
        empty phrase.
        """
        v = v.strip()
        if not v:
            raise ValueError("question must not be blank")
        if len(v) > QUESTION_MAX:
            raise ValueError(f"question must be at most {QUESTION_MAX} characters")
        return v


class AdvisorQaRead(BaseModel):
    """The answer, its verified citations, and the server's total.

    ``answer`` is null for EXACTLY ONE reason: nothing was retrieved, so no model
    was called (ruling ASK-4 / D-Q3). ``answer: null`` ⇔
    ``retrieved_count == 0``. A NON-null answer with an EMPTY ``citations`` list
    is a legal, ordinary outcome — the model answered without relying on any one
    row ("these operations say nothing about that") — and must not be rendered as
    the nothing-found arm.
    """

    answer: str | None
    #: The subset of what was retrieved that the answer actually relies on, in
    #: the order the model first named them. Verified server-side: a key that
    #: was never retrieved, or named twice, is dropped before this list exists.
    citations: list[TransactionSearchHit]
    #: How many references the verifier refused — the GROUNDEDNESS signal
    #: (D-Q5). Not an error: the answer stands, the bad reference does not.
    dropped_citations: int
    #: How many operations the retrieval found for this question. The
    #: denominator of "N of M retrieved" and the only cause of a null answer.
    retrieved_count: int
    #: Over the RETRIEVED rows (all of them, not only the cited ones), in the
    #: profile base currency — the same schema the search route returns.
    total: SearchTotal
    #: Provenance of the answer: who answered, with which model, under which
    #: prompt version. Stored nowhere — the log line is the call record.
    provider: str
    model: str
    prompt_version: str


class QaError(BaseModel):
    """The 422/429/503 envelope — one ``detail`` string code, as everywhere."""

    detail: str
