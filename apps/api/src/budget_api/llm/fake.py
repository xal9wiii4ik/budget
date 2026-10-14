"""One class, three modes: a synthetic model, a replay store, a recorder.

Why it lives in ``src/`` and not in ``tests/``: ``LLM_PROVIDER=fake`` has to work
on a live QA stand with no API key, and the evals CLI records and replays with no
application around it. A fake wired up in the test package could do neither.

* ``fake`` — answers THREE known prompt layouts, dispatched on the single
  top-level key of the data document (``_data_document``). Anything else is a
  programming error, not a model failure, and raises ``unsupported``:

  - ``operations`` → the categorize document (see ``services/categorize.py``):
    a substring match, the first category of the operation's kind whose NAME
    appears in the operation's text wins with confidence 0.9, anything else is
    ``"none"`` with 0.2. It is a substring matcher and nothing more: a test that
    asserts WHICH category it picked is asserting the matcher, not the behaviour
    under test.
  - ``lines`` → the Alfa extraction document: one regex over the known line
    layout (``dd.mm.yyyy <description> <amount> <CCY> <amount> <CCY>``), merchant
    = the tail after the card-purchase phrase. A fake answering a known layout,
    NOT a second extractor — a line it cannot read is simply unanswered, and the
    extractor then refuses the statement.
  - ``reconcile`` → the scripted tool loop (architecture D-L2): deterministic in
    the number of tool RESULTS already in the conversation — none → call
    ``list_unmatched_statement_rows``, one → ``list_unmatched_app_transactions``,
    two or more → the terminal ``report_discrepancies`` naming every open row
    ``missing_in_app`` and every open transaction ``extra_in_app``. It is not an
    oracle and scores badly on purpose; what it buys is a whole flow that runs on
    a QA stand with ``LLM_PROVIDER=fake``.
    The two list tools' results are read as JSON: the FIRST list of objects in
    the payload, each object identified by its ``key`` (or ``id``). That is the
    one coupling between this fake and ``services/reconcile.py`` — a caller whose
    tool results name their items differently gets an empty report, not a crash.

  ``LLMFAIL`` anywhere in the request's text or tool-result parts makes the call
  raise ``LLMError("unavailable")`` — that is how a router test gets an honest
  ``partial`` import, or a ``failed`` reconciliation, without a provider outage.
* ``replay`` — a JSONL store keyed by ``sha256`` of the canonical request; a miss
  raises ``LLMError("replay_miss")`` loudly rather than scoring 0%. The key
  contains the provider/model the answer was RECORDED under, so a replay run must
  be told which pair that was: ``name=``/``model=`` (the registry passes the
  evals run's ``--provider``/``--model``). Without them a fixture cut from a real
  provider could never be found again.
* ``record`` — wraps a real provider, appends ``{key, response, usage}`` for every
  call, and returns the real answer untouched. The recorded key is computed from
  the INNER provider's name and model, so the fixture a record run produces is the
  fixture a replay run of the same provider/model finds.

Replay and record are built only by the evals CLI (``registry.build_provider``
with ``mode=``), never by ``provider_from_settings``.
"""

import asyncio
import hashlib
import json
import re
import time
from decimal import Decimal
from pathlib import Path
from typing import Any, cast

from budget_api.llm.errors import LLMError
from budget_api.llm.types import (
    LLMProvider,
    LLMRequest,
    LLMResponse,
    ResponseBlock,
    TextBlock,
    TextPart,
    ToolResultPart,
    ToolUseBlock,
    Usage,
    part_json,
    tool_json,
)

#: Put this in an operation's text to make the fake provider fail the call.
FAIL_MARKER = "LLMFAIL"

#: What the fake answers when nothing matches — the sentinel the categorize schema
#: offers instead of a nullable enum (plan disagreement 3).
_UNSURE = "none"

_MATCH_CONFIDENCE = 0.9
_NO_MATCH_CONFIDENCE = 0.2

#: The top-level key of each document layout the fake knows, in dispatch order.
_DOCUMENT_KEYS = ("operations", "lines", "reconcile")

#: The Alfa operation line, as ``alfa_pdf.py`` hands it over (architecture D-E12).
_LINE_RE = re.compile(
    r"^(\d{2}\.\d{2}\.\d{4}) (.+?) (-?[\d.]+) ([A-Z]{3}) (-?[\d.]+) ([A-Z]{3})$"
)

#: Everything after this phrase in a card-purchase description is the merchant.
_MERCHANT_PHRASE = "Покупка товара / получение услуг "

