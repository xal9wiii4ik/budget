"""The AI advisor seam: context types, prompt rendering, Anthropic streaming (D7).

**This module imports no ``models``, no ``schemas``, no ``db``, not even a sibling
service** — stdlib plus ``config``, the pure ``domain/money``, and the
anthropic/httpx SDKs (backend Disagreement 2 as refined by senior-lead: the pure
major-unit renderer is allowed in, because the alternative is re-deriving exponent
math here). That import list is the §Безопасность guarantee: raw transaction rows
(notes, ids, exact dates) must never reach the prompt, and with module-local frozen
dataclasses "there is structurally nowhere to put a ``Transaction`` row" is a
property of the import graph rather than of a reviewer's attention. Anything the
model gets to see has to be spelled out as a field here first.

Every figure in the context is in MINOR units of the currency named next to it
(AM-5); the minor→major crossing happens exactly once, in :func:`render_prompt`,
via ``domain.money.to_major_string`` at that figure's OWN currency — the model is
never asked to do exponent math.

The pure mapping from the DB-facing aggregates into these types lives in
``services/advisor_context.py``, so this file never learns what a session is; the
router owns all I/O and hands :class:`Advisor` a finished :class:`AdvisorContext`.
"""

import logging
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from datetime import date

import anthropic
import httpx
from anthropic import AsyncAnthropic
from anthropic.types import MessageParam

from budget_api.config import Settings
from budget_api.domain.money import to_major_string

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Turn:
    """One client-carried chat turn (there is no server-side chat state)."""

    role: str
    content: str


@dataclass(frozen=True)
class CategorySpend:
    """One category bucket of the window. ``kind`` is ``"income"``/``"expense"``."""

    name: str
    kind: str
    total_minor: int


@dataclass(frozen=True)
class MonthPoint:
    """One full calendar month of the window; ``month`` is ``"YYYY-MM"``."""

    month: str
    income_minor: int
    expense_minor: int
    net_minor: int


@dataclass(frozen=True)
class MerchantSpend:
    merchant: str
    total_minor: int
    tx_count: int


@dataclass(frozen=True)
class GoalSummary:
    """A goal as the advisor sees it — computed figures, no ids, no ledger rows."""

    name: str
    currency: str
    target_minor: int
    saved_minor: int
    deadline: date | None
    monthly_needed_minor: int
    realistic: bool | None
    allocated_monthly_minor: int


@dataclass(frozen=True)
class AdvisorContext:
    """Everything the model is allowed to know about the user's money."""

    base_currency: str
    #: ``profiles.monthly_income_minor`` — nullable, and the prompt must say
    #: "not set" rather than invent a number.
    monthly_income_minor: int | None
    #: BOTH INCLUSIVE (the wire/prompt convention): the window is stated to the
    #: model in words, and "up to and including July 31" is what a human reads.
    window_from: date
    window_to: date
    months: tuple[MonthPoint, ...]
    by_category: tuple[CategorySpend, ...]
    top_merchants: tuple[MerchantSpend, ...]
    goals: tuple[GoalSummary, ...]
    #: Exclude-and-flag honesty (D9), carried into the prompt: rows that had no
    #: usable rate are in NO total above. Never hardcoded — see
    #: ``advisor_context.build_advisor_context``.
    unconverted_count: int


class AdvisorError(Exception):
    """One failure code for every way the Anthropic call can fail (:class:`Advisor`).


    Deliberately code-poor: the router turns it into a single SSE ``error`` frame,
    so a taxonomy the client cannot act on differently would be noise. The
    distinguishable conditions the client DOES act on — no key configured, quota
    spent — are answered before the stream ever starts (503/429).
    """

    def __init__(self, code: str = "ANTHROPIC_ERROR") -> None:
        self.code = code
        super().__init__(code)


#: CA-2 (granted at grooming review R5, pinned by AM-8): the web renders the answer
#: as ``white-space: pre-wrap`` and is not taking on a markdown dependency, so the
#: model is told to answer in plain text. A prompt edit must not silently drop it.
PLAIN_TEXT_INSTRUCTION = "отвечай простым текстом, без markdown-разметки"

