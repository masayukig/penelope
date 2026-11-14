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
# writes is the same on every platform. The sandbox's final stage is the one
# exception: it installs Debian's packages, so building it for another
# platform needs QEMU. VERSION is the release's tag.
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

# A static binary needs no more than this. nonroot runs it as UID 65532.
FROM gcr.io/distroless/static-debian13:nonroot AS sentinel
COPY --from=sentinel-build /out/sentinel /sentinel
ENTRYPOINT ["/sentinel"]

# The TypeScript images carry the package's package.json (it makes dist/ ES
# modules) and what tsc wrote. The packages have no runtime dependencies yet;
# the one that gets the first installs it here with npm ci --omit=dev.
FROM node:24.22.3-trixie-slim AS backend
ARG VERSION
ENV NODE_ENV=production PENELOPE_VERSION=${VERSION}
WORKDIR /app
COPY --from=ts-build /src/packages/backend/package.json ./
COPY --from=ts-build /src/packages/backend/dist ./dist
USER node
ENTRYPOINT ["node", "/app/dist/main.js"]

FROM node:24.22.3-trixie-slim AS receivers
ARG VERSION
ENV NODE_ENV=production PENELOPE_VERSION=${VERSION}
WORKDIR /app
COPY --from=ts-build /src/packages/receivers/package.json ./
COPY --from=ts-build /src/packages/receivers/dist ./dist
USER node
ENTRYPOINT ["node", "/app/dist/main.js"]

# The runner's runtime dependencies. None of them is built for a platform, so
# they are installed here on the builder's own and copied as they are.
FROM --platform=$BUILDPLATFORM node:24.22.3-trixie-slim AS runner-deps
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --omit=dev --ignore-scripts --workspace=@penelope/runner \
    && rm -rf node_modules/@penelope

# The single-binary tools of the sandbox, fetched for the target's
# architecture and checked against their releases' checksums. Renovate does
# not read these versions yet; they are raised by hand.
FROM --platform=$BUILDPLATFORM golang:1.27.4-trixie AS sandbox-tools
ARG TARGETARCH
ARG KUBECTL_VERSION=v1.36.6
ARG HELM_VERSION=v4.3.1
ARG KUSTOMIZE_VERSION=v5.8.3
ARG SOPS_VERSION=v3.13.3
ARG GH_VERSION=2.103.3
ARG VMCTL_VERSION=v0.2.0
ARG A2A_VERSION=0.2.0
COPY packages/runner/image/fetch-tools.sh /fetch-tools.sh
RUN KUBECTL_VERSION=$KUBECTL_VERSION HELM_VERSION=$HELM_VERSION KUSTOMIZE_VERSION=$KUSTOMIZE_VERSION \
    SOPS_VERSION=$SOPS_VERSION GH_VERSION=$GH_VERSION VMCTL_VERSION=$VMCTL_VERSION A2A_VERSION=$A2A_VERSION \
    /fetch-tools.sh "$TARGETARCH" /out

# The Go toolchain of the target platform, copied whole.
FROM golang:1.27.4-trixie AS sandbox-go

# The sandbox (ADR-0011): Debian, Node, the development tools and the runner.
# The user is `agent`, UID 1000, with HOME /home/agent; it takes the place of
# the node image's user of the same UID. /home/agent, /memory and Pi's
# directory under HOME are mounted from the Pod's persistent volumes.
#
# The Sentinel's CA is added at start by the entrypoint, from a volume, to the
# system bundle (docs/pod.md, "CA"). The bundle is kept writable by `agent`
# for that, with Debian's own copy beside it to start from each time.
FROM node:24.22.3-trixie-slim AS sandbox
ARG VERSION
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash ca-certificates curl fd-find file git jq less make openssh-client procps \
        python3 python3-venv ripgrep ruby unzip xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && userdel --remove node \
    && useradd --uid 1000 --user-group --create-home --home-dir /home/agent --shell /bin/bash agent \
    && mkdir -p /usr/share/penelope /etc/penelope/ca \
    && cp /etc/ssl/certs/ca-certificates.crt /usr/share/penelope/ca-certificates.crt \
    && chown agent:agent /etc/ssl/certs/ca-certificates.crt
COPY --from=sandbox-go /usr/local/go /usr/local/go
COPY --from=ghcr.io/astral-sh/uv:0.13.7 /uv /uvx /usr/local/bin/
COPY --from=sandbox-tools /out/ /usr/local/bin/
COPY packages/runner/image/entrypoint.sh /usr/local/bin/penelope-sandbox
WORKDIR /opt/penelope/runner
COPY --from=ts-build /src/packages/runner/package.json ./
COPY --from=ts-build /src/packages/runner/dist ./dist
COPY --from=runner-deps /src/node_modules ./node_modules
ENV NODE_ENV=production PENELOPE_VERSION=${VERSION} \
    HOME=/home/agent USER=agent \
    PATH=/home/agent/.local/bin:/home/agent/go/bin:/usr/local/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
USER agent
WORKDIR /home/agent
ENTRYPOINT ["/usr/local/bin/penelope-sandbox"]
CMD ["run"]
