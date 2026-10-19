"""``GET /transactions/search`` — the semantic half of the transactions surface.

Its OWN router, mounted at ``/transactions`` BEFORE ``routers/transactions.py``
(app.py), and both halves of that are load-bearing:

* it owns the STATIC segment ``/search``, and a router mounted after one that
  declares ``/{transaction_id}`` could never win that path — the route-order
  landmine of backend.md, settled the ``goal_items`` way;
* ``routers/transactions.py`` stays byte-identical, mount comment included: that
  router promises it never calls ``limiter.limit`` and is therefore mounted
  unprimed, while this route IS per-user limited and its mount carries
  ``Depends(prime_rate_limit)`` (an unprimed limiter check answers 500).

Three orderings here are decisions, not style, and each has a test:

1. **auth → ``require_embedder`` → limiter → session** in the signature. An
   anonymous request is 401 even on a server with no model, and the 503 resolves
   BEFORE slowapi's wrapper, so a server without an artifact keeps answering
   "search not available" rather than ``RATE_LIMITED`` on the second click (the
   ai-layer R1 ruling).
2. **``@router.get`` → ``@limiter.limit`` → ``@mcp_tool`` immediately above
   ``async def``.** The marker is read off the handler function; a limiter
   wrapper between it and the route would hide it, and the tool would vanish
   fail-closed and in silence.
3. **``q`` is stripped and a blank is a 422**, not an absent filter. Every row
   contains the empty string, so a blank query would "match" the whole ledger at
   score zero — the one read parameter in this family that refuses rather than
   matching nothing (``read_filters``' rule holds for the rest).

A foreign or unknown ``account_id``/``category_id`` is NOT refused: it matches no
row, and the body is byte-identical to the one a filter matching nothing
produces. That is the no-oracle rule for a read.
"""

import uuid
from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.ai_gate import require_embedder
from budget_api.config import Settings
from budget_api.db import get_session
from budget_api.embeddings import Embedder
from budget_api.enums import TransactionKind
from budget_api.mcp import prose
from budget_api.mcp.decorator import mcp_tool
from budget_api.models import User
from budget_api.pat_auth import current_user_jwt_or_pat
from budget_api.rate_limit import (
    limiter,
    rate_limit_exempt,
    search_limit_value,
    search_rl_key,
)
from budget_api.schemas.transaction import COUNTRY_PATTERN
from budget_api.schemas.tx_search import (
    SearchError,
    SearchTotal,
    TransactionSearchHit,
    TransactionSearchRead,
)
from budget_api.services.profile_reads import read_base_currency
from budget_api.services.tx_read_query import read_filters
from budget_api.services.tx_search import search
from budget_api.transaction_wire import serialize_transaction

router = APIRouter()

#: Cap on the phrase. A question, not a document: the model truncates at 128
#: tokens anyway, so anything past this is bytes nobody embeds.
QUERY_MAX = 500

_SEARCH_ERR: dict[str, object] = {"model": SearchError}
_RATE_LIMITED: dict[int | str, dict[str, object]] = {
    status.HTTP_429_TOO_MANY_REQUESTS: _SEARCH_ERR
}
_UNAVAILABLE: dict[int | str, dict[str, object]] = {
    status.HTTP_503_SERVICE_UNAVAILABLE: _SEARCH_ERR
}
# The honest anyOf union (AM-5): this route emits BOTH its own string code and
# FastAPI's auto Pydantic array. HTTPValidationError is referenced, never
# hand-declared.
_UNPROCESSABLE: dict[int | str, dict[str, object]] = {
    status.HTTP_422_UNPROCESSABLE_CONTENT: {
        "description": "Business rule rejection (string code) or validation error",
        "content": {
            "application/json": {
                "schema": {
                    "anyOf": [
                        {"$ref": "#/components/schemas/SearchError"},
                        {"$ref": "#/components/schemas/HTTPValidationError"},
                    ]
                }
            }
        },
    }
}

# slowapi's Limiter.limit is typed to return a bare Callable (Unknown), which trips
# pyright-strict reportUnknownMemberType; route the decorator through an Any alias
# so the partial type stays contained here (the receipts/advisor containment).
_limiter_any: Any = limiter


async def _stash_rl_user(
    request: Request, user: User = Depends(current_user_jwt_or_pat)
) -> User:
    """``rate_limit.stash_rl_user`` for a PAT-reachable route — three lines, local.

    The shared stash is JWT-only (``current_active_user``), and making it
    PAT-aware would have ``rate_limit`` import ``pat_auth``, which imports the
    limiter: an import cycle. So the stash that needs the other dependency lives
    with the route that needs it, exactly as the statement-import router keeps
    its JWT-only one.
    """
    request.state.rl_user_id = str(user.id)
    return user


