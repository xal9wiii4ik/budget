"""What every eval runner needs: a provider, a replay store, percentiles, a report.

Lifted out of ``run.py`` when the second and third runners arrived
(``extract.py``, ``reconcile.py``) and deliberately BEHAVIOUR-FREE: every
function here is the one ``run.py`` already had, moved verbatim, because
``tests/test_evals_regression.py``'s categorize tests are the guard that the lift
changed nothing. ``run.py`` keeps its CLI and its public names.

The three honesty rules of ``run.py``'s docstring are enforced from here, so all
three runners obey them identically:

* ``--prompt-version`` must equal the code's ``PROMPT_VERSION``
  (:func:`validate_run`) — a report naming a prompt it did not use is worse than
  no report;
* a replay store that cannot answer raises :class:`EvalError`, never a silent 0%
  (each runner detects its own kind of miss and calls :func:`replay_miss`);
* a report produced by the ``fake`` provider says so in its own first lines
  (:func:`synthetic_banner`) and carries ``synthetic: true`` in its JSON.
"""

import json
import logging
import math
import uuid
from collections.abc import Mapping, Sequence
from decimal import Decimal
from pathlib import Path
from typing import Any, cast

from budget_api.config import Settings
from budget_api.llm import LLMProvider, LLMRequest, LLMResponse, Usage, build_provider

logger = logging.getLogger("evals.common")

EVALS_DIR = Path(__file__).resolve().parent
DATASET_DIR = EVALS_DIR / "dataset"
REPLAY_DIR = EVALS_DIR / "replay"
REPORTS_DIR = EVALS_DIR / "reports"

#: Provider → the SETTINGS FIELD that names its default model, so a run with no
#: ``--model`` measures what the server would actually send. ``fake`` is absent
#: and falls back to the id ``fake``, which keeps a synthetic fixture and report
#: from ever colliding with a real model's.
MODEL_SETTINGS = {"anthropic": "categorize_model", "ollama": "ollama_model"}

MODES = ("live", "record", "replay")
PROVIDERS = ("anthropic", "ollama", "fake")


class EvalError(RuntimeError):
    """A run that must not produce a number: bad inputs, or an unanswered row."""


def validate_run(provider_name: str, mode: str, prompt_version: str, code: str) -> None:
    """The three refusals every runner shares, in this order."""
    if prompt_version != code:
        raise EvalError(
            f"this build speaks prompt {code!r}, not {prompt_version!r}"
            " — check out the matching revision instead of mislabelling a report"
        )
    if provider_name not in PROVIDERS:
        raise EvalError(
            f"unknown provider {provider_name!r}, expected one of {PROVIDERS}"
        )
    if mode not in MODES:
        raise EvalError(f"unknown mode {mode!r}, expected one of {MODES}")


def default_model(provider_name: str) -> str:
    """The model a run uses when ``--model`` is absent: the app's own default."""
    setting = MODEL_SETTINGS.get(provider_name)
    return setting_str(setting) if setting else "fake"


def eval_provider(
    provider_name: str, model: str, *, mode: str, replay_path: Path, api_key: str
) -> LLMProvider:
    """The provider the APP would build, in the eval's mode. Never ``None``.

    ``build_provider`` answers ``None`` for "this server has no AI configured",
    which is a legitimate state for the app and never one for a measurement.
    """
    provider = build_provider(
        provider_name,
        model,
        api_key=api_key,
        ollama_base_url=setting_str("ollama_base_url"),
        timeout=setting_float("llm_timeout_seconds"),
        replay_path=str(replay_path) if mode != "live" else "",
        mode=mode,
    )
    if provider is None:
        raise EvalError(
            f"provider {provider_name!r} is not configured"
            " (an Anthropic run needs ANTHROPIC_API_KEY)"
        )
    return provider


