"""The authorization server's storage and policy (``OAuthAuthorizationServerProvider``).

The SDK's handlers do the RFC work — parsing, PKCE comparison, the error envelopes.
Everything that touches our data or decides anything is here, and four decisions
shape the whole module:

1. **The grant is created at CODE EXCHANGE, not at consent** (architecture §D3).
   A consent whose code is never redeemed (a closed tab, a client timeout) would
   otherwise leave an orphan "connected app" in Settings.
2. **The grant IS a ``personal_access_tokens`` row**, so a remote call lands in the
   same ``PatContext`` a PAT does and the one enforcement pipeline runs unchanged.
3. **Reuse revokes.** A consumed authorization code presented again (RFC 6749
   §4.1.2) or a consumed refresh token presented again (OAuth 2.1 / RFC 6819
   §5.2.2.3) revokes the grant it belongs to. Single use is enforced by
   ``UPDATE … WHERE used_at IS NULL RETURNING`` — zero rows back IS the detection,
   so two simultaneous presentations cannot both succeed.
4. **Every acceptance path re-reads the grant and the owner.** ``revoked_at IS
   NULL`` and ``User.is_active`` are predicates on the exchange itself, not facts
   remembered from the ``load_*`` call before it.

Expiry timestamps are computed from the DATABASE clock (``_db_now``), never from
this process's: the predicates that later read them are ``func.now()``, and one
clock is the only way a "60 second" code is exactly that.

Nothing here logs a token, a code, a verifier, a challenge or a ``state``; the
identifiers that do get logged are a ``client_id``, a grant id and a request id
(architecture §D10).
"""

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

from fastapi import FastAPI
from mcp.server.auth.provider import (
    AccessToken,
    AuthorizationCode,
    AuthorizationParams,
    AuthorizeError,
    OAuthAuthorizationServerProvider,
    RefreshToken,
    RegistrationError,
    TokenError,
)
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken
from pydantic import AnyUrl
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from budget_api.config import Settings
from budget_api.enums import PatScope
from budget_api.models import (
    OAuthAccessToken,
    OAuthAuthorizationCode,
    OAuthAuthorizationRequest,
    OAuthClient,
    OAuthRefreshToken,
    PersonalAccessToken,
    User,
)
from budget_api.oauth.clients import (
    MAX_CLIENT_NAME_LENGTH,
    BudgetClient,
    validate_registration,
)
from budget_api.oauth.tokens import (
    OAUTH_ACCESS_PREFIX,
    OAUTH_REFRESH_PREFIX,
    hash_token,
    mint,
    resolve_access_token_row,
)
from budget_api.oauth.urls import PublicUrls

logger = logging.getLogger(__name__)

#: Ruling R2 (the architecture said 512, which Claude's own ``state`` can exceed).
#: A client may legitimately pack a return path in here; 2 KB is generous and still
#: bounds a column nobody queries.
MAX_STATE_LENGTH = 2048
#: The PKCE S256 challenge is 43 characters. The column is String(128), and an
#: unbounded value would reach it as a database error instead of a refusal.
MAX_CODE_CHALLENGE_LENGTH = 128

#: What ``get_client`` reports a registered client may do. The pair is fixed rather
#: than stored: ``grant_types`` is self-asserted metadata, the token endpoint only
#: ever honours these two, and a client that registered without ``refresh_token``
#: gains nothing from being refused a rotation it would otherwise never ask for.
_GRANT_TYPES = ["authorization_code", "refresh_token"]

#: The grant row's ``name`` when the client declared none. Support reads this
#: column by hand; ``GET /oauth/apps`` serves the client's own (nullable) name.
_UNNAMED_CLIENT = "AI app"


@dataclass(frozen=True)
class _IssuedPair:
    access: str
    refresh: str
    refresh_id: uuid.UUID
    expires_in: int


class BudgetAuthorizationCode(AuthorizationCode):
    """The SDK's code model plus the row it came from and who granted it."""

    row_id: uuid.UUID
    user_id: uuid.UUID


class BudgetRefreshToken(RefreshToken):
    """The SDK's refresh model plus the row to claim and the grant it belongs to."""

    row_id: uuid.UUID
    grant_id: uuid.UUID


