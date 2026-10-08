# MinIO server + mc client, built from the official source at pinned tags.
# MinIO stopped publishing free images (Docker Hub and quay both refuse
# minio/minio and minio/mc), so production builds the same release the dev
# stack runs. One image serves the minio, minio-init and mc services.
FROM golang:1.24-alpine AS build
RUN apk add --no-cache git
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
ARG MINIO_TAG=RELEASE.2025-04-22T22-12-26Z
ARG MC_TAG=RELEASE.2025-04-16T18-13-26Z
RUN git clone --depth 1 --branch "$MINIO_TAG" https://github.com/minio/minio.git /src/minio \
 && cd /src/minio && go build -trimpath -ldflags "-s -w" -o /out/minio .
RUN git clone --depth 1 --branch "$MC_TAG" https://github.com/minio/mc.git /src/mc \
 && cd /src/mc && go build -trimpath -ldflags "-s -w" -o /out/mc .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=build /out/minio /out/mc /usr/bin/
ENTRYPOINT ["minio"]
