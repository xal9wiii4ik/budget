"""AI advisor: one streaming ask over the user's own aggregates (D7/D9/D10).

``POST /advisor/ask`` assembles the whole :class:`AdvisorContext` from the SAME
shared aggregates the /stats screens and the goals screen read — no advisor-only
query, no second definition of "spending in a window" — and then streams the
model's answer back as Server-Sent Events.

Two orderings in this file are load-bearing and both are pinned by tests:

1. **auth → gate → session** in the handler signature. FastAPI solves dependencies
   in signature order, so this is what makes an unauthenticated ask answer 401 even
   on an unkeyed server (the B1 carry-forward), and what keeps the
   ``AI_NOT_CONFIGURED`` 503 OUT of the ask quota — the gate resolves before
   slowapi's wrapper, which wraps the endpoint itself (backend Disagreement 1,
   upheld at R1: an unkeyed server must keep answering "ключ не настроен" rather
   than "RATE_LIMITED" on the second click).
2. **All DB work happens BEFORE the ``StreamingResponse`` is returned.** FastAPI
   (>=0.106) exits ``yield`` dependencies before the response body is streamed, so
   the ``get_session`` session is already closed when the generator runs. The
   generator therefore closes over a frozen dataclass and the seam only — it holds
   no session and no ORM instance. A violation is not a failing assertion, it is a
   greenlet crash halfway through a 200 that has already been sent.

The stream itself never fails the request: a model/SDK failure from ANY position
(including before the first delta) is the terminal ``error`` frame inside the same
200. The client has to handle that arm anyway, and buying one status code would
mean holding the response open until the first byte of the answer arrives.
"""

import asyncio
import json
import logging
import uuid
from collections.abc import AsyncIterator, Sequence
from datetime import UTC, date, datetime
from typing import Any

from fastapi import APIRouter, Depends, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.ai_gate import require_ai_configured
from budget_api.category_access import visible_categories_clause
from budget_api.db import get_session
from budget_api.domain.periods import shift_month
from budget_api.enums import TransactionKind
from budget_api.models import Category, Profile, User
from budget_api.rate_limit import (
    advisor_ask_limit_value,
    limiter,
    rate_limit_exempt,
    stash_rl_user,
    user_rl_key,
)
from budget_api.schemas.advisor import AdvisorAsk, AdvisorError
from budget_api.services.advisor import Advisor, AdvisorContext, Turn

# The seam's exception and the wire envelope share a name by design (the envelope's
# name is the generated TS symbol, the exception's name is the seam's contract), so
# the failure arm is aliased here rather than either being renamed.
from budget_api.services.advisor import AdvisorError as AdvisorStreamError
from budget_api.services.advisor_context import (
    ADVISOR_WINDOW_MONTHS,
    advisor_window,
    build_advisor_context,
)
from budget_api.services.goal_reads import assemble_goal_reads, load_goals_ordered
from budget_api.services.profile_reads import read_base_currency
from budget_api.services.tx_totals import (
    converted_totals,
    merchant_converted_totals,
    monthly_converted_totals,
)

logger = logging.getLogger(__name__)

router = APIRouter()

#: Same cut as ``GET /stats/top-merchants``' default — the prompt wants the shape of
#: the spending, not its long tail.
_TOP_MERCHANTS = 10

_ADVISOR_ERR: dict[str, object] = {"model": AdvisorError}

#: The SSE grammar, verbatim in the contract: the generated client's only source of
#: truth for the frames, since a stream body has no schema to generate from.
_SSE_DESCRIPTION = (
    "Server-Sent Events stream of the answer. Frames:\n\n"
    '- `event: delta` / `data: {"text": "..."}` — 0..n answer chunks; `data` is\n'
    "  always ONE line of JSON, so a chunk may contain newlines and quotes.\n"
    "- `event: done` / `data: {}` — terminal frame on success.\n"
    '- `event: error` / `data: {"detail": "ANTHROPIC_ERROR"}` — terminal frame on\n'
    "  failure, from any position INCLUDING before the first delta.\n\n"
    "Exactly one terminal frame is emitted. The HTTP status is 200 in every case;\n"
    "a failed answer is the `error` frame, never a 5xx."
)

# slowapi's Limiter.limit is typed to return a bare Callable (Unknown), which trips
# pyright-strict reportUnknownMemberType; route the decorator through an Any alias so
# the partial type stays contained here (the receipts/auth routers do the same).
_limiter_any: Any = limiter


def _today() -> date:
    return datetime.now(UTC).date()


def _frame(event: str, data: dict[str, object]) -> str:
    """One SSE frame. ``data`` is ONE line of JSON — always.

    A model answer is full of newlines, and a raw-text SSE payload would split at
    every one of them into separate (and, after the blank line, meaningless)
    frames. ``ensure_ascii=False`` keeps the Russian answer readable on the wire;
    the response is UTF-8.
    """
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


