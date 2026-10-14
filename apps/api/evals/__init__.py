"""Offline evaluation of the app's LLM passes — not part of the served app.

Three runners, one per measured pass: ``run.py`` (categorize), ``extract.py``
(the Alfa-PDF extraction) and ``reconcile.py`` (the reconcile agent). What they
share — provider building, the replay store, percentiles, the report writer —
lives in ``common.py``, and the two synthetic datasets are produced by
``gen_alfa.py`` and ``gen_reconcile.py``.

A package (rather than loose scripts) for one reason: ``tests/
test_evals_regression.py`` imports the runners and calls them in-process, so the
CI regression is an ordinary pytest test with no subprocess and no network.
``pyproject.toml`` carries ``pythonpath = ["."]`` for that import and ``"evals"``
in pyright's include list, so this directory is held to the same gates as
``src/``. Each runner also fixes ``sys.path`` when it is executed as a SCRIPT
(``uv run python evals/extract.py …``, the documented command), because then
only ``evals/`` itself is on the path.

Nothing here is imported by ``budget_api``; the dependency goes one way only
(``evals`` → ``budget_api.llm`` + the three measured services + stdlib).
"""
