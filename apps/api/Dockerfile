# syntax=docker/dockerfile:1

# --- Builder: resolve and install the frozen environment via uv ---
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS builder

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

WORKDIR /app

# Cache the dependency layer: install deps without the project first.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# Install the project itself.
COPY src ./src
RUN uv sync --frozen --no-dev

# --- Runtime: slim image, non-root, venv + alembic only ---
FROM python:3.12-slim-bookworm AS runtime

RUN groupadd --gid 1000 app \
    && useradd --uid 1000 --gid 1000 --create-home app

WORKDIR /app

COPY --from=builder --chown=app:app /app/.venv /app/.venv
COPY --chown=app:app src ./src
COPY --chown=app:app alembic.ini ./alembic.ini
COPY --chown=app:app alembic ./alembic

ENV PATH="/app/.venv/bin:$PATH"

USER app

EXPOSE 8000

CMD ["uvicorn", "budget_api.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