async def _category_names(
    session: AsyncSession, user_id: uuid.UUID
) -> dict[uuid.UUID, str]:
    """id → name for every category visible to the user, INCLUDING archived ones.

    An archived category still owns its history, so its spending is still in the
    window's buckets; without it here that bucket would degrade to
    "Без категории" and the advisor would talk about the wrong thing. (The receipts
    prompt excludes archived for the opposite and equally correct reason: it is
    picking a category for a NEW transaction.)
    """
    rows = await session.execute(
        select(Category.id, Category.name).where(visible_categories_clause(user_id))
    )
    return {row.id: row.name for row in rows.all()}


async def _build_context(
    session: AsyncSession, user_id: uuid.UUID, *, today: date
) -> AdvisorContext:
    """Everything the model may know, read in one place, BEFORE the stream starts.

    The window is the 3 last FULL calendar months (``advisor_window``); the monthly
    series is aligned to exactly that window by ending at the last full month
    (``monthly_converted_totals`` includes its ``ending_first`` month), so the
    series and the period totals describe the same rows rather than two windows
    that drift apart.
    """
    window_from, window_to_exclusive = advisor_window(today)
    base = await read_base_currency(session, user_id)
    # The income COLUMN, not the Profile instance: a plain scalar cannot lazy-load
    # anything later, when the session is gone (see the module docstring).
    monthly_income_minor = await session.scalar(
        select(Profile.monthly_income_minor).where(Profile.user_id == user_id)
    )
    months = await monthly_converted_totals(
        session,
        user_id,
        base,
        months=ADVISOR_WINDOW_MONTHS,
        ending_first=shift_month(window_to_exclusive, -1),
    )
    totals = await converted_totals(
        session, user_id, base, window_from, window_to_exclusive
    )
    merchants = await merchant_converted_totals(
        session,
        user_id,
        base,
        window_from,
        window_to_exclusive,
        kind=TransactionKind.expense,
        limit=_TOP_MERCHANTS,
    )
    # Non-archived goals only: an archived goal is one the user put aside, and
    # advice about it would be advice about a decision already made.
    goals = await load_goals_ordered(session, user_id, include_archived=False)
    portfolio = await assemble_goal_reads(session, user_id, goals, today=today)
    return build_advisor_context(
        base_currency=base,
        monthly_income_minor=monthly_income_minor,
        window_from=window_from,
        window_to_exclusive=window_to_exclusive,
        months=months,
        totals=totals,
        category_names=await _category_names(session, user_id),
        merchants=merchants,
        goals=portfolio.items,
    )


async def _events(
    advisor: Advisor,
    question: str,
    history: Sequence[Turn],
    context: AdvisorContext,
) -> AsyncIterator[str]:
    """The SSE body: deltas, then EXACTLY ONE terminal frame. Never raises.

    Touches no session and no ORM object — by the time this runs, FastAPI has
    already closed the request's session (module docstring).
    """
    try:
        async for delta in advisor.stream_advice(question, history, context):
            yield _frame("delta", {"text": delta})
    except asyncio.CancelledError:
        # A client disconnect must CLOSE this generator, never be answered with a
        # frame nobody is reading. Stated explicitly (it is a BaseException, so the
        # arm below could not catch it today) so that broadening that arm later
        # cannot silently start swallowing disconnects.
        raise
    except AdvisorStreamError as exc:
        logger.warning("advisor stream ended with %s", exc.code)
        yield _frame("error", {"detail": exc.code})
        return
    yield _frame("done", {})


@router.post(
    "/ask",
    # The handler returns a StreamingResponse; there is no response model to
    # declare, and response_class keeps FastAPI from advertising a JSON 200 arm
    # this route can never emit (O-8).
    response_model=None,
    response_class=StreamingResponse,
    responses={
        status.HTTP_200_OK: {
            "description": _SSE_DESCRIPTION,
            "content": {"text/event-stream": {"schema": {"type": "string"}}},
        },
        status.HTTP_429_TOO_MANY_REQUESTS: _ADVISOR_ERR,
        status.HTTP_503_SERVICE_UNAVAILABLE: _ADVISOR_ERR,
    },
)
@_limiter_any.limit(
    advisor_ask_limit_value,
    key_func=user_rl_key("advisor"),
    exempt_when=rate_limit_exempt,
)
async def ask_advisor(
    request: Request,
    payload: AdvisorAsk,
    # PARAMETER ORDER IS LOAD-BEARING (see the module docstring): auth first, so an
    # unauthenticated request is 401 and not 503; the gate second, so an unkeyed
    # server spends no quota and does no DB work.
    user: User = Depends(stash_rl_user),
    _gate: None = Depends(require_ai_configured),
    session: AsyncSession = Depends(get_session),
) -> StreamingResponse:
    advisor: Advisor = request.app.state.advisor
    context = await _build_context(session, user.id, today=_today())
    history = tuple(
        Turn(role=turn.role, content=turn.content) for turn in payload.history
    )
    # Every argument below is a plain value: the generator is handed nothing that
    # could touch the (by then closed) session.
    return StreamingResponse(
        _events(advisor, payload.question, history, context),
        media_type="text/event-stream",
        # A conversation answer is per-user and single-use; no cache, no proxy copy.
        headers={"Cache-Control": "no-store"},
    )
