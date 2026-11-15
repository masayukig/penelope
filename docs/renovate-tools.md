# Tool version detection

`make test-renovate` checks the Dockerfile ARG inventory, extraction, sample
release tags, replacement values, and rejection of unrelated/prerelease tags.
It is also part of `make test`, which CI already runs. The tests use Node's
built-in test runner and need no npm install. Renovate's own configuration
validator and local `--dry-run=extract` can additionally validate the managers.

## Sandbox downloads

The versions are declared only in `Dockerfile`; `fetch-tools.sh` consumes them
from the environment. Each ARG has a custom regex manager using
`github-releases`. Releases provide publication times for the shared two-day
wait, rather than inferring availability from source tags. The shared presets'
update, grouping and automerge policies are unchanged.

| ARG | Repository | Release tag example | Value given to fetch-tools.sh |
| --- | --- | --- | --- |
| KUBECTL_VERSION | kubernetes/kubernetes | v1.36.6 | v1.36.6 |
| HELM_VERSION | helm/helm | v4.3.1 | v4.3.1 |
| KUSTOMIZE_VERSION | kubernetes-sigs/kustomize | kustomize/v5.8.3 | v5.8.3 |
| SOPS_VERSION | getsops/sops | v3.13.3 | v3.13.3 |
| GH_VERSION | cli/cli | v2.103.3 | 2.103.3 |
| VMCTL_VERSION | yuanying/vmapi | v0.2.0 | v0.2.0 |
| A2A_VERSION | a2aproject/a2a-cli | v0.2.0 | 0.2.0 |

GitHub release tags and asset names were checked against the download script.
Kustomize also publishes `kyaml/`, `cmd/config/`, and other module releases:
only `kustomize/vX.Y.Z` is eligible. Its script supplies the `kustomize/` URL
prefix. gh and a2a assets omit `v`, but their release tags include it; their
script supplies the `v` URL prefix. vmctl is published by **vmapi**, with `v`
in both the tag and archive name. kubectl binaries/checksums live at
dl.k8s.io and Helm archives/checksums at get.helm.sh; their GitHub releases
provide the corresponding version tags, not the actual download locations.

## Other audited version sources

- Node and Go images, including `e2e/Dockerfile`: existing custom managers
  use `node-version` and `golang-version`. Existing grouping pairs them with
  setup-node and go.mod respectively, and disables duplicate Docker proposals.
- porkadot: existing `github-tags` manager; the gem is built from its source
  tag rather than downloaded from RubyGems. This remains unchanged.
- uv (`COPY --from=ghcr.io/astral-sh/uv:...`), the distroless base and the
  Dockerfile syntax frontend: the built-in `dockerfile` manager extracts them.
- CI actions, setup-node versions and runner labels: built-in `github-actions`.
  setup-go reads go.mod rather than carrying another version. `ubuntu-latest`
  is a moving hosted-runner label, not a pinned Ubuntu package release.
- golangci-lint and govulncheck: go.mod tool dependencies, extracted by `gomod`.
  TypeScript, Pi, and other npm dependencies: built-in `npm` and the lockfile.
- Makefile and shell scripts: no additional fixed third-party tool versions.
  The release scripts' VERSION and e2e image tags are this repository's own
  build/release inputs, not external dependencies to update.

## Limits

No fixed external tool version found by this audit is left without a manager.
Unversioned apt packages (including Ruby and Python) follow Debian's package
repositories on image rebuild, not Renovate version PRs. Renovate extraction
reports these as `unspecified-version`. porkadot's transitive gems are resolved
by its gemspec at build time, not pinned here. Moving image tags such as
`nonroot` do not make package contents reproducible; this change does not add
digest pinning or change base-image policy.

Detection does not rebuild upstream Go binaries. In particular, discovering a
new a2a release does not by itself prove that its embedded Go runtime is free
of CVEs. Version upgrades and vulnerability checks of the resulting image
remain separate from this detection change.
