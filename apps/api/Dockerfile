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

# --- Model: the embedding artifact, fetched and CHECKSUMMED at build time ---
# Its own stage so the 118 MB download lands in a layer keyed by the MANIFEST
# BYTES: a rebuild that did not touch the pins re-downloads nothing, and the
# builder stage above keeps its own cache key. The artifact is never fetched at
# runtime — the API only VERIFIES it against this same manifest at boot
# (embeddings/manifest.py). A build that cannot reach huggingface.co FAILS here,
# by design (amendment A4): an image that silently shipped without the model
# would answer 503 on search with no explanation anywhere.
FROM python:3.12-slim-bookworm AS model

WORKDIR /build

COPY model_manifest.json scripts/fetch_model.py ./
RUN python -I fetch_model.py --manifest model_manifest.json \
    --dest /models/multilingual-e5-small

# --- Runtime: slim image, non-root, venv + alembic only ---
FROM python:3.12-slim-bookworm AS runtime

RUN groupadd --gid 1000 app \
    && useradd --uid 1000 --gid 1000 --create-home app

WORKDIR /app

COPY --from=builder --chown=app:app /app/.venv /app/.venv
COPY --chown=app:app src ./src
COPY --chown=app:app alembic.ini ./alembic.ini
COPY --chown=app:app alembic ./alembic
# BOTH halves of the artifact pin travel into the image: the files, and the
# manifest ``OnnxEmbedder.load()`` re-verifies them against. Without the manifest
# the server could not tell a tampered model from the right one — and the default
# EMBEDDINGS_MANIFEST_PATH is relative to the workdir, so this is the path it
# resolves to in here (``apps/api/model_manifest.json`` on a dev host).
COPY --chown=app:app model_manifest.json ./model_manifest.json
COPY --from=model --chown=app:app /models /app/models

ENV PATH="/app/.venv/bin:$PATH"

USER app

EXPOSE 8000

CMD ["uvicorn", "budget_api.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
