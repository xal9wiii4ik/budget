"""Shared "is the AI configured?" HTTP guard (architecture D11).

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
