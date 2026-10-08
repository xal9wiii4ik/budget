"""Token strings, the one digest function, and the ONE access-token resolver.

Three credential families, three greppable prefixes — a leaked string is
identifiable in a log or a repository without being usable:

* ``bgt_oat_`` access token (what a remote client sends as its bearer),
* ``bgt_ort_`` refresh token,
* ``bgt_oac_`` authorization code.

They are siblings of ``bgt_pat_`` and are stored the same way: SHA-256 hex, under
a UNIQUE index that IS the lookup. :func:`hash_token` lives here rather than in
``pat_auth`` because the dependency direction runs ``pat_auth`` → ``oauth.tokens``
→ ``models`` (architecture §Dependency direction) and a second definition of "how
a credential is stored" is exactly the drift this codebase refuses; ``pat_auth``
re-exports it, so its own callers are unchanged.

:func:`resolve_access_token` is the **single** acceptance path for an OAuth
bearer: ``pat_auth`` uses it for ordinary API calls and (B2) the ``/mcp``
transport's verifier uses it too, so "revoked" can never mean two things. Its ONE
query joins every condition that makes a token live:

* the access-token row exists and has not expired,
* its grant is not revoked AND is really a grant (``oauth_client_id`` set — a
  plain PAT's id can never be reached through this path),
* the owner is still active.

All four are predicates in the same SQL, so there is no order for a future edit to
get wrong and no branch that can be forgotten.
"""

import hashlib
import secrets

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.models import OAuthAccessToken, PersonalAccessToken, User

#: Access token — the prefix ``pat_auth`` dispatches on (its second branch).
OAUTH_ACCESS_PREFIX = "bgt_oat_"
#: Refresh token. Never presented as a bearer; only at ``/oauth/token``.
OAUTH_REFRESH_PREFIX = "bgt_ort_"
#: Authorization code. Lives 60 seconds and is single-use.
OAUTH_CODE_PREFIX = "bgt_oac_"

#: 32 bytes from ``secrets`` → 43 url-safe characters, ~256 bits. The same width
#: and the same reasoning as a PAT: brute force is irrelevant at that width, which
#: is why SHA-256 rather than a KDF is the right storage form.
_TOKEN_BYTES = 32


def hash_token(token: str) -> str:
    """SHA-256 hex of the FULL token string — the only form ever stored.

    Shared by personal access tokens and all three OAuth families: one definition,
    so "what is in the database" cannot differ between them.
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def mint(prefix: str) -> str:
    """A fresh credential: its prefix plus 256 bits of randomness."""
    return prefix + secrets.token_urlsafe(_TOKEN_BYTES)


async def resolve_access_token(
    session: AsyncSession, raw: str
) -> tuple[PersonalAccessToken, User] | None:
    """The grant and its owner for a live ``bgt_oat_…``, else None.

    None covers unknown, expired, revoked-grant and deactivated-owner alike: four
    facts, one indistinguishable answer, exactly as the PAT branch does it.
    """
    resolved = await resolve_access_token_row(session, raw)
    if resolved is None:
        return None
    _, grant, user = resolved
    return grant, user


async def resolve_access_token_row(
    session: AsyncSession, raw: str
) -> tuple[OAuthAccessToken, PersonalAccessToken, User] | None:
    """As :func:`resolve_access_token`, plus the token row itself.

    The ``/oauth/token`` provider needs the row's ``expires_at`` to fill the
    SDK's ``AccessToken``; nothing else does, which is why the common case gets
    the two-tuple above.
    """
    row = (
        await session.execute(
            select(OAuthAccessToken, PersonalAccessToken, User)
            .join(
                PersonalAccessToken,
                PersonalAccessToken.id == OAuthAccessToken.grant_id,
            )
            .join(User, PersonalAccessToken.user_id == User.id)
            .where(
                OAuthAccessToken.token_hash == hash_token(raw),
                OAuthAccessToken.expires_at > func.now(),
                PersonalAccessToken.revoked_at.is_(None),
                PersonalAccessToken.oauth_client_id.is_not(None),
                # ``User.__table__.c`` because models/user.py hides its columns
                # behind a TYPE_CHECKING split (the push_jobs.py precedent).
                User.__table__.c.is_active.is_(True),
            )
        )
    ).first()
    if row is None:
        return None
    return row[0], row[1], row[2]
