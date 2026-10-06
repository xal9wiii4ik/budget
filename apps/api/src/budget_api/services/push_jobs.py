"""The daily push digest — one reminder per user per day (web-push architecture §4).

One entry point, ``send_daily_reminders``, wired as a cron job in ``app.py``.
Shape = ``recurring_jobs.materialize_due``: never raises, a short probe session
closed before any work, then each user handled on their own with a broad
per-user ``except`` so one user's bad data costs nobody else their reminder.

Per user, three sessions and none of them open across a network call (the
``fx_jobs`` rule — a push service that answers slowly must not pin a pooled
connection, and a long-lived transaction would hold the claim row's lock):

* **A — claim, committed BEFORE any send.** ``INSERT … ON CONFLICT DO NOTHING
  RETURNING`` on the ``(user_id, sent_on)`` PK. No row back → another run (a
  coalesced misfire racing the cron, or an earlier run today) owns the day, skip.
  Committing first means a crash between send and bookkeeping can only LOSE a
  day's digest, never send it twice — a duplicate push is the failure the product
  named, a missed day is not. The claim is taken even when nothing turns out to
  be due: "the job evaluated this user today" is then a fact support can read.
* **B — read-only, closed before the sends.** Devices, the profile language and
  the three "soon" families, copied into plain values.
* **sends — no session at all.**
* **C — write.** Delete the devices the push service called dead, write the
  claim's five counters, commit. A ``failed`` outcome changes nothing.

The "soon" window is ``[today, today + horizon_days]`` for all three families.
``today`` is computed per run and deliberately NOT bound in the job kwargs (the
recurring D5 rule: kwargs freeze at schedule time).
"""

import logging
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from budget_api.domain.push_digest import (
    Digest,
    DigestInput,
    GoalItemRef,
    Lang,
    build_digest,
)
from budget_api.models import (
    Deposit,
    Profile,
    PushReminderSend,
    PushSubscription,
    User,
)
from budget_api.services.goal_plan_reads import read_upcoming_deadlines
from budget_api.services.push_sender import PushSender, SendOutcome
from budget_api.services.recurring_reads import read_upcoming_charges

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class PushDevice:
    """A subscription row as plain values — safe to hold after its session closed."""

    endpoint: str
    p256dh: str
    auth: str
    lang: str


@dataclass(frozen=True)
class _Snapshot:
    devices: Sequence[PushDevice]
    profile_language: str | None
    goal_items: Sequence[GoalItemRef]
    charges: Sequence[str]
    deposits: Sequence[str]


def digest_lang(profile_language: str | None, device_lang: str) -> Lang:
    """The profile's language wins; the device's ``lang`` only when it is unset.

    Both columns are CHECK-constrained to ru|en, so the narrowing below is total.
    Shared with ``POST /push/test`` so the test push speaks the digest's language.
    """
    chosen = profile_language or device_lang
    return "en" if chosen == "en" else "ru"


async def read_devices(session: AsyncSession, user_id: uuid.UUID) -> list[PushDevice]:
    """The user's devices, oldest first. Shared with ``POST /push/test``."""
    rows = await session.execute(
        select(
            PushSubscription.endpoint,
            PushSubscription.p256dh,
            PushSubscription.auth,
            PushSubscription.lang,
        )
        .where(PushSubscription.user_id == user_id)
        .order_by(PushSubscription.created_at, PushSubscription.id)
    )
    return [
        PushDevice(
            endpoint=row.endpoint, p256dh=row.p256dh, auth=row.auth, lang=row.lang
        )
        for row in rows.all()
    ]


async def _active_subscriber_ids(session: AsyncSession) -> Sequence[uuid.UUID]:
    # ``is_active`` is only checked HERE: a deactivated account keeps its rows but
    # is never messaged. (/push/test needs no such check — its user dependency
    # already refuses an inactive account.)
    rows = await session.scalars(
        select(PushSubscription.user_id)
        .distinct()
        .join(User, PushSubscription.user_id == User.id)
        .where(User.__table__.c.is_active.is_(True))
    )
    return rows.all()


async def _claim(
    sessionmaker: async_sessionmaker[AsyncSession], user_id: uuid.UUID, run_date: date
) -> bool:
    async with sessionmaker() as session:
        claimed = await session.scalar(
            pg_insert(PushReminderSend)
            .values(user_id=user_id, sent_on=run_date)
            .on_conflict_do_nothing(index_elements=["user_id", "sent_on"])
            .returning(PushReminderSend.user_id)
        )
        await session.commit()
    return claimed is not None