@router.get(
    "/search",  # BEFORE transactions.router's /{transaction_id} (module docstring)
    response_model=TransactionSearchRead,
    responses={**_UNPROCESSABLE, **_RATE_LIMITED, **_UNAVAILABLE},
)
@_limiter_any.limit(
    search_limit_value, key_func=search_rl_key, exempt_when=rate_limit_exempt
)
@mcp_tool(
    name="search_transactions",
    description=(
        "Find the user's transactions BY MEANING, not by exact text: the server "
        "embeds your phrase and ranks their operations by how close they are to "
        "it, across Russian, Polish and English alike. Ask it the way the user "
        'asked you — "расходы на машину", "apteka", "gifts in Poland" — and '
        "it finds the rows whose merchant, note, category, country or account say "
        "that, even when none of them contains your words. For an exact substring "
        "(a merchant name you already know, a reference number) use "
        "list_transactions with `q` instead; that is the literal-text tool, this "
        "one is the semantic one.\n\n"
        "`score` is a raw closeness number, and it is RELATIVE INSIDE ONE ANSWER: "
        "real results sit in a narrow band and the gap between a right and a wrong "
        "row can be 0.006, so a high score is not a quality guarantee and a low "
        "one is not a rejection. Compare the rows against each other and against "
        "what the user asked; never present a score to the user and never filter "
        "on it unless they gave you a threshold.\n\n"
        "Use the `total` the server returns instead of adding the rows up "
        "yourself: it is already converted to the user's base currency and it "
        "counts exactly the rows listed. `pending_count` above zero means some "
        "recent operations are not searchable yet (they are still being indexed) "
        "and may be missing from this answer — say so rather than concluding they "
        "do not exist. Transfers between the user's own accounts and debt "
        "movements are never searchable here at all; read those through "
        "list_transactions, list_debts and get_debt."
    ),
    params={
        "q": (
            "What to look for, in the user's own words: a thing, a place, a "
            'purpose ("машина", "аптека", "prezenty", "coffee in Berlin"). '
            "A short phrase works better than a long sentence, and amounts and "
            "dates do nothing here — they are not part of what is indexed, so use "
            "`from`/`to` for a period and read the amounts off the rows."
        ),
        "limit": (
            "How many of the closest rows to return, 1 to 50 (20 by default). "
            "There is no paging: a bigger number is the only way to see further "
            "down the ranking."
        ),
        "from": "Start date (inclusive) as YYYY-MM-DD.",
        "to": "End date (inclusive) as YYYY-MM-DD.",
        "category_id": "Only this category; take the id from list_categories.",
        "kind": (
            "Only expenses or only income. `transfer` is accepted and always "
            "answers an empty list — a move between the user's own accounts is "
            "neither spending nor earning and is deliberately not indexed."
        ),
        "account_id": (
            prose.ACCOUNT_ID
            + " Narrows the search to what happened on that ONE account."
        ),
        "country": prose.TX_COUNTRY_FILTER,
        "min_score": (
            "Drop results below this closeness, 0 to 1. LEAVE IT OUT unless the "
            "user asked for a stricter answer: the band real results fall in is "
            "narrow, so a guessed threshold removes correct rows and tells you "
            "nothing about the ones it keeps."
        ),
    },
)
async def search_transactions(
    request: Request,
    q: str = Query(max_length=QUERY_MAX),
    #: ``limit``, never ``k`` (amendment A6): the ``GET /transactions`` spelling.
    limit: int = Query(default=20, ge=1, le=50),
    from_: date | None = Query(default=None, alias="from"),
    to: date | None = Query(default=None, alias="to"),
    category_id: uuid.UUID | None = None,
    kind: TransactionKind | None = None,
    account_id: uuid.UUID | None = None,
    # Format-validated at the edge, like the list route's: a malformed value is a
    # 422 before a query is built. Nothing is normalized (see read_filters).
    country: str | None = Query(default=None, pattern=COUNTRY_PATTERN),
    #: The honest full range (open Q1): real cosines sit in 0.78..0.87, but the
    #: band is a property of one artifact, not of the API.
    min_score: float | None = Query(default=None, ge=0, le=1),
    # PARAMETER ORDER IS LOAD-BEARING (module docstring): auth, then the 503
    # gate, then the limiter's wrapper, then the session.
    user: User = Depends(_stash_rl_user),
    _gate: None = Depends(require_embedder),
    session: AsyncSession = Depends(get_session),
) -> TransactionSearchRead:
    """Rank the user's operations by MEANING against ``q``, with a server total.

    The filters are the ones ``GET /transactions`` takes (minus ``q``, ``sort``
    and ``goal_item_id``) and they are built by the same shared function, so a
    period or a country means exactly what it means on the list. Order is by
    closeness, best first — there is no ``sort`` here and no paging; ``limit``
    (1..50) is how far down the ranking the answer goes.

    ``score`` is a raw cosine and is comparable only WITHIN one answer.
    ``total`` is computed by the server over exactly the returned rows, in the
    base currency, with rows it could not convert counted rather than summed as
    zero. ``pending_count`` above zero means some of the user's recent operations
    are still being indexed and may be missing from the answer.

    Transfers and debt movements are not indexed at all (they are not income and
    not expense), so ``kind=transfer`` answers an empty list on purpose.
    """
    phrase = q.strip()
    if not phrase:
        # Not "filter absent" (the ``?q=`` rule on the list route): a semantic
        # search with nothing to be close to has no answer to give, and every
        # row would score zero against it.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="SEARCH_QUERY_BLANK",
        )
    settings: Settings = request.app.state.settings
    embedder: Embedder | None = getattr(request.app.state, "embedder", None)
    if embedder is None:  # pragma: no cover - the dependency already refused
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="EMBEDDINGS_NOT_AVAILABLE",
        )

    base = await read_base_currency(session, user.id)
    result = await search(
        session,
        embedder,
        user_id=user.id,
        base=base,
        query=phrase,
        limit=limit,
        filters=read_filters(
            user.id, from_, to, category_id, kind, account_id, country=country
        ),
        min_score=min_score,
        max_candidates=settings.search_max_candidates,
        max_refresh=settings.search_max_refresh,
        batch_size=settings.embeddings_batch_size,
    )
    return TransactionSearchRead(
        items=[
            TransactionSearchHit(
                transaction=serialize_transaction(hit.transaction), score=hit.score
            )
            for hit in result.hits
        ],
        total=SearchTotal.from_rows(result.total, base),
        pending_count=result.pending_count,
        candidates=result.candidates,
        model=result.model,
    )
