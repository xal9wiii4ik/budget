"""OAuthRefreshToken — the rotating half of a grant's credentials (§Database).

One row per issued ``bgt_ort_…``; each exchange marks the presented row
``used_at``, inserts a successor and points ``replaced_by_id`` at it, with a fresh
30-day expiry (SLIDING — architecture §D8: a connector someone uses daily must not
die on a fixed day with "Authorization failed" as the only symptom, while an
abandoned one is cut after a month of silence).

**Reuse of a spent refresh token revokes the grant** (OAuth 2.1 / RFC 6819 §5.2.2.3):
the claim is ``UPDATE … WHERE used_at IS NULL RETURNING``, so the second presenter
gets zero rows, the grant gets ``revoked_at``, and the SDK answers
``invalid_grant``. The chain of ``replaced_by_id`` links is what makes the family
readable by hand afterwards — there is no ``family`` column, because the FAMILY IS
THE GRANT.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from budget_api.models.base import Base


class OAuthRefreshToken(Base):
    __tablename__ = "oauth_refresh_tokens"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    grant_id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        ForeignKey("personal_access_tokens.id", ondelete="CASCADE"),
        index=True,
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    #: Set by the rotation claim; its presence is what makes a second presentation
    #: of this token a detected REUSE rather than a retry.
    used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    replaced_by_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey("oauth_refresh_tokens.id", ondelete="CASCADE"),
        nullable=True,
    )
