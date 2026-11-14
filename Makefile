# penelope
#
# The one entry point for both languages: the Sentinel is Go, everything else
# is TypeScript (ADR-0001). CI calls these targets and nothing else, so there is
# nothing that can be run in CI but not on a laptop.
#
# `make test` passes with nothing but the Go and Node toolchains and is the loop
# to stay in while developing. Tests that need more than that (a cluster, root,
# an outside service) go behind a target or a build tag of their own, so that
# `make test` never picks them up.
#
# golangci-lint and govulncheck are declared in go.mod's tool directive and run
# through `go tool`, so every checkout runs the same version and nothing is
# installed globally.

SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

GO ?= go

# The version written into the binaries and the images. The release workflow
# passes the tag.
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS ?= -s -w -X main.version=$(VERSION)

##@ General

.PHONY: help
help: ## Show this help.
	@awk 'BEGIN {FS = ":.*##"} \
		/^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) } \
		/^[a-zA-Z0-9_-]+:.*?##/ { printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

##@ Build

.PHONY: build
build: ## Build the Sentinel into bin/.
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags "$(LDFLAGS)" -o bin/sentinel ./cmd/sentinel

##@ Check

# gofmt is given the module's package directories rather than `.`, so that it
# skips what go.mod ignores (node_modules/ and packages/).
.PHONY: fmt
fmt: ## Format the Go source.
	$(GO) fmt ./...

.PHONY: fmt-check
fmt-check: ## Fail if any Go file is not gofmt'd.
	@unformatted="$$(gofmt -l $$($(GO) list -f '{{.Dir}}' ./...))"; \
	if [ -n "$$unformatted" ]; then \
		echo "Not gofmt'd. Run \`make fmt\`:"; \
		echo "$$unformatted" | sed 's/^/  /'; \
		exit 1; \
	fi

.PHONY: vet
vet: ## Run go vet over every package.
	$(GO) vet ./...

.PHONY: lint
lint: ## Run golangci-lint.
	$(GO) tool golangci-lint run ./...

.PHONY: lint-fix
lint-fix: ## Run golangci-lint and apply the fixes it can make itself.
	$(GO) tool golangci-lint run --fix ./...

.PHONY: vuln
vuln: ## Report known vulnerabilities in the code paths the Go module calls.
	$(GO) tool govulncheck ./...

##@ Test

.PHONY: test
test: test-go ## Unit tests of both languages. Need nothing but the toolchains.

.PHONY: test-go
test-go: ## Unit tests of the Go module.
	$(GO) test ./...

##@ Housekeeping

.PHONY: tidy
tidy: ## Tidy go.mod and go.sum.
	$(GO) mod tidy

.PHONY: clean
clean: ## Remove build artifacts.
	rm -rf bin