#: Genitive month names — "с 1 мая 2026 по 31 июля 2026" is what a Russian reader
#: (and the Russian-speaking model) parses without a second thought; an ISO pair
#: would be read as two opaque tokens.
_MONTHS_GENITIVE = (
    "января",
    "февраля",
    "марта",
    "апреля",
    "мая",
    "июня",
    "июля",
    "августа",
    "сентября",
    "октября",
    "ноября",
    "декабря",
)

_KIND_RU = {"expense": "расход", "income": "доход"}


def _ru_date(day: date) -> str:
    return f"{day.day} {_MONTHS_GENITIVE[day.month - 1]} {day.year}"


def _money(minor: int, currency: str) -> str:
    """A figure the model must never rescale: major units + the currency code."""
    return f"{to_major_string(minor, currency)} {currency}"


def _ru_operations(count: int) -> str:
    """``count`` + the correctly declined "операция" (1 / 2-4 / 5+ forms)."""
    tail_two = count % 100
    tail = count % 10
    if 11 <= tail_two <= 14:
        word = "операций"
    elif tail == 1:
        word = "операция"
    elif 2 <= tail <= 4:
        word = "операции"
    else:
        word = "операций"
    return f"{count} {word}"


def render_prompt(context: AdvisorContext) -> str:
    """The system prompt: everything the model may know, in Russian, in major units.

    PURE and module-level so it is unit-testable without the SDK, and so the
    §Безопасность review question ("what exactly does the model see?") is answered
    by reading one function. Every money figure goes through
    :func:`_money` → ``to_major_string`` at ITS OWN currency: goal targets are in
    the goal's currency, the waterfall allocation is in the base currency, and the
    model is told which is which rather than left to infer an exponent.
    """
    base = context.base_currency
    income = (
        _money(context.monthly_income_minor, base)
        if context.monthly_income_minor is not None
        else "не указан"
    )
    lines = [
        "Ты — персональный финансовый советник в приложении учёта личных финансов. "
        "Пользователь задаёт вопрос о своих деньгах — отвечай на русском языке, "
        "опираясь ТОЛЬКО на приведённые ниже агрегаты: других данных о пользователе "
        "у тебя нет и запросить их ты не можешь. Если данных для ответа не хватает, "
        "прямо скажи об этом и не выдумывай цифры. Все суммы уже посчитаны и "
        f"подписаны валютой — не пересчитывай их; {PLAIN_TEXT_INSTRUCTION}.",
        "",
        # CHANGE BOTH TOGETHER: "три" spells out
        # advisor_context.ADVISOR_WINDOW_MONTHS = 3 in words, and nothing derives it
        # from the constant — a window change must be re-worded here by hand.
        f"Период: с {_ru_date(context.window_from)} по {_ru_date(context.window_to)} "
        "— три полных календарных месяца, текущий неполный месяц не включён.",
        f"Основная валюта: {base}.",
        f"Заявленный ежемесячный доход: {income}.",
    ]
    if context.unconverted_count > 0:
        # Exclude-and-flag, carried all the way into the prompt: the model must be
        # able to say "часть операций не учтена" instead of presenting a partial
        # total as the whole truth.
        lines.append(
            "Внимание: часть операций за период не удалось перевести в "
            f"{base} (не нашлось курса), их количество: "
            f"{context.unconverted_count}. Они не входят ни в одну сумму ниже."
        )

    lines += ["", "Динамика по месяцам (доход / расход / баланс):"]
    lines += [
        f"- {point.month}: доход {_money(point.income_minor, base)}, "
        f"расход {_money(point.expense_minor, base)}, "
        f"баланс {_money(point.net_minor, base)}"
        for point in context.months
    ] or ["- нет данных"]

    lines += ["", "По категориям за период:"]
    lines += [
        f"- {bucket.name} ({_KIND_RU.get(bucket.kind, bucket.kind)}): "
        f"{_money(bucket.total_minor, base)}"
        for bucket in context.by_category
    ] or ["- нет данных"]

    lines += ["", "Крупнейшие получатели платежей (только расходы):"]
    lines += [
        f"- {merchant.merchant}: {_money(merchant.total_minor, base)}, "
        f"{_ru_operations(merchant.tx_count)}"
        for merchant in context.top_merchants
    ] or ["- нет данных"]

    lines += ["", "Цели накоплений:"]
    lines += [_goal_line(goal, base) for goal in context.goals] or ["- целей нет"]

    return "\n".join(lines)


