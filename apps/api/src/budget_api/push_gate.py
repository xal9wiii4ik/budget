"""Shared "is web push configured?" HTTP guard (web-push architecture §6).

The ``ai_gate.py`` shape, next to it: an HTTP guard over an ``app.state`` seam,
importing only FastAPI and the seam's type, so no router imports another router
to get it. Unlike the AI gate it asks the SENDER rather than ``Settings``:
"configured" means the whole VAPID trio, and ``PushSender.enabled`` is the one
place that rule is written.

Used as ``Depends(require_push_configured)`` declared AFTER the user dependency,
so an unauthenticated call answers 401 even on a keyless server, and the 503
resolves before slowapi's wrapper (an unkeyed server spends no /push/test quota).
"""

from fastapi import HTTPException, Request, status

from budget_api.services.push_sender import PushSender


async def require_push_configured(request: Request) -> None:
    """503 ``PUSH_NOT_CONFIGURED`` while the VAPID trio is incomplete (§2)."""
    sender: PushSender = request.app.state.push_sender
    if not sender.enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="PUSH_NOT_CONFIGURED",
        )
