"""The text of every push this API sends — pure, no I/O (web-push architecture §5).

**Privacy by construction.** A notification is shown on a LOCKED screen, so it
must never carry money. :class:`DigestInput` therefore has no amount and no
currency member at all: the job hands over NAMES only, and nothing rendered here
can contain a number the input never had. (``tests/test_push_jobs.py`` builds a
digest out of money-bearing rows and checks the amounts do not surface.)

**Day-agnostic copy.** The window is ``[today, today + horizon]``: charges in it
are effectively tomorrow's (today's are booked at 00:30, before the 06:00 run),
while a goal reminder may be today's. So the title says "Coming up" / "Скоро",
never "today" or "tomorrow".

**No plural forms.** The overflow reads "… и ещё 2" / "… and 2 more": the count
is never followed by a noun, so Russian needs no one/few/many agreement.

**URLs are origin-relative paths** into the web app's own routes; the service
worker resolves them against its origin, so the server needs no base-URL setting.

``test_digest`` lives here too, so every string a user can see in a push comes
from this one module.
"""

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from typing import Literal

Lang = Literal["ru", "en"]

#: How many names the body spells out before "and N more".
_MAX_NAMES = 3

_TITLES: dict[Lang, str] = {"ru": "Скоро", "en": "Coming up"}
_TEST_TITLES: dict[Lang, str] = {
    "ru": "Уведомления включены",
    "en": "Notifications are on",
}
_TEST_BODIES: dict[Lang, str] = {
    "ru": "Это пробное уведомление.",
    "en": "This is a test notification.",
}


@dataclass(frozen=True)
class GoalItemRef:
    """A plan node coming up — what to call it and which goal page to open."""

    goal_id: uuid.UUID
    goal_name: str
    item_name: str


@dataclass(frozen=True)
class DigestInput:
    """Everything a reminder may say. NO amount, NO currency — see the module doc."""

    goal_items: Sequence[GoalItemRef]
    charges: Sequence[str]
    deposits: Sequence[str]
    lang: Lang
    #: The run date — only for the tag, which collapses a same-day duplicate.
    on: date

    @property
    def is_empty(self) -> bool:
        return not (self.goal_items or self.charges or self.deposits)


@dataclass(frozen=True)
class Digest:
    title: str
    body: str
    url: str
    tag: str

    def to_payload(self) -> dict[str, str]:
        """The push payload — exactly these four keys, nothing else (§5)."""
        return {
            "title": self.title,
            "body": self.body,
            "url": self.url,
            "tag": self.tag,
        }


def _url(item: DigestInput) -> str:
    families = sum(bool(f) for f in (item.goal_items, item.charges, item.deposits))
    if families > 1:
        # The page that shows BOTH the upcoming-charges and the deadlines widgets.
        return "/transactions"
    if item.goal_items:
        goal_ids = {ref.goal_id for ref in item.goal_items}
        return f"/goals/{goal_ids.pop()}" if len(goal_ids) == 1 else "/goals"
    if item.charges:
        return "/recurring"
    return "/deposits"


def _body(names: Sequence[str], lang: Lang) -> str:
    shown = ", ".join(names[:_MAX_NAMES])
    rest = len(names) - _MAX_NAMES
    if rest <= 0:
        return shown
    return f"{shown} и ещё {rest}" if lang == "ru" else f"{shown} and {rest} more"


def build_digest(item: DigestInput) -> Digest:
    """The daily reminder. The caller never asks for one when nothing is due."""
    if item.is_empty:
        raise ValueError("an empty digest is never sent")
    names = [
        *(f"{ref.goal_name}: {ref.item_name}" for ref in item.goal_items),
        *item.charges,
        *item.deposits,
    ]
    return Digest(
        title=_TITLES[item.lang],
        body=_body(names, item.lang),
        url=_url(item),
        tag=f"budget-reminder-{item.on.isoformat()}",
    )


def test_digest(lang: Lang) -> Digest:
    """The fixed text of ``POST /push/test`` — proves the pipe, says nothing private."""
    return Digest(
        title=_TEST_TITLES[lang],
        body=_TEST_BODIES[lang],
        url="/settings",
        tag="budget-test",
    )