#: The reconcile loop's tools, in the order the script calls them; the third is
#: terminal (``services/reconcile.py`` owns the names).
_LIST_TOOLS = ("list_unmatched_statement_rows", "list_unmatched_app_transactions")
_TERMINAL_TOOL = "report_discrepancies"
_SCRIPTED_SUMMARY = "scripted fake reconciliation: every open item is reported"


class FakeProvider:
    """``LLMProvider`` with no network at all. See the module docstring for modes."""

    def __init__(
        self,
        mode: str = "fake",
        store_path: Path | None = None,
        inner: LLMProvider | None = None,
        *,
        name: str | None = None,
        model: str | None = None,
    ) -> None:
        if mode not in {"fake", "replay", "record"}:
            raise ValueError(f"unknown fake provider mode: {mode}")
        if mode in {"replay", "record"} and store_path is None:
            raise ValueError(f"mode {mode!r} needs a store_path")
        if mode == "record" and inner is None:
            raise ValueError("mode 'record' needs an inner provider to record")
        self.mode = mode
        # Explicit ``name``/``model`` beat the inner provider and the "fake"
        # default: in REPLAY mode there is no inner provider to ask, and the
        # lookup key must be the one the recorder wrote — the real provider's.
        inner_name = inner.name if inner is not None else "fake"
        inner_model = inner.model if inner is not None else "fake"
        self.name = name if name is not None else inner_name
        self.model = model if model is not None else inner_model
        self._store_path = store_path
        self._inner = inner
        self._store: dict[str, dict[str, Any]] | None = None

    async def complete(self, request: LLMRequest) -> LLMResponse:
        if self.mode == "record":
            return await self._record(request)
        if self.mode == "replay":
            return await self._replay(request)
        return self._invent(request)

    # --- fake -------------------------------------------------------------

    def _invent(self, request: LLMRequest) -> LLMResponse:
        started = time.perf_counter()
        document = _data_document(request)
        if "reconcile" in document:
            blocks, stop_reason = _reconcile_step(request)
        elif "lines" in document:
            blocks, stop_reason = _extracted_rows(document)
        else:
            blocks, stop_reason = _categorized(document)
        return LLMResponse(
            blocks=blocks,
            stop_reason=stop_reason,
            usage=Usage(
                provider=self.name,
                model=self.model,
                input_tokens=0,
                output_tokens=0,
                cache_read_tokens=0,
                latency_ms=int((time.perf_counter() - started) * 1000),
                estimated_cost_usd=Decimal(0),
            ),
        )

    # --- replay / record --------------------------------------------------

    async def _replay(self, request: LLMRequest) -> LLMResponse:
        store = await self._load()
        entry = store.get(request_key(self.name, self.model, request))
        if entry is None:
            raise LLMError("replay_miss")
        return _response_from_json(entry)

    async def _record(self, request: LLMRequest) -> LLMResponse:
        assert self._inner is not None  # construction guarantees it
        response = await self._inner.complete(request)
        line = json.dumps(
            {
                "key": request_key(self.name, self.model, request),
                "response": _response_json(response),
            },
            ensure_ascii=False,
        )
        await asyncio.to_thread(self._append, line)
        return response

    def _append(self, line: str) -> None:
        path = self._store_path
        assert path is not None  # construction guarantees it
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(f"{line}\n")

    async def _load(self) -> dict[str, dict[str, Any]]:
        if self._store is None:
            self._store = await asyncio.to_thread(self._read)
        return self._store

    def _read(self) -> dict[str, dict[str, Any]]:
        path = self._store_path
        assert path is not None  # construction guarantees it
        store: dict[str, dict[str, Any]] = {}
        if not path.exists():
            return store
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            entry: Any = json.loads(line)
            # A fixture's first line may be a provenance header carrying no key
            # (evals, S3); skipping it keeps the store readable by humans.
            if not isinstance(entry, dict):
                continue
            typed = cast(dict[str, Any], entry)
            key: Any = typed.get("key")
            if isinstance(key, str):
                store[key] = typed
        return store


_Answer = tuple[tuple[ResponseBlock, ...], str]


def _categorized(document: dict[str, Any]) -> _Answer:
    categories = _rows(document, "categories")
    results: list[dict[str, Any]] = []
    for operation in _rows(document, "operations"):
        text = _string(operation, "text")
        if FAIL_MARKER in text:
            raise LLMError("unavailable")
        kind = _string(operation, "kind")
        match = next(
            (
                category
                for category in categories
                if _string(category, "kind") == kind
                and _string(category, "name").casefold() in text.casefold()
            ),
            None,
        )
        results.append(
            {
                "key": _string(operation, "key"),
                "category": _string(match, "key") if match is not None else _UNSURE,
                "confidence": (
                    _MATCH_CONFIDENCE if match is not None else _NO_MATCH_CONFIDENCE
                ),
                "reason": "name match" if match is not None else "no match",
            }
        )
    return (TextBlock(text=json.dumps({"results": results})),), "end_turn"


