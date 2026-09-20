"""Response size guard: a 3000-row dump burns the model's context and answers nothing.

Over the threshold the LONGEST array is cut from the tail and the cut is stated in
the payload — a silent cut would let the model quote a total it never saw. Ported
from the TypeScript server's ``truncate.ts``, thresholds and note included.
"""

import json
from typing import Any, cast

#: Starting value from the MCP architecture §5; tune after real traffic.
THRESHOLD_BYTES = 50_000

TRUNCATION_NOTE = "response truncated, narrow the query (dates/category/limit)"

#: Compact, like ``JSON.stringify`` — the same bytes the transport will carry, so
#: the guard measures the payload rather than pretty-printing whitespace.
_COMPACT = (",", ":")


def dumps(value: Any) -> str:
    """The wire form of a tool result — one place, so measuring == sending."""
    return json.dumps(value, separators=_COMPACT, ensure_ascii=False)


def byte_length(value: Any) -> int:
    return len(dumps(value).encode("utf-8"))


def _longest_array(value: Any) -> tuple[str | None, list[Any]] | None:
    """The array to cut: the response itself, or its longest list-valued key."""
    if isinstance(value, list):
        return None, cast("list[Any]", value)
    if not isinstance(value, dict):
        return None
    record = cast("dict[str, Any]", value)
    best: tuple[str | None, list[Any]] | None = None
    for key, raw in record.items():
        if isinstance(raw, list):
            entry = cast("list[Any]", raw)
            if best is None or len(entry) > len(best[1]):
                best = (key, entry)
    return best


def _cut(value: Any, key: str | None, array: list[Any], shown: int) -> Any:
    marker = {"shown": shown, "total": len(array), "note": TRUNCATION_NOTE}
    items = array[:shown]
    # A bare array has nowhere to carry the marker, so it becomes {items, _truncated}.
    if key is None:
        return {"items": items, "_truncated": marker}
    return {**value, key: items, "_truncated": marker}


def truncate_response(value: Any, threshold_bytes: int = THRESHOLD_BYTES) -> Any:
    """Halve the longest array from the tail until the payload fits.

    ONE element is always kept: a single row over the threshold reaches the caller
    with an honest marker rather than as an empty shell.
    """
    if byte_length(value) <= threshold_bytes:
        return value

    target = _longest_array(value)
    if target is None or len(target[1]) <= 1:
        return value
    key, array = target

    shown = len(array)
    result: Any = value
    while True:
        shown = max(1, shown // 2)
        result = _cut(value, key, array, shown)
        if shown <= 1 or byte_length(result) <= threshold_bytes:
            return result
