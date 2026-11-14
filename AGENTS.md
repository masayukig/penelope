# AGENTS.md

Guidance for agents and people working on this repository.

## Design decisions

Design decisions are recorded as ADRs in [docs/adr/](docs/adr/). The index is [docs/adr/README.md](docs/adr/README.md).
ADRs are written in Japanese. Read the related ADRs before changing a design, and record a new decision as a new ADR.

## Design principles

- Keep the implementation and the design simple. Anything specific to one service or one source is a plugin.
- When porting code from natsumi, design the architecture first and port what fits it cleanly. Do not copy natsumi's
  structure as it is.

## Prompts (system prompt, tool descriptions, turn inputs)

- State facts and the environment; leave the how to the agent. Do not pile up instructions and prohibitions.
- The system prompt carries only: who she is (name, role, owner), where she is (the sandbox, egress through the
  Sentinel, the internal CA), how events arrive and how to answer, and the shape of `/memory`.
- Writing rules, procedures and per-event handling do not go in the prompt. What is needed goes in the owner's
  `always.md` or a skill.
- A line that must hold is enforced by the system (the Sentinel, the read-only `.git` of `/memory`), not by a sentence.
- Prompts are written in English. The language she speaks with the owner is left to `personality.md`.
- Personality, always-memory and the handoff are appended as they are (Japanese memory stays Japanese).

## Public repository

- This repository is public. Do not write key or token values, inside domain names, IP addresses in the home network
  or the cluster, or private host names.
- Refer to hosts by their role (the model API, GitHub, the VM API, the cluster API server). Use made-up values (such
  as `example.com`) in examples.
- Those values live only in the deployment repository.

## Development

The `Makefile` is the entry point for both languages, and CI only calls its targets. `make help` lists them.

| Part | Language | Where | Image (Dockerfile target) |
| --- | --- | --- | --- |
| Sentinel | Go | `cmd/sentinel/`, `internal/` | `ghcr.io/yuanying/penelope-sentinel` (`sentinel`) |
| backend | TypeScript | `packages/backend` | `ghcr.io/yuanying/penelope-backend` (`backend`) |
| runner | TypeScript | `packages/runner` | in the sandbox image |
| sandbox image | Dockerfile | `Dockerfile` | `ghcr.io/yuanying/penelope-sandbox` (`sandbox`) |
| receivers | TypeScript | `packages/receivers` | `ghcr.io/yuanying/penelope-receivers` (`receivers`) |
| Web UI | TypeScript | `packages/web` | served by the backend |
| shared types | TypeScript | `packages/contract` | — |

- The Go module is the repository root. go.mod ignores `node_modules/` and `packages/`.
- The TypeScript parts are npm workspaces under `packages/`. Each has `typecheck`, `test` (`node --test`) and
  `build` (`tsc`) scripts where it has code; the root's scripts run them in every workspace.
- Before pushing, run what CI runs: `make fmt-check vet typecheck lint test tidy vuln images`, and check that
  `git status --porcelain` is empty.

### Tests

- `make test` runs `go test ./...` and the tests of every workspace. It passes with nothing but the Go and Node
  toolchains: no cluster, no root, no outside service.
- A test that needs more than that goes behind a make target and, in Go, a build tag of its own, so that `make test`
  never picks it up.

### Versions

- Development tools are versioned by the repository: golangci-lint and govulncheck in go.mod's `tool` directive,
  TypeScript in the root's `devDependencies`. Nothing is installed globally.
- The Node of the Dockerfile and of `setup-node` in the workflows are the same version, and so are the Go of the
  Dockerfile and go.mod's `go` directive. Renovate keeps each pair in one group; change them together.

### Releases

- A `vX.Y.Z` tag builds every target of the Dockerfile for linux/amd64 and linux/arm64, pushes it to ghcr.io and makes
  a GitHub Release. A tag is pushed by hand.
- Every Monday, the next patch version is released on its own when every commit since the latest tag is Renovate's
  (`.github/scripts/plan-release.sh` decides and says why).