def _extracted_rows(document: dict[str, Any]) -> _Answer:
    """The Alfa extraction answer: one regex per line, no arithmetic, no guessing.

    A line the regex cannot read is left UNANSWERED on purpose — the extractor
    refuses a statement with a hole, and a fake that invented a row would hide
    exactly the failure the extraction's validation exists to catch.
    """
    rows: list[dict[str, Any]] = []
    for line in _rows(document, "lines"):
        text = _string(line, "text")
        if FAIL_MARKER in text:
            raise LLMError("unavailable")
        match = _LINE_RE.match(text.strip())
        if match is None:
            continue
        date, description, amount, currency, original, original_currency = (
            match.groups()
        )
        merchant = description.partition(_MERCHANT_PHRASE)[2].strip()
        rows.append(
            {
                "key": _string(line, "key"),
                "date": date,
                "amount": amount,
                "currency": currency,
                "original_amount": original,
                "original_currency": original_currency,
                "merchant": merchant or None,
            }
        )
    text = json.dumps({"rows": rows}, ensure_ascii=False)
    return (TextBlock(text=text),), "end_turn"


def _reconcile_step(request: LLMRequest) -> _Answer:
    """One scripted step of the reconcile loop — see the module docstring.

    The step is the number of tool RESULTS already in the conversation, not a
    counter on the provider: a replayed or retried loop must answer the same way
    for the same conversation, and a provider instance can serve several.
    """
    if _fails(request):
        raise LLMError("unavailable")
    results = [
        part
        for message in request.messages
        for part in message.content
        if isinstance(part, ToolResultPart)
    ]
    step = len(results)
    if step < len(_LIST_TOOLS):
        call = ToolUseBlock(id=f"fake-{step + 1}", name=_LIST_TOOLS[step])
        return (call,), "tool_use"
    items = [
        {
            "kind": "missing_in_app",
            "row_id": key,
            "transaction_id": None,
            "explanation": "no app transaction answers this statement row",
        }
        for key in _item_keys(results[0].content)
    ] + [
        {
            "kind": "extra_in_app",
            "row_id": None,
            "transaction_id": key,
            "explanation": "no statement row answers this app transaction",
        }
        for key in _item_keys(results[1].content)
    ]
    terminal = ToolUseBlock(
        id=f"fake-{step + 1}",
        name=_TERMINAL_TOOL,
        input={"items": items, "summary": _SCRIPTED_SUMMARY},
    )
    return (terminal,), "tool_use"


def _fails(request: LLMRequest) -> bool:
    """``FAIL_MARKER`` anywhere in the request — one scan over text AND results.

    One scan rather than per-arm checks: a QA row described ``LLMFAIL`` must fail
    whichever step of a loop first carries it, and in a loop that is a tool
    result, not the prompt.
    """
    for message in request.messages:
        for part in message.content:
            if isinstance(part, TextPart) and FAIL_MARKER in part.text:
                return True
            if isinstance(part, ToolResultPart) and FAIL_MARKER in part.content:
                return True
    return False


def _item_keys(content: str) -> list[str]:
    """The identifiers of a list tool's result — see the module docstring."""
    try:
        parsed: Any = json.loads(content)
    except ValueError:
        return []
    items: list[dict[str, Any]] = []
    if isinstance(parsed, list):
        items = [
            cast(dict[str, Any], item)
            for item in cast(list[Any], parsed)
            if isinstance(item, dict)
        ]
    elif isinstance(parsed, dict):
        for value in cast(dict[str, Any], parsed).values():
            if not isinstance(value, list):
                continue
            listed = [
                cast(dict[str, Any], item)
                for item in cast(list[Any], value)
                if isinstance(item, dict)
            ]
            if listed:
                items = listed
                break
    keys = [_string(item, "key") or _string(item, "id") for item in items]
    return [key for key in keys if key]


