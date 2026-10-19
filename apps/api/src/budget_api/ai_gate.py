"""Shared "is the AI available?" HTTP guards (architecture D11).

Three gates now live here, and the reason they share a module is that they share
a SHAPE: an unkeyed ``Depends`` that answers 503 with one string code, declared
after the auth dependency so an anonymous request is still 401. What they ask
differs — a key (:func:`require_ai_configured`), a provider on ``app.state``
(:func:`require_llm_provider`), an embedder on ``app.state``
(:func:`require_embedder`) — and each keeps its own code string because the
operator's fix and the web's copy differ per cause.

Top-level shared-router-helper slot (the ``category_access.py`` placement
rationale): this is an HTTP guard over ``Settings``, not an integration seam, and
it imports only ``config`` + FastAPI, so no router imports another router to get
it.

ONE key, ONE configured/not state: ``anthropic_api_key`` is shared by the receipt
parse pipeline and the advisor, so both answer the same
``503 AI_NOT_CONFIGURED`` for the same reason.

Two call forms, deliberately:

* the receipts parse route calls it **inline** at the exact statement position of
  its former inline block — as a route dependency it would resolve BEFORE the
  endpoint's own parameters, so an unauthenticated parse on an unkeyed server
  would answer 503 instead of today's 401, and slowapi's wrapper (which today
  counts that 503 against the parse quota) would stop seeing it;
* the advisor route (new code, no shipped behaviour to preserve) uses
  ``Depends(require_ai_configured)`` and takes the better order — an unkeyed 503
  consumes no advisor quota.
"""

from fastapi import HTTPException, Request, status

from budget_api.config import Settings


async def require_ai_configured(request: Request) -> None:
    """503 ``AI_NOT_CONFIGURED`` when no Anthropic key is configured (D11)."""
    settings: Settings = request.app.state.settings
    if not settings.anthropic_api_key:
        # Fail fast in-request, never as a background failure (D10).
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AI_NOT_CONFIGURED",
        )


async def require_llm_provider(request: Request) -> None:
    """503 ``AI_NOT_CONFIGURED`` when there is no provider on ``app.state``.

    The SECOND gate and not a rewrite of the first (pdf-reconcile D-C1): the
    guard above asks about ``anthropic_api_key``, which is EMPTY on a server
    running ``LLM_PROVIDER=fake`` or ``ollama`` — a QA stand or a local model
    would answer 503 for a provider it has. What the provider-seam features
    (the Alfa extraction, the reconcile loop) actually need is
    ``app.state.llm``, which ``llm.registry.provider_from_settings`` leaves
    ``None`` for every not-configured spelling at once.

    Same code string on purpose, so the web's existing "AI is not configured"
    copy applies to both (amendment A6).
    """
    if getattr(request.app.state, "llm", None) is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AI_NOT_CONFIGURED",
        )


async def require_embedder(request: Request) -> None:
    """503 ``EMBEDDINGS_NOT_AVAILABLE`` when this server has no embedder (rag D-M6).

    The same shape as the two gates above and a DIFFERENT string on purpose: a
    missing embedding artifact is not a missing API key. One is "the operator
    traded 510 MB of RAM for search" or "the model file did not verify at boot",
    the other is "nobody configured an LLM" — the web copy differs, the fix
    differs, and a shared code would make the two indistinguishable on screen.

    ``getattr`` with a default rather than ``app.state.embedder``: a Starlette
    state read of an unset attribute raises, and a route must answer 503 on a
    server built before this seam existed too.
    """
    if getattr(request.app.state, "embedder", None) is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="EMBEDDINGS_NOT_AVAILABLE",
        )
