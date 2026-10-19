"""``POST /advisor/qa`` — one question, one answer, citations that resolve.

Its OWN module beside ``routers/advisor.py``, mounted on the same ``/advisor``
prefix. The streaming chat is the Anthropic-streaming seam (SSE frames, a
generator that outlives the request's session, no JSON 200 arm at all) and this
is a plain structured call over the provider seam; the ai-layer scope split those
two for exactly this reason, and ``/qa`` vs ``/ask`` has no static-segment
conflict to settle.

NOT A TOOL — `# MCP: no — in MCP the client model IS the answerer; it already
has search_transactions, so publishing this would have one model pay to ask
another one the user's question`. The pair is pinned in
``tests/test_pat_auth.py::NEVER_PAT``, which pins exactly that: in the contract,
never in the derived allowlist.

Auth is the shared JWT-only ``rate_limit.stash_rl_user``, exactly as
``/advisor/ask`` has it: this is an AI-SPEND route, and both of them answer a
``bgt_pat_`` bearer with 401 — the JWT dependency rejects the token at the
decode, before the allowlist is consulted at all (the
``POST /receipts/{id}/parse`` shape). That is the stronger of the two refusals,
and it holds even if a future edit accidentally marked the route PAT-reachable.

Gate order in the signature is load-bearing and tested: auth (401 even on a
server with neither an LLM nor a model) → ``require_llm_provider``
(503 ``AI_NOT_CONFIGURED``) → ``require_embedder``
(503 ``EMBEDDINGS_NOT_AVAILABLE``) → the limiter's wrapper → the session. The AI
gate comes FIRST of the two because an unconfigured provider is the state the web
already has copy for, and both resolve before slowapi, so a refused request
spends no quota (the ai-layer R1 ruling).

Retrieval goes through ``services/tx_search.search`` — the SAME function the GET
uses — so "what was retrieved" has one definition, the citations are verified
against that set, and the total is the total of those rows. Zero hits is the one
arm that calls no model at all: ``answer: null``, ``citations: []``.
"""

import logging
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.ai_gate import require_embedder, require_llm_provider
from budget_api.config import Settings
from budget_api.db import get_session
from budget_api.domain.money import to_major_string
from budget_api.embeddings import Embedder
from budget_api.llm import LLMError, LLMProvider
from budget_api.models import Account, Category, Profile, Transaction, User
from budget_api.rate_limit import (
    advisor_qa_limit_value,
    advisor_qa_rl_key,
    limiter,
    rate_limit_exempt,
    stash_rl_user,
)
from budget_api.schemas.advisor_qa import AdvisorQaAsk, AdvisorQaRead, QaError
from budget_api.schemas.tx_search import SearchTotal, TransactionSearchHit
from budget_api.services.advisor_qa import (
    PROMPT_VERSION,
    QaOperation,
    QaTotal,
    answer_question,
)
from budget_api.services.profile_reads import read_base_currency
from budget_api.services.tx_read_query import read_filters
from budget_api.services.tx_search import Hit, search
from budget_api.transaction_wire import serialize_transaction

logger = logging.getLogger(__name__)

router = APIRouter()

#: The language the answer is written in when the profile names none — the
#: statement-reconcile default, for the same reason: this app's first user reads
#: Russian, and an unset preference is "not asked yet", not "English".
_DEFAULT_LANGUAGE = "ru"

#: Which ``LLMError`` codes mean "the provider, not the question". Everything
#: else is about the answer we got, so it is a 422 the user can retry (the
#: pdf-reconcile mapping).
_UNAVAILABLE_CODES = frozenset({"unavailable", "request_rejected"})

_QA_ERR: dict[str, object] = {"model": QaError}

# slowapi's Limiter.limit is typed to return a bare Callable (Unknown), which trips
# pyright-strict reportUnknownMemberType; route the decorator through an Any alias
# so the partial type stays contained here (the advisor/receipts containment).
_limiter_any: Any = limiter