class UsageProvider:
    """A pass-through provider that KEEPS every answer's :class:`Usage`.

    Two of the three passes under measurement (``alfa_pdf.extract_from_text``)
    report their cost only to the log, because an import session has no use for
    it. The evals do: calls, tokens, cost and latency are half of what a report
    is for. A FAILED call records nothing — it raises out of here exactly as the
    inner provider raised it, and the runner counts it as the failure it is.
    """

    def __init__(self, inner: LLMProvider) -> None:
        self.name = inner.name
        self.model = inner.model
        self.calls: list[Usage] = []
        self._inner = inner

    async def complete(self, request: LLMRequest) -> LLMResponse:
        response = await self._inner.complete(request)
        self.calls.append(response.usage)
        return response


def replay_file(
    replay_dir: Path, provider_name: str, model: str, prompt_version: str
) -> Path:
    """``<replay-dir>/<provider>-<model>-<prompt-version>.jsonl``, name-safe."""
    return replay_dir / f"{slug(provider_name)}-{slug(model)}-{prompt_version}.jsonl"


def replay_header(provider_name: str) -> dict[str, Any]:
    """The first line of a fixture: who produced it and whether it is real.

    ``fake.FakeProvider`` skips a line with no ``"key"``, so the provenance is
    free — and a reader opening the file sees it before 200 hashes.
    """
    if provider_name == "fake":
        return {
            "produced_by": "fake",
            "synthetic": True,
            "note": (
                "recorded from the deterministic FakeProvider, NOT a real model;"
                " replace after the first live run"
            ),
        }
    return {
        "produced_by": provider_name,
        "synthetic": False,
        "note": f"recorded from a live {provider_name} run",
    }


def start_fixture(path: Path, provider_name: str) -> None:
    """Truncate the fixture and write its provenance header.

    A record run APPENDS, so without this a second run would double every entry
    and the store would carry two generations of answers at once.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(replay_header(provider_name), ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    logger.info("recording into %s", path)


def replay_miss(
    path: Path, answered: int, total: int, unit: str, detail: str = ""
) -> EvalError:
    """The one thing a regression test must never see is a silent 0%."""
    return EvalError(
        f"replay store {path} answered {answered}/{total} {unit}"
        f"{f' ({detail})' if detail else ''}"
        " — the fixture does not match this prompt, schema or dataset:"
        " re-record it with --mode record."
        " Refusing to report a number for a run that did not happen"
    )


def synthetic_banner(provider_name: str) -> list[str]:
    """The markdown header a ``fake`` report carries instead of a quality claim."""
    if provider_name != "fake":
        return []
    return [
        "> **SYNTHETIC RUN — not a model quality number.** The `fake` provider",
        "> in `llm/fake.py` answers a KNOWN layout with a regex (extraction) or",
        "> a fixed script (the reconcile loop); it is not an oracle and it was",
        "> not tuned to look good. This report exists to show the pipeline and",
        "> to pin its mechanics in CI. No real-model numbers exist until someone",
        "> runs `--mode live` with a key.",
        "",
    ]


def write_report(
    reports_dir: Path, stem: str, markdown: str, payload: Mapping[str, Any]
) -> tuple[Path, Path]:
    """``<reports-dir>/<stem>.{md,json}``. The stem is the runner's own."""
    reports_dir.mkdir(parents=True, exist_ok=True)
    markdown_path = reports_dir / f"{stem}.md"
    data_path = reports_dir / f"{stem}.json"
    markdown_path.write_text(markdown, encoding="utf-8")
    data_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return (markdown_path, data_path)


def percentile(values: Sequence[int], share: float) -> int | None:
    """Nearest-rank percentile: no interpolation on 20-odd samples."""
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, math.ceil(share * len(ordered)) - 1)
    return ordered[index]


def total_cost(calls: Sequence[Usage]) -> Decimal | None:
    """Σ of the estimates, or ``None`` when ANY call had no published price.

    A partial sum would read as a cheap run; "n/a" reads as what it is.
    """
    if not calls:
        return None
    total = Decimal(0)
    for usage in calls:
        if usage.estimated_cost_usd is None:
            return None
        total += usage.estimated_cost_usd
    return total