async def _db_now(session: AsyncSession) -> datetime:
    """The transaction's ``now()`` — the single clock every lifetime is measured on."""
    return (await session.execute(select(func.now()))).scalar_one()


class BudgetOAuthProvider(
    OAuthAuthorizationServerProvider[
        BudgetAuthorizationCode, BudgetRefreshToken, AccessToken
    ]
):
    """The provider the SDK's ``/authorize``, ``/token`` and ``/register`` run on."""

    def __init__(self, app: FastAPI, settings: Settings, urls: PublicUrls) -> None:
        # The app, not the sessionmaker: the sessionmaker is built in the lifespan,
        # while the routes (and so this object) are built in ``create_app``.
        self._app = app
        self._settings = settings
        self._urls = urls

    @property
    def _sessionmaker(self) -> async_sessionmaker[AsyncSession]:
        maker: async_sessionmaker[AsyncSession] = self._app.state.sessionmaker
        return maker

    # ------------------------------------------------------------------ clients

    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        """The registered client, or None — which every handler reads as "unknown".

        A ``client_id`` that is not a uuid is answered without a query at all: the
        column IS a uuid (the SDK's registration handler mints ``str(uuid4())``).
        """
        key = _as_uuid(client_id)
        if key is None:
            return None
        async with self._sessionmaker() as session:
            row = await session.get(OAuthClient, key)
        if row is None:
            return None
        return BudgetClient(
            client_id=str(row.id),
            client_name=row.client_name,
            redirect_uris=[AnyUrl(str(uri)) for uri in row.redirect_uris],
            token_endpoint_auth_method=row.token_endpoint_auth_method,
            grant_types=list(_GRANT_TYPES),
            response_types=["code"],
            # NEVER the secret: only its digest is stored, and only
            # ``oauth/client_auth.py`` compares it (ruling R1).
            client_secret=None,
            client_secret_hash=row.client_secret_hash,
        )

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        """Store what RFC 7591 registration accepted — and nothing more (§D7)."""
        method = validate_registration(client_info)
        key = _as_uuid(client_info.client_id)
        if key is None:  # pragma: no cover - the SDK handler always mints a uuid4
            raise RegistrationError(
                error="invalid_client_metadata",
                error_description="unsupported client_id",
            )
        secret = client_info.client_secret
        async with self._sessionmaker() as session:
            session.add(
                OAuthClient(
                    id=key,
                    client_name=client_info.client_name,
                    redirect_uris=[str(uri) for uri in client_info.redirect_uris or ()],
                    token_endpoint_auth_method=method,
                    client_secret_hash=hash_token(secret) if secret else None,
                )
            )
            await session.commit()
        logger.info("oauth client registered: %s (%s)", key, method)

    # ---------------------------------------------------------------- authorize

    async def authorize(
        self, client: OAuthClientInformationFull, params: AuthorizationParams
    ) -> str:
        """Park the request and send the browser to the consent page (§D6).

        Nothing is granted here. The row this writes is the ONLY source of the
        redirect back to the client, so a forged decision cannot change where the
        authorization response goes.
        """
        if not params.redirect_uri_provided_explicitly:
            # A client with one registered URI could omit it, but then the token
            # endpoint has nothing to compare and the consent page cannot show the
            # user where their data would go. Require it.
            raise AuthorizeError(
                error="invalid_request",
                error_description="redirect_uri must be provided explicitly",
            )
        if params.state is not None and len(params.state) > MAX_STATE_LENGTH:
            raise AuthorizeError(
                error="invalid_request",
                error_description=(
                    f"state must be at most {MAX_STATE_LENGTH} characters"
                ),
            )
        if len(params.code_challenge) > MAX_CODE_CHALLENGE_LENGTH:
            raise AuthorizeError(
                error="invalid_request",
                error_description="code_challenge is too long",
            )
        if params.resource is not None and not self._is_our_resource(params.resource):
            # RFC 8707 §2: the token would be audience-bound to a server that is
            # not us, so refuse now rather than mint something unusable.
            raise AuthorizeError(
                error="invalid_target",
                error_description="unknown resource",
            )

        client_key = _as_uuid(client.client_id)
        if client_key is None:  # pragma: no cover - get_client already parsed it
            raise AuthorizeError(
                error="invalid_request", error_description="bad client"
            )
        async with self._sessionmaker() as session:
            # Lazy prune (architecture §Database): abandoned tabs are swept by the
            # next authorize call instead of by a scheduler job.
            await session.execute(
                delete(OAuthAuthorizationRequest).where(
                    OAuthAuthorizationRequest.expires_at < func.now()
                )
            )
            row = OAuthAuthorizationRequest(
                client_id=client_key,
                redirect_uri=str(params.redirect_uri),
                code_challenge=params.code_challenge,
                state=params.state,
                resource=params.resource,
                expires_at=await _db_now(session)
                + timedelta(seconds=self._settings.oauth_request_lifetime_seconds),
            )
            session.add(row)
            await session.commit()
            request_id = row.id
        logger.info(
            "oauth consent requested: client=%s request=%s",
            client.client_id,
            request_id,
        )
        return self._urls.consent_url(str(request_id))

    # -------------------------------------------------------- authorization code

    async def load_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: str
    ) -> BudgetAuthorizationCode | None:
        """The code row, or None for unknown / foreign / REPLAYED (which revokes)."""
        client_key = _as_uuid(client.client_id)
        if client_key is None:  # pragma: no cover - get_client already parsed it
            return None
        async with self._sessionmaker() as session:
            row = (
                await session.execute(
                    select(OAuthAuthorizationCode).where(
                        OAuthAuthorizationCode.code_hash
                        == hash_token(authorization_code),
                        OAuthAuthorizationCode.client_id == client_key,
                    )
                )
            ).scalar_one_or_none()
            if row is None:
                await self._prune_credentials(session)
                return None
            if row.used_at is not None:
                # RFC 6749 §4.1.2: a code presented twice is assumed to have
                # leaked, so the grant it produced dies with it.
                await self._revoke_grant(session, row.grant_id, reason="code replay")
                return None
            return BudgetAuthorizationCode(
                code=authorization_code,
                scopes=[row.scope],
                expires_at=row.expires_at.timestamp(),
                client_id=client.client_id,
                code_challenge=row.code_challenge,
                redirect_uri=AnyUrl(row.redirect_uri),
                redirect_uri_provided_explicitly=True,
                resource=row.resource,
                subject=str(row.user_id),
                row_id=row.id,
                user_id=row.user_id,
            )

    async def exchange_authorization_code(
        self,
        client: OAuthClientInformationFull,
        authorization_code: BudgetAuthorizationCode,
    ) -> OAuthToken:
        """Consume the code; create the grant and its first pair, in one transaction."""
        client_key = _as_uuid(client.client_id)
        if client_key is None:  # pragma: no cover - get_client already parsed it
            raise TokenError(error="invalid_grant", error_description="unknown grant")
        mode = authorization_code.scopes[0]
        async with self._sessionmaker() as session:
            claimed = (
                await session.execute(
                    update(OAuthAuthorizationCode)
                    .where(
                        OAuthAuthorizationCode.id == authorization_code.row_id,
                        OAuthAuthorizationCode.used_at.is_(None),
                        OAuthAuthorizationCode.expires_at > func.now(),
                    )
                    .values(used_at=func.now())
                    .returning(OAuthAuthorizationCode.id)
                )
            ).scalar_one_or_none()
            if claimed is None:
                # Consumed or expired between the load above and now. Roll the
                # claim back before revoking, so the revocation is the only write.
                await session.rollback()
                await self._revoke_grant_of_code(
                    session, authorization_code.row_id, reason="code replay"
                )
                raise TokenError(
                    error="invalid_grant",
                    error_description="authorization code is not usable",
                )
            user = await session.get(User, authorization_code.user_id)
            if user is None or not user.is_active:
                await session.rollback()
                raise TokenError(
                    error="invalid_grant", error_description="grant is not usable"
                )
            grant = PersonalAccessToken(
                user_id=authorization_code.user_id,
                name=(client.client_name or _UNNAMED_CLIENT)[:MAX_CLIENT_NAME_LENGTH],
                token_hash=None,
                oauth_client_id=client_key,
                scope=PatScope(mode).value,
            )
            session.add(grant)
            await session.flush()
            await session.execute(
                update(OAuthAuthorizationCode)
                .where(OAuthAuthorizationCode.id == authorization_code.row_id)
                .values(grant_id=grant.id)
            )
            pair = await self._issue_pair(session, grant.id)
            await session.commit()
            grant_id = grant.id
        logger.info(
            "oauth grant created: client=%s grant=%s scope=%s",
            client.client_id,
            grant_id,
            mode,
        )
        return OAuthToken(
            access_token=pair.access,
            token_type="Bearer",
            expires_in=pair.expires_in,
            scope=mode,
            refresh_token=pair.refresh,
        )

    # --------------------------------------------------------------- refreshing

    async def load_refresh_token(
        self, client: OAuthClientInformationFull, refresh_token: str
    ) -> BudgetRefreshToken | None:
        """The refresh row, or None for unknown / foreign / REUSED (which revokes)."""
        client_key = _as_uuid(client.client_id)
        if client_key is None:  # pragma: no cover - get_client already parsed it
            return None
        async with self._sessionmaker() as session:
            found = (
                await session.execute(
                    select(OAuthRefreshToken, PersonalAccessToken)
                    .join(
                        PersonalAccessToken,
                        PersonalAccessToken.id == OAuthRefreshToken.grant_id,
                    )
                    .join(User, PersonalAccessToken.user_id == User.id)
                    .where(
                        OAuthRefreshToken.token_hash == hash_token(refresh_token),
                        PersonalAccessToken.oauth_client_id == client_key,
                        # TYPE_CHECKING split on models/user.py — see tokens.py.
                        User.__table__.c.is_active.is_(True),
                    )
                )
            ).first()
            if found is None:
                await self._prune_credentials(session)
                return None
            row, grant = found[0], found[1]
            if row.used_at is not None:
                # OAuth 2.1: reuse of a rotated refresh token kills the family,
                # and here the family IS the grant.
                await self._revoke_grant(
                    session, grant.id, reason="refresh token reuse"
                )
                return None
            if grant.revoked_at is not None:
                return None
            return BudgetRefreshToken(
                token=refresh_token,
                client_id=client.client_id,
                scopes=[grant.scope],
                expires_at=int(row.expires_at.timestamp()),
                resource=self._urls.resource,
                subject=str(grant.user_id),
                row_id=row.id,
                grant_id=grant.id,
            )

    async def exchange_refresh_token(
        self,
        client: OAuthClientInformationFull,
        refresh_token: BudgetRefreshToken,
        scopes: list[str],
    ) -> OAuthToken:
        """Rotate: claim the presented row, issue a new pair, link the two.

        ``scopes`` is ignored on purpose: the mode lives on the GRANT (the user
        chose it), and the SDK has already refused anything wider than what the
        presented token carries.
        """
        async with self._sessionmaker() as session:
            claimed = (
                await session.execute(
                    update(OAuthRefreshToken)
                    .where(
                        OAuthRefreshToken.id == refresh_token.row_id,
                        OAuthRefreshToken.used_at.is_(None),
                    )
                    .values(used_at=func.now())
                    .returning(OAuthRefreshToken.id)
                )
            ).scalar_one_or_none()
            if claimed is None:
                await session.rollback()
                await self._revoke_grant(
                    session, refresh_token.grant_id, reason="refresh token reuse"
                )
                raise TokenError(
                    error="invalid_grant",
                    error_description="refresh token is not usable",
                )
            grant = await session.get(PersonalAccessToken, refresh_token.grant_id)
            user = None if grant is None else await session.get(User, grant.user_id)
            if (
                grant is None
                or grant.revoked_at is not None
                or user is None
                or not user.is_active
            ):
                await session.rollback()
                raise TokenError(
                    error="invalid_grant", error_description="grant is not usable"
                )
            # Every healthy connector rotates at least hourly, so this is where
            # the sweep actually runs; it rides the rotation's own transaction.
            await self._delete_expired_credentials(session)
            pair = await self._issue_pair(session, grant.id)
            # The link is written AFTER the successor exists: ``replaced_by_id`` is
            # an FK onto this same table, so the plan's single-statement claim
            # would have pointed at a row that is not there yet.
            await session.execute(
                update(OAuthRefreshToken)
                .where(OAuthRefreshToken.id == refresh_token.row_id)
                .values(replaced_by_id=pair.refresh_id)
            )
            await session.commit()
        return OAuthToken(
            access_token=pair.access,
            token_type="Bearer",
            expires_in=pair.expires_in,
            scope=grant.scope,
            refresh_token=pair.refresh,
        )

    # ------------------------------------------------------------ access tokens

    async def load_access_token(self, token: str) -> AccessToken | None:
        """Verify a bearer — through the SAME resolver ``pat_auth`` uses."""
        if not token.startswith(OAUTH_ACCESS_PREFIX):
            return None
        async with self._sessionmaker() as session:
            resolved = await resolve_access_token_row(session, token)
        if resolved is None:
            return None
        row, grant, _user = resolved
        return AccessToken(
            token=token,
            client_id=str(grant.oauth_client_id),
            scopes=[grant.scope],
            expires_at=int(row.expires_at.timestamp()),
            resource=self._urls.resource,
            subject=str(grant.user_id),
        )

    async def revoke_token(self, token: AccessToken | BudgetRefreshToken) -> None:
        """Deliberately a no-op: no ``revocation_endpoint`` is advertised (§D7).

        Revocation is a product gesture — Settings → "Connected AI apps" → Revoke,
        which kills the GRANT and with it every token of its family at once. An
        RFC 7009 endpoint would only let a client drop one of its own strings.
        """
        return None

    # ------------------------------------------------------------------ helpers

    def _is_our_resource(self, resource: str) -> bool:
        """RFC 8707 indicator comparison, tolerant of one trailing slash only."""
        return resource.rstrip("/") == self._urls.resource.rstrip("/")

    async def _issue_pair(
        self, session: AsyncSession, grant_id: uuid.UUID
    ) -> _IssuedPair:
        """Insert one access + one refresh row for ``grant_id``; return the strings."""
        now = await _db_now(session)
        access_raw = mint(OAUTH_ACCESS_PREFIX)
        refresh_raw = mint(OAUTH_REFRESH_PREFIX)
        access_lifetime = self._settings.oauth_access_token_lifetime_seconds
        refresh_row = OAuthRefreshToken(
            grant_id=grant_id,
            token_hash=hash_token(refresh_raw),
            # SLIDING: every rotation gets a full window (§D8).
            expires_at=now
            + timedelta(seconds=self._settings.oauth_refresh_token_lifetime_seconds),
        )
        session.add(
            OAuthAccessToken(
                grant_id=grant_id,
                token_hash=hash_token(access_raw),
                expires_at=now + timedelta(seconds=access_lifetime),
            )
        )
        session.add(refresh_row)
        await session.flush()
        return _IssuedPair(
            access=access_raw,
            refresh=refresh_raw,
            refresh_id=refresh_row.id,
            expires_in=access_lifetime,
        )

    async def _delete_expired_credentials(self, session: AsyncSession) -> None:
        """The three expiry DELETEs, WITHOUT a commit — joins the caller's transaction.

        No index on ``expires_at`` for these tables on purpose: a grant writes
        ~50 rows a day, so the sequential scan is noise (add one only if a
        deployment ever carries thousands of grants).
        """
        for model in (OAuthAuthorizationCode, OAuthAccessToken, OAuthRefreshToken):
            await session.execute(delete(model).where(model.expires_at < func.now()))

    async def _prune_credentials(self, session: AsyncSession) -> None:
        """Delete expired codes and tokens — the lazy sweep of the token endpoint."""
        await self._delete_expired_credentials(session)
        await session.commit()

    async def _revoke_grant(
        self, session: AsyncSession, grant_id: uuid.UUID | None, *, reason: str
    ) -> None:
        """Soft-revoke a grant. Idempotent, and the one place that logs the reason."""
        if grant_id is None:
            return
        await session.execute(
            update(PersonalAccessToken)
            .where(
                PersonalAccessToken.id == grant_id,
                PersonalAccessToken.revoked_at.is_(None),
            )
            .values(revoked_at=func.now())
        )
        await session.commit()
        logger.warning("oauth grant %s revoked: %s", grant_id, reason)

    async def _revoke_grant_of_code(
        self, session: AsyncSession, code_row_id: uuid.UUID, *, reason: str
    ) -> None:
        grant_id = (
            await session.execute(
                select(OAuthAuthorizationCode.grant_id).where(
                    OAuthAuthorizationCode.id == code_row_id
                )
            )
        ).scalar_one_or_none()
        await self._revoke_grant(session, grant_id, reason=reason)


def _as_uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value)
    except ValueError:
        return None
