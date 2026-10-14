"""One class, three modes: a synthetic model, a replay store, a recorder.

Why it lives in ``src/`` and not in ``tests/``: ``LLM_PROVIDER=fake`` has to work
on a live QA stand with no API key, and the evals CLI records and replays with no
application around it. A fake wired up in the test package could do neither.

* ``fake`` — answers the categorize data document (see ``services/categorize.py``
  for its layout) with a substring match: the first category of the operation's
  kind whose NAME appears in the operation's text wins with confidence 0.9,
  anything else is ``"none"`` with 0.2. An operation whose text contains
  ``LLMFAIL`` makes the whole call raise ``LLMError("unavailable")`` — that is how
  a router test gets an honest ``partial`` import without a provider outage.
  It is a substring matcher and nothing more: a test that asserts WHICH category
  it picked is asserting the matcher, not the behaviour under test.
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
import time
from decimal import Decimal
from pathlib import Path
from typing import Any, cast

from budget_api.llm.errors import LLMError
from budget_api.llm.types import (
    LLMProvider,
    LLMRequest,
    LLMResponse,
    TextBlock,
    TextPart,
    Usage,
    part_json,
)

#: Put this in an operation's text to make the fake provider fail the call.
FAIL_MARKER = "LLMFAIL"

#: What the fake answers when nothing matches — the sentinel the categorize schema
#: offers instead of a nullable enum (plan disagreement 3).
_UNSURE = "none"

_MATCH_CONFIDENCE = 0.9
_NO_MATCH_CONFIDENCE = 0.2


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
        if request.tools:
            raise LLMError("unsupported")
        if self.mode == "record":
            return await self._record(request)
        if self.mode == "replay":
            return await self._replay(request)
        return self._invent(request)

    # --- fake -------------------------------------------------------------

    def _invent(self, request: LLMRequest) -> LLMResponse:
        started = time.perf_counter()
        document = _data_document(request)
        categories = _rows(document, "categories")
        operations = _rows(document, "operations")
        results: list[dict[str, Any]] = []
        for operation in operations:
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
        return LLMResponse(
            blocks=(TextBlock(text=json.dumps({"results": results})),),
            stop_reason="end_turn",
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


def request_key(provider: str, model: str, request: LLMRequest) -> str:
    """The replay key: ``sha256`` of the canonical JSON of the whole call.

    ONE function for both arms, so a recorded fixture and a replay lookup cannot
    drift. The system prompt and the output schema are part of the key by design:
    editing either invalidates the fixtures, which is the intended loud failure
    (regenerate them and bump ``PROMPT_VERSION``).
    """
    canonical = {
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
    blob = json.dumps(canonical, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _response_json(response: LLMResponse) -> dict[str, Any]:
    cost = response.usage.estimated_cost_usd
    return {
        "blocks": [
            {"type": "text", "text": block.text}
            for block in response.blocks
            if isinstance(block, TextBlock)
        ],
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


def _response_from_json(entry: dict[str, Any]) -> LLMResponse:
    payload: Any = entry.get("response")
    if not isinstance(payload, dict):
        raise LLMError("replay_miss")
    body = cast(dict[str, Any], payload)
    blocks = tuple(
        TextBlock(text=_string(block, "text")) for block in _rows(body, "blocks")
    )
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
    """The JSON document of the LAST user message, or ``unsupported``.

    The fake answers exactly one prompt layout — the categorize data document. Any
    other request is a programming error (a new call site forgot it has no fake),
    not a model failure, so it raises rather than inventing an answer.
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
            if isinstance(parsed, dict) and "operations" in parsed:
                return cast(dict[str, Any], parsed)
    raise LLMError("unsupported")


def _rows(body: dict[str, Any], key: str) -> list[dict[str, Any]]:
    value: Any = body.get(key)
    if not isinstance(value, list):
        return []
    rows: list[Any] = cast(list[Any], value)
    return [cast(dict[str, Any], row) for row in rows if isinstance(row, dict)]


def _string(body: dict[str, Any] | None, key: str) -> str:
    if body is None:
        return ""
    value: Any = body.get(key)
    return value if isinstance(value, str) else ""


def _number(body: dict[str, Any], key: str) -> int:
    value: Any = body.get(key)
    return value if isinstance(value, int) and not isinstance(value, bool) else 0
