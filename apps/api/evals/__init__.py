"""Offline evaluation of the LLM categorize pass — not part of the served app.

A package (rather than two loose scripts) for one reason: ``tests/
test_evals_regression.py`` imports :mod:`evals.run` and calls its ``evaluate``
in-process, so the CI regression is an ordinary pytest test with no subprocess
and no network. ``pyproject.toml`` carries ``pythonpath = ["."]`` for that
import and ``"evals"`` in pyright's include list, so this directory is held to
the same gates as ``src/``.

Nothing here is imported by ``budget_api``; the dependency goes one way only
(``evals`` → ``budget_api.llm`` + ``budget_api.services.categorize``).
"""
