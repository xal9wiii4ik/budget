"""Which provider this process talks to — the only place that decision is made.

Two entry points on purpose:

* :func:`build_provider` takes explicit arguments and is what the evals CLI calls
  (it has flags, not Settings).
* :func:`provider_from_settings` is what ``app.py`` calls, and it is where
  amendment A1 lives: the MODEL depends on the provider, because one shared knob
  would ask Ollama for ``claude-haiku-5-5`` and degrade every call silently.

"Not configured" is a ``None`` return, never an exception: a server with no API key
must boot, serve imports and read ``ai_status=not_configured`` (architecture §7).
"""

import logging
from pathlib import Path

import httpx

from budget_api.config import Settings
from budget_api.llm.anthropic import AnthropicProvider
from budget_api.llm.fake import FakeProvider
from budget_api.llm.ollama import OllamaProvider
from budget_api.llm.types import LLMProvider

logger = logging.getLogger(__name__)

#: Everything ``llm_provider`` may name. ``off`` is the explicit "no AI here".
PROVIDERS = frozenset({"anthropic", "ollama", "fake", "off"})


def build_provider(
    provider: str,
    model: str,
    *,
    api_key: str = "",
    ollama_base_url: str,
    timeout: float,
    replay_path: str = "",
    mode: str = "live",
    http_client: httpx.AsyncClient | None = None,
) -> LLMProvider | None:
    """Build the named provider, or ``None`` when this server has no AI configured.

    ``mode`` is the evals dimension and is orthogonal to ``provider``: ``live``
    calls the provider itself, ``record`` wraps it and appends every answer to
    ``replay_path``, ``replay`` makes no call at all and reads answers out of
    ``replay_path``. Replay still needs the ``(provider, model)`` pair, because
    the replay key contains it: a fixture recorded from ``anthropic`` is found
    only by a lookup that says ``anthropic``, not by one that says ``fake``.
    """
    if mode == "replay":
        return FakeProvider(
            mode="replay",
            store_path=_store(replay_path),
            name=provider,
            model=model,
        )
    live = _live_provider(
        provider,
        model,
        api_key=api_key,
        ollama_base_url=ollama_base_url,
        timeout=timeout,
        http_client=http_client,
    )
    if mode == "record":
        if live is None:
            return None
        return FakeProvider(mode="record", store_path=_store(replay_path), inner=live)
    if mode != "live":
        raise ValueError(f"unknown provider mode: {mode}")
    return live


def provider_from_settings(settings: Settings) -> LLMProvider | None:
    """The app's provider, or ``None`` = not configured. Never raises, never I/O."""
    model = (
        settings.ollama_model
        if settings.llm_provider == "ollama"
        else settings.categorize_model
    )
    return build_provider(
        settings.llm_provider,
        model,
        api_key=settings.anthropic_api_key,
        ollama_base_url=settings.ollama_base_url,
        timeout=settings.llm_timeout_seconds,
    )


def _live_provider(
    provider: str,
    model: str,
    *,
    api_key: str,
    ollama_base_url: str,
    timeout: float,
    http_client: httpx.AsyncClient | None,
) -> LLMProvider | None:
    if provider == "anthropic":
        if not api_key:
            # The shared ``anthropic_api_key`` (receipts, advisor) is empty: this
            # is the DEFAULT state of a fresh deployment, not a misconfiguration.
            return None
        return AnthropicProvider(
            model=model, api_key=api_key, timeout=timeout, http_client=http_client
        )
    if provider == "ollama":
        return OllamaProvider(
            model=model,
            base_url=ollama_base_url,
            timeout=timeout,
            http_client=http_client,
        )
    if provider == "fake":
        return FakeProvider(mode="fake")
    if provider != "off":
        logger.warning(
            "unknown LLM_PROVIDER %r — AI features stay off (expected one of %s)",
            provider,
            ", ".join(sorted(PROVIDERS)),
        )
    return None


def _store(replay_path: str) -> Path:
    if not replay_path:
        raise ValueError("replay and record modes need a replay_path")
    return Path(replay_path)
