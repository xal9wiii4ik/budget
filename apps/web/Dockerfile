# syntax=docker/dockerfile:1

# The build context is the REPO ROOT, not apps/web: the SPA imports @budget/shared
# and @budget/api-client as workspace packages, so pnpm needs the whole workspace
# to resolve them.

# --- Builder: install the frozen workspace, build the SPA ---
FROM node:22-bookworm-slim AS builder

RUN corepack enable

WORKDIR /repo

# Cache the dependency layer: manifests and the lockfile before any source.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
COPY packages/api-client/package.json ./packages/api-client/
RUN pnpm install --frozen-lockfile --filter @budget/web...

COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/api-client ./packages/api-client
COPY apps/web ./apps/web

# Vite inlines env at BUILD time, so the API URL is an argument, not a runtime
# variable: changing it means rebuilding the image, which is why compose passes it
# as a build arg rather than an environment entry.
ARG VITE_API_URL=http://localhost:8010
ENV VITE_API_URL=${VITE_API_URL}

RUN pnpm --filter @budget/web build

# --- Runtime: nginx serving the static bundle ---
FROM nginx:1.27-alpine AS runtime

COPY --from=builder /repo/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