def _goal_line(goal: GoalSummary, base: str) -> str:
    if goal.realistic is None:
        realism = "реалистичность неизвестна: нет курса к основной валюте"
    elif goal.realistic:
        realism = "укладывается в срок при текущих темпах"
    else:
        realism = "НЕ укладывается в срок при текущих темпах"
    deadline = _ru_date(goal.deadline) if goal.deadline is not None else "не задан"
    return (
        f"- {goal.name}: цель {_money(goal.target_minor, goal.currency)}, "
        f"накоплено {_money(goal.saved_minor, goal.currency)}, срок {deadline}, "
        f"нужно откладывать {_money(goal.monthly_needed_minor, goal.currency)} в "
        f"месяц, {realism}; из свободного остатка на неё выделяется "
        f"{_money(goal.allocated_monthly_minor, base)} в месяц"
    )


class Advisor:
    """Anthropic streaming facade. Constructed from Settings, no DB, no models.

    One instance per app on ``app.state.advisor`` (the ``receipt_parser``
    construction contract: stateless, Settings-only, no I/O at build time), and the
    pytest layer swaps a fake at that seam — no test makes a live Anthropic call.

    The empty-key 503 gate lives in ``ai_gate``, never here: an unconfigured server
    must fail before any context is assembled, not as a stream that dies on its
    first frame.
    """

    def __init__(self, settings: Settings) -> None:
        self._model = settings.advisor_model
        self._max_tokens = settings.advisor_max_tokens
        # max_retries=1 mirrors the receipt parser: one automatic SDK retry on a
        # retryable error, then surface as ANTHROPIC_ERROR. Retrying further would
        # stall a stream the user is watching.
        self._client = AsyncAnthropic(
            api_key=settings.anthropic_api_key,
            timeout=settings.advisor_timeout_seconds,
            max_retries=1,
        )

    async def stream_advice(
        self, question: str, history: Sequence[Turn], context: AdvisorContext
    ) -> AsyncIterator[str]:
        """Yield the answer's text deltas; raise :class:`AdvisorError` on any failure.

        Chat memory is client-carried (OQ-2): ``history`` is replayed as the
        conversation and ``question`` is appended as the final user turn. The
        context is the SYSTEM prompt, so it is re-stated on every ask and cannot be
        edited away by a client replaying a doctored history.

        Failure taxonomy — where each SDK exception surfaces (verified against
        anthropic 0.120.0):

        * **before the first delta**, inside ``__aenter__``, which performs the HTTP
          request: ``anthropic.APIStatusError`` (401/429/5xx from the API),
          ``anthropic.APIConnectionError``/``APITimeoutError`` (both ``APIError``
          subclasses; the SDK wraps ``httpx`` transport failures here);
        * **mid-stream**, while iterating ``text_stream``: an ``error`` SSE event is
          re-raised by ``AsyncStream.__stream__`` as an ``APIStatusError``
          (``_make_status_error``), while a transport failure or read timeout on the
          already-open body surfaces as the raw ``httpx.HTTPError`` subclass
          (``httpx.ReadTimeout``/``ReadError``) — which is why the catch tuple keeps
          ``httpx`` in it alongside ``anthropic.APIError``.

        Both positions raise the SAME ``AdvisorError``: the router turns a
        pre-first-delta failure into the same terminal ``error`` frame as a
        mid-stream one (D9, delegated), because the client must handle that arm
        anyway and holding the response open to buy one status code is a worse
        trade.
        """
        messages: list[MessageParam] = [
            {
                # The schema layer (``AdvisorTurn.role``) already restricts this to
                # the two literals; normalizing here keeps the SDK's TypedDict happy
                # without a cast and without a second validation error path.
                "role": "assistant" if turn.role == "assistant" else "user",
                "content": turn.content,
            }
            for turn in history
        ]
        messages.append({"role": "user", "content": question})
        try:
            async with self._client.messages.stream(
                model=self._model,
                max_tokens=self._max_tokens,
                system=render_prompt(context),
                messages=messages,
            ) as stream:
                async for text in stream.text_stream:
                    yield text
        except (TimeoutError, anthropic.APIError, httpx.HTTPError) as exc:
            # Specific-only catch (never bare), the receipt_parser precedent. No user
            # or question text is logged — the class of failure is the useful signal
            # and the question is the user's private data.
            logger.warning("advisor stream failed: %r", exc)
            raise AdvisorError() from exc
