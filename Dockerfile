# syntax=docker/dockerfile:1
#
# One Dockerfile for every image of a release (ADR-0001), one target each:
#
#   sentinel   ghcr.io/yuanying/penelope-sentinel
#   backend    ghcr.io/yuanying/penelope-backend
#   receivers  ghcr.io/yuanying/penelope-receivers
#   sandbox    ghcr.io/yuanying/penelope-sandbox (the runner inside)
#
# The build stages run on the builder's own platform and only their output is
# copied into the image of the target platform: Go cross-compiles, and what tsc
# writes is the same on every platform. The one exception is the backend's
# final stage, which installs git. VERSION is the release's tag.
#
# The Node here and the Node of setup-node in the workflows are the same
# version, kept so by Renovate's node group.

ARG VERSION=dev

FROM --platform=$BUILDPLATFORM golang:1.27.4-trixie AS sentinel-build
ARG TARGETOS TARGETARCH VERSION
WORKDIR /src
# Only go.mod, go.sum and the source. `go build` fetches the modules the
# Sentinel imports and not the tools go.mod also lists.
COPY go.mod go.sum ./
COPY cmd ./cmd
RUN --mount=type=cache,target=/root/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/sentinel ./cmd/sentinel

FROM --platform=$BUILDPLATFORM node:24.22.3-trixie-slim AS ts-build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci
RUN npm run build

# The backend's runtime dependencies, without the dev tools. The links npm
# makes to the workspaces are dropped: only the backend's dist is copied.
FROM --platform=$BUILDPLATFORM node:24.22.3-trixie-slim AS backend-deps
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --omit=dev --workspace @penelope/backend && rm -rf node_modules/@penelope

# A static binary needs no more than this. nonroot runs it as UID 65532.
FROM gcr.io/distroless/static-debian13:nonroot AS sentinel
COPY --from=sentinel-build /out/sentinel /sentinel
ENTRYPOINT ["/sentinel"]

# The TypeScript images carry the package's package.json (it makes dist/ ES
# modules) and what tsc wrote, and the runtime dependencies of those that have
# any, installed with npm ci --omit=dev.
#
# Each container of the Pod runs as a UID of its own (docs/pod.md): the
# sandbox's outbound traffic is sent to the Sentinel by its UID, so no other
# container may share it. backend is 1001 and receivers 1002, by number with
# no user entry; the volumes they share are made writable by the Pod's
# fsGroup.
#
# The backend runs git to commit /memory (ADR-0006). This RUN is the only one
# in a final stage, so the release builds it for arm64 under QEMU. The
# warning that node:sqlite is experimental is turned off: there is nothing to
# act on in it.
FROM node:24.22.3-trixie-slim AS backend
RUN apt-get update \
    && apt-get install --yes --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
ARG VERSION
ENV NODE_ENV=production PENELOPE_VERSION=${VERSION}
WORKDIR /app
COPY --from=ts-build /src/packages/backend/package.json ./
COPY --from=backend-deps /src/node_modules ./node_modules
COPY --from=ts-build /src/packages/backend/dist ./dist
USER 1001:1001
ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "/app/dist/main.js"]
CMD ["serve"]

FROM node:24.22.3-trixie-slim AS receivers
ARG VERSION
ENV NODE_ENV=production PENELOPE_VERSION=${VERSION}
WORKDIR /app
COPY --from=ts-build /src/packages/receivers/package.json ./
COPY --from=ts-build /src/packages/receivers/dist ./dist
USER 1002:1002
ENTRYPOINT ["node", "/app/dist/main.js"]

# Only the runner for now. The development tools, the Sentinel's CA and the
# generic user and HOME (ADR-0011) come with the sandbox image's own work;
# until then it runs as the node image's user, UID 1000.
FROM node:24.22.3-trixie-slim AS sandbox
ARG VERSION
ENV NODE_ENV=production PENELOPE_VERSION=${VERSION}
WORKDIR /opt/penelope/runner
COPY --from=ts-build /src/packages/runner/package.json ./
COPY --from=ts-build /src/packages/runner/dist ./dist
USER node
ENTRYPOINT ["node", "/opt/penelope/runner/dist/main.js"]