def request_key(provider: str, model: str, request: LLMRequest) -> str:
    """The replay key: ``sha256`` of the canonical JSON of the whole call.

    ONE function for both arms, so a recorded fixture and a replay lookup cannot
    drift. The system prompt and the output schema are part of the key by design:
    editing either invalidates the fixtures, which is the intended loud failure
    (regenerate them and bump ``PROMPT_VERSION``).

    ``tools``/``tool_choice`` join the canonical document ONLY when the call
    carries tools (architecture D-L1). A tool-less call must hash exactly as it
    hashed before tool use existed, or every committed categorize fixture would
    miss at once.
    """
    canonical: dict[str, Any] = {
        "provider": provider,
        "model": model,
        "system": request.system,
        "messages": [
            {
                "role": message.role,
                "content": [part_json(part) for part in message.content],
            }
            for message in request.messages
        ],
        "output_schema": request.output_schema,
        "max_tokens": request.max_tokens,
    }
    if request.tools:
        canonical["tools"] = [tool_json(spec) for spec in request.tools]
        canonical["tool_choice"] = request.tool_choice
    blob = json.dumps(canonical, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _response_json(response: LLMResponse) -> dict[str, Any]:
    cost = response.usage.estimated_cost_usd
    return {
        "blocks": [_block_json(block) for block in response.blocks],
        "stop_reason": response.stop_reason,
        "usage": {
            "provider": response.usage.provider,
            "model": response.usage.model,
            "input_tokens": response.usage.input_tokens,
            "output_tokens": response.usage.output_tokens,
            "cache_read_tokens": response.usage.cache_read_tokens,
            "latency_ms": response.usage.latency_ms,
            "estimated_cost_usd": None if cost is None else str(cost),
        },
    }


def _block_json(block: ResponseBlock) -> dict[str, Any]:
    """A response block as JSON. ``tool_use`` included: a loop's FIRST recorded
    step carries nothing else, so dropping it (the pre-pdf-reconcile behaviour)
    made every recorded loop replay as an empty answer."""
    if isinstance(block, TextBlock):
        return {"type": "text", "text": block.text}
    return {
        "type": "tool_use",
        "id": block.id,
        "name": block.name,
        "input": block.input,
    }


def _block_from_json(body: dict[str, Any]) -> ResponseBlock:
    if _string(body, "type") == "tool_use":
        return ToolUseBlock(
            id=_string(body, "id"),
            name=_string(body, "name"),
            input=_object(body, "input"),
        )
    return TextBlock(text=_string(body, "text"))


def _response_from_json(entry: dict[str, Any]) -> LLMResponse:
    payload: Any = entry.get("response")
    if not isinstance(payload, dict):
        raise LLMError("replay_miss")
    body = cast(dict[str, Any], payload)
    blocks = tuple(_block_from_json(block) for block in _rows(body, "blocks"))
    usage: Any = body.get("usage")
    usage_body = cast(dict[str, Any], usage) if isinstance(usage, dict) else {}
    cost: Any = usage_body.get("estimated_cost_usd")
    return LLMResponse(
        blocks=blocks,
        stop_reason=_string(body, "stop_reason") or "end_turn",
        usage=Usage(
            provider=_string(usage_body, "provider"),
            model=_string(usage_body, "model"),
            input_tokens=_number(usage_body, "input_tokens"),
            output_tokens=_number(usage_body, "output_tokens"),
            cache_read_tokens=_number(usage_body, "cache_read_tokens"),
            latency_ms=_number(usage_body, "latency_ms"),
            estimated_cost_usd=None if cost is None else Decimal(str(cost)),
        ),
    )


def _data_document(request: LLMRequest) -> dict[str, Any]:
    """The newest data document in the conversation, or ``unsupported``.

    The fake answers exactly three prompt layouts, told apart by their single
    top-level key (``_DOCUMENT_KEYS``). Any other request is a programming error
    (a new call site forgot it has no fake), not a model failure, so it raises
    rather than inventing an answer.

    Searched from the LAST user message backwards, which in a tool loop reaches
    past the tool-result turns to the ONE document the first user turn carries.
    """
    for message in reversed(request.messages):
        if message.role != "user":
            continue
        for part in message.content:
            if not isinstance(part, TextPart):
                continue
            try:
                parsed: Any = json.loads(part.text)
            except ValueError:
                continue
            if isinstance(parsed, dict) and any(
                key in parsed for key in _DOCUMENT_KEYS
            ):
                return cast(dict[str, Any], parsed)
    raise LLMError("unsupported")


def _rows(body: dict[str, Any], key: str) -> list[dict[str, Any]]:
    value: Any = body.get(key)
    if not isinstance(value, list):
        return []
    rows: list[Any] = cast(list[Any], value)
    return [cast(dict[str, Any], row) for row in rows if isinstance(row, dict)]


def _object(body: dict[str, Any], key: str) -> dict[str, Any]:
    value: Any = body.get(key)
    return cast(dict[str, Any], value) if isinstance(value, dict) else {}


def _string(body: dict[str, Any] | None, key: str) -> str:
    if body is None:
        return ""
    value: Any = body.get(key)
    return value if isinstance(value, str) else ""


def _number(body: dict[str, Any], key: str) -> int:
    value: Any = body.get(key)
    return value if isinstance(value, int) and not isinstance(value, bool) else 0