def pct(share: float) -> str:
    return f"{share * 100:.1f}%"


def ratio(hits: int, total: int) -> float:
    """``hits / total``, and 0.0 for an empty denominator — never a ZeroDivision."""
    return hits / total if total else 0.0


def cost_text(cost: Decimal | None) -> str:
    return "n/a" if cost is None else f"${cost:f}"


def ms_text(value: int | None) -> str:
    return "n/a" if value is None else f"{value} ms"


def slug(value: str) -> str:
    return value.replace("/", "-").replace(":", "-").replace(" ", "-")


def jsonl(path: Path) -> list[dict[str, Any]]:
    """Every non-blank line of a JSONL file. A malformed line is an error."""
    bodies = [
        json_object(line, f"{path}:{number}")
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1)
        if line.strip()
    ]
    if not bodies:
        raise EvalError(f"dataset {path} has no rows")
    return bodies


def json_object(blob: str, where: str) -> dict[str, Any]:
    try:
        parsed: Any = json.loads(blob)
    except ValueError as exc:
        raise EvalError(f"{where}: not JSON ({exc})") from exc
    if not isinstance(parsed, dict):
        raise EvalError(f"{where}: expected a JSON object")
    return cast(dict[str, Any], parsed)


def json_text(body: Mapping[str, Any], field: str, where: str) -> str:
    value: Any = body.get(field)
    if not isinstance(value, str) or not value:
        raise EvalError(f"{where}: field {field!r} must be a non-empty string")
    return value


def json_integer(body: Mapping[str, Any], field: str, where: str) -> int:
    value: Any = body.get(field)
    if isinstance(value, bool) or not isinstance(value, int):
        raise EvalError(f"{where}: field {field!r} must be an integer")
    return value


def json_uuid(body: Mapping[str, Any], field: str, where: str) -> uuid.UUID:
    try:
        return uuid.UUID(json_text(body, field, where))
    except ValueError as exc:
        raise EvalError(f"{where}: field {field!r} is not a UUID") from exc


def json_optional_integer(
    body: Mapping[str, Any], field: str, where: str
) -> int | None:
    value: Any = body.get(field)
    if value is None:
        return None
    return json_integer(body, field, where)


def json_optional_text(body: Mapping[str, Any], field: str, where: str) -> str | None:
    value: Any = body.get(field)
    if value is None:
        return None
    return json_text(body, field, where)


def json_optional_uuid(
    body: Mapping[str, Any], field: str, where: str
) -> uuid.UUID | None:
    value: Any = body.get(field)
    if value is None:
        return None
    return json_uuid(body, field, where)


def json_strings(body: Mapping[str, Any], field: str, where: str) -> list[str]:
    value: Any = body.get(field)
    if not isinstance(value, list):
        raise EvalError(f"{where}: field {field!r} must be an array of strings")
    items = cast(list[Any], value)
    if not all(isinstance(item, str) for item in items):
        raise EvalError(f"{where}: field {field!r} must be an array of strings")
    return cast(list[str], items)


def json_objects(
    body: Mapping[str, Any], field: str, where: str
) -> list[dict[str, Any]]:
    value: Any = body.get(field)
    if not isinstance(value, list):
        raise EvalError(f"{where}: field {field!r} must be an array of objects")
    items = cast(list[Any], value)
    if not all(isinstance(item, dict) for item in items):
        raise EvalError(f"{where}: field {field!r} must be an array of objects")
    return cast(list[dict[str, Any]], items)


def setting_str(name: str) -> str:
    value: Any = Settings.model_fields[name].default
    if not isinstance(value, str):
        raise EvalError(f"setting {name!r} has no string default")
    return value


def setting_int(name: str) -> int:
    value: Any = Settings.model_fields[name].default
    if isinstance(value, bool) or not isinstance(value, int):
        raise EvalError(f"setting {name!r} has no integer default")
    return value


def setting_float(name: str) -> float:
    value: Any = Settings.model_fields[name].default
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise EvalError(f"setting {name!r} has no numeric default")
    return float(value)