# MCP: no — in MCP the client model IS the answerer and it already has
# search_transactions; publishing this tool would have one model pay for another
# model to answer the user's question, with the citations verified against a
# retrieval the client never sees.
@router.post(
    "/qa",
    response_model=AdvisorQaRead,
    responses={
        status.HTTP_422_UNPROCESSABLE_CONTENT: {
            "description": "Business rule rejection (string code) or validation error",
            "content": {
                "application/json": {
                    "schema": {
                        "anyOf": [
                            {"$ref": "#/components/schemas/QaError"},
                            {"$ref": "#/components/schemas/HTTPValidationError"},
                        ]
                    }
                }
            },
        },
        status.HTTP_429_TOO_MANY_REQUESTS: _QA_ERR,
        # THREE causes, one status (ruling ASK-5): AI_NOT_CONFIGURED (no
        # provider), EMBEDDINGS_NOT_AVAILABLE (no model to retrieve with) and
        # AI_UNAVAILABLE (the provider broke mid-answer). The web tells them
        # apart by the code and says three different things.
        status.HTTP_503_SERVICE_UNAVAILABLE: _QA_ERR,
    },
)
@_limiter_any.limit(
    advisor_qa_limit_value, key_func=advisor_qa_rl_key, exempt_when=rate_limit_exempt
)
async def ask_qa(
    request: Request,
    payload: AdvisorQaAsk,
    # PARAMETER ORDER IS LOAD-BEARING (module docstring).
    user: User = Depends(stash_rl_user),
    _ai: None = Depends(require_llm_provider),
    _embedder: None = Depends(require_embedder),
    session: AsyncSession = Depends(get_session),
) -> AdvisorQaRead:
    """Answer one question about the user's own operations, with citations.

    The server first RETRIEVES the operations closest in meaning to the question
    (the same search ``GET /transactions/search`` serves, with the same filters),
    then asks the model that one question over exactly those operations, then
    VERIFIES every reference it made: a citation that does not resolve to a
    retrieved operation is dropped and counted in ``dropped_citations``.

    ``total`` is the server's own sum over the retrieved operations in the base
    currency, and it is the only sum in the answer that was not written by a
    model. Nothing retrieved means no model call at all: ``answer`` is null,
    ``citations`` is empty. A non-null answer with NO citations is ordinary — the
    model answered without leaning on any single row.

    No history and no transcript in v1: each question is answered on its own.
    """
    settings: Settings = request.app.state.settings
    provider: LLMProvider | None = request.app.state.llm
    embedder: Embedder | None = getattr(request.app.state, "embedder", None)
    if provider is None or embedder is None:  # pragma: no cover - deps refused
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AI_NOT_CONFIGURED"
            if provider is None
            else "EMBEDDINGS_NOT_AVAILABLE",
        )

    base = await read_base_currency(session, user.id)
    result = await search(
        session,
        embedder,
        user_id=user.id,
        base=base,
        query=payload.question,
        limit=payload.limit,
        filters=read_filters(
            user.id,
            payload.from_,
            payload.to,
            None,
            payload.kind,
            payload.account_id,
        ),
        min_score=None,
        max_candidates=settings.search_max_candidates,
        max_refresh=settings.search_max_refresh,
        batch_size=settings.embeddings_batch_size,
    )
    total = SearchTotal.from_rows(result.total, base)
    if not result.hits:
        # NO model call (D-Q3): there is nothing to answer FROM, and the server
        # writes no prose of its own — the client renders its own copy.
        return AdvisorQaRead(
            answer=None,
            citations=[],
            dropped_citations=0,
            retrieved_count=0,
            total=total,
            provider=provider.name,
            model=provider.model,
            prompt_version=PROMPT_VERSION,
        )

    keyed = {f"o{index}": hit for index, hit in enumerate(result.hits, start=1)}
    language = await session.scalar(
        select(Profile.language).where(Profile.user_id == user.id)
    )
    try:
        answered = await answer_question(
            provider,
            question=payload.question,
            language=language or _DEFAULT_LANGUAGE,
            base_currency=base,
            total=QaTotal.from_minor(
                income_minor=result.total.income_minor,
                expense_minor=result.total.expense_minor,
                currency=base,
                unconverted_count=result.total.unconverted_count,
            ),
            operations=await _operations(session, keyed, user_id=user.id),
            user_id=str(user.id),
        )
    except LLMError as exc:
        # Logged by CODE only: an exception message can quote the request, i.e.
        # the user's own operations (the llm/usage.py rule).
        logger.warning("advisor qa failed: %s", exc.code)
        if exc.code in _UNAVAILABLE_CODES:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="AI_UNAVAILABLE",
            ) from exc
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="QA_FAILED"
        ) from exc

    return AdvisorQaRead(
        answer=answered.answer,
        citations=[_hit(keyed[key]) for key in answered.cited_keys],
        dropped_citations=answered.dropped,
        retrieved_count=len(result.hits),
        total=total,
        provider=provider.name,
        model=provider.model,
        prompt_version=PROMPT_VERSION,
    )


def _hit(hit: Hit) -> TransactionSearchHit:
    return TransactionSearchHit(
        transaction=serialize_transaction(hit.transaction), score=hit.score
    )


async def _operations(
    session: AsyncSession,
    keyed: dict[str, Hit],
    *,
    user_id: uuid.UUID,
) -> list[QaOperation]:
    """The retrieved rows as the prompt's flat text rows, keys in RANK order.

    The two JOINed names (category, account) are read in ONE query for the whole
    page rather than per row: the search already holds the transactions, and a
    lazy relationship load per hit would be ~50 round trips inside a request the
    user is waiting on — and would also be IO in a sync context on the async
    engine.
    """
    names = {
        row[0]: (row[1], row[2])
        for row in (
            await session.execute(
                select(Transaction.id, Category.name, Account.name)
                .join(Account, Account.id == Transaction.account_id)
                .join(Category, Category.id == Transaction.category_id, isouter=True)
                .where(
                    Transaction.user_id == user_id,
                    Transaction.id.in_([hit.transaction.id for hit in keyed.values()]),
                )
            )
        ).all()
    }
    operations: list[QaOperation] = []
    for key, hit in keyed.items():
        tx = hit.transaction
        category_name, account_name = names.get(tx.id, (None, None))
        operations.append(
            QaOperation(
                key=key,
                occurred_at=tx.occurred_at,
                kind=tx.kind,
                # The amount as SPENT, in the row's own currency: the base
                # snapshot is a display leg and the total is the server's.
                amount=to_major_string(tx.amount_minor, tx.currency),
                currency=tx.currency,
                merchant=tx.merchant,
                note=tx.note,
                category=category_name,
                country=tx.country,
                account=account_name,
                score=hit.score,
            )
        )
    return operations