async def _read_snapshot(
    sessionmaker: async_sessionmaker[AsyncSession],
    user_id: uuid.UUID,
    *,
    today: date,
    through: date,
) -> _Snapshot:
    async with sessionmaker() as session:
        devices = await read_devices(session, user_id)
        # A plain column read, never ``ensure_profile``: a job must not create rows
        # for a user nobody asked about (the recurring-job rule).
        profile_language = await session.scalar(
            select(Profile.language).where(Profile.user_id == user_id)
        )
        goal_items = [
            GoalItemRef(
                goal_id=item.goal_id, goal_name=item.goal_name, item_name=item.item_name
            )
            for item in await read_upcoming_deadlines(
                session, user_id, today=today, through=through
            )
        ]
        charges = [
            charge.name
            for charge in await read_upcoming_charges(
                session, user_id, today=today, through=through
            )
        ]
        # The web's deposit-deadline rule: live deposits whose term ends inside the
        # window, both ends inclusive.
        deposits = list(
            (
                await session.scalars(
                    select(Deposit.name)
                    .where(
                        Deposit.user_id == user_id,
                        Deposit.archived.is_(False),
                        Deposit.term_end.between(today, through),
                    )
                    .order_by(Deposit.term_end, Deposit.created_at)
                )
            ).all()
        )
    return _Snapshot(
        devices=devices,
        profile_language=profile_language,
        goal_items=goal_items,
        charges=charges,
        deposits=deposits,
    )


async def _remind_user(
    sessionmaker: async_sessionmaker[AsyncSession],
    sender: PushSender,
    user_id: uuid.UUID,
    *,
    run_date: date,
    through: date,
) -> None:
    # Session A.
    if not await _claim(sessionmaker, user_id, run_date):
        return
    # Session B.
    snap = await _read_snapshot(sessionmaker, user_id, today=run_date, through=through)

    # No session from here to C.
    delivered = 0
    gone: list[str] = []
    digests: dict[Lang, Digest] = {}
    nothing_due = not (snap.goal_items or snap.charges or snap.deposits)
    if not nothing_due:
        for device in snap.devices:
            lang = digest_lang(snap.profile_language, device.lang)
            if lang not in digests:
                digests[lang] = build_digest(
                    DigestInput(
                        goal_items=snap.goal_items,
                        charges=snap.charges,
                        deposits=snap.deposits,
                        lang=lang,
                        on=run_date,
                    )
                )
            outcome = await sender.send(device, digests[lang].to_payload())
            if outcome is SendOutcome.delivered:
                delivered += 1
            elif outcome is SendOutcome.gone:
                gone.append(device.endpoint)

    # Session C.
    async with sessionmaker() as session:
        if gone:
            await session.execute(
                delete(PushSubscription).where(
                    PushSubscription.user_id == user_id,
                    PushSubscription.endpoint.in_(gone),
                )
            )
        await session.execute(
            update(PushReminderSend)
            .where(
                PushReminderSend.user_id == user_id,
                PushReminderSend.sent_on == run_date,
            )
            .values(
                goal_items=len(snap.goal_items),
                charges=len(snap.charges),
                deposits=len(snap.deposits),
                delivered=delivered,
                removed=len(gone),
            )
        )
        await session.commit()


async def send_daily_reminders(
    sessionmaker: async_sessionmaker[AsyncSession],
    *,
    sender: PushSender,
    horizon_days: int,
    today: date | None = None,
) -> None:
    """Send today's digest to every device of every active subscriber. NEVER raises.

    ``today`` defaults to the UTC date and is a parameter ONLY for tests.
    """
    if not sender.enabled:
        # Registered whenever the gate is on, so a keyless server is harmless: one
        # line a day, nothing claimed, nothing read.
        logger.info("push reminders skipped: VAPID keys are not configured")
        return
    run_date = today if today is not None else datetime.now(UTC).date()
    through = run_date + timedelta(days=horizon_days)
    try:
        async with sessionmaker() as probe_session:
            user_ids = await _active_subscriber_ids(probe_session)
    except Exception as exc:
        # Broad on purpose (the materialize_due probe rule): a DB that is down at
        # 06:00 costs one warning, not an APScheduler error event.
        logger.warning("push reminder probe failed: %r", exc)
        return

    for user_id in user_ids:
        try:
            await _remind_user(
                sessionmaker, sender, user_id, run_date=run_date, through=through
            )
        except Exception as exc:
            # Deliberately broad, PER USER: one user's bad data must not cost every
            # other user their reminder, and the job itself must never raise. A
            # failure after the claim loses this user's day by design (module doc).
            # The exception TYPE only: a DB error's text carries the statement's
            # parameters, and session C's are device endpoints (push_sender._host).
            logger.warning(
                "push reminder failed for %s: %s", user_id, type(exc).__name__
            )
