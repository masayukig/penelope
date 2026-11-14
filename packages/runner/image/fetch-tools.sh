#!/usr/bin/env bash
# Fetches the single-binary tools of the sandbox image for one architecture
# into a directory, each checked against the checksums its release publishes.
# Runs on the builder's own platform, so the image's final stage needs to run
# nothing for them (ADR-0011).
#
#   fetch-tools.sh <amd64|arm64> <out dir>
#
# The versions come from the environment (the Dockerfile's ARGs).
set -euo pipefail

arch="$1"
out="$2"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$out"

# fetch <url> <file>: download into the work directory.
fetch() { curl -fsSL --retry 3 -o "$work/$2" "$1"; }

# check <file> <checksums file>: the file's line of a sha256sum list must match.
check() {
  (cd "$work" && grep -E "[ *]$1\$" "$2" | sed 's/ \*/  /' | sha256sum -c --quiet -)
}

github() { echo "https://github.com/$1/releases/download/$2"; }

# kubectl: the checksum file holds the hash alone.
fetch "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl" kubectl
fetch "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl.sha256" kubectl.sha256
echo "$(cat "$work/kubectl.sha256")  kubectl" > "$work/kubectl.sums"
check kubectl kubectl.sums
install -m 0755 "$work/kubectl" "$out/kubectl"

# helm
helm="helm-${HELM_VERSION}-linux-${arch}.tar.gz"
fetch "https://get.helm.sh/${helm}" "$helm"
fetch "https://get.helm.sh/${helm}.sha256sum" helm.sums
check "$helm" helm.sums
tar -xzf "$work/$helm" -C "$work" "linux-${arch}/helm"
install -m 0755 "$work/linux-${arch}/helm" "$out/helm"

# kustomize
kustomize="kustomize_${KUSTOMIZE_VERSION}_linux_${arch}.tar.gz"
fetch "$(github kubernetes-sigs/kustomize "kustomize/${KUSTOMIZE_VERSION}")/${kustomize}" "$kustomize"
fetch "$(github kubernetes-sigs/kustomize "kustomize/${KUSTOMIZE_VERSION}")/checksums.txt" kustomize.sums
check "$kustomize" kustomize.sums
tar -xzf "$work/$kustomize" -C "$out" kustomize

# sops
sops="sops-${SOPS_VERSION}.linux.${arch}"
fetch "$(github getsops/sops "$SOPS_VERSION")/${sops}" "$sops"
fetch "$(github getsops/sops "$SOPS_VERSION")/sops-${SOPS_VERSION}.checksums.txt" sops.sums
check "$sops" sops.sums
install -m 0755 "$work/$sops" "$out/sops"

# gh
gh="gh_${GH_VERSION}_linux_${arch}"
fetch "$(github cli/cli "v${GH_VERSION}")/${gh}.tar.gz" "${gh}.tar.gz"
fetch "$(github cli/cli "v${GH_VERSION}")/gh_${GH_VERSION}_checksums.txt" gh.sums
check "${gh}.tar.gz" gh.sums
tar -xzf "$work/${gh}.tar.gz" -C "$work" "${gh}/bin/gh"
install -m 0755 "$work/${gh}/bin/gh" "$out/gh"

# vmctl, the CLI of the VM API
vmctl="vmctl_${VMCTL_VERSION}_linux_${arch}.tar.gz"
fetch "$(github yuanying/vmapi "$VMCTL_VERSION")/${vmctl}" "$vmctl"
fetch "$(github yuanying/vmapi "$VMCTL_VERSION")/checksums.txt" vmctl.sums
check "$vmctl" vmctl.sums
tar -xzf "$work/$vmctl" -C "$out" vmctl

# a2a, the A2A CLI
a2a="a2a_${A2A_VERSION}_linux_${arch}.tar.gz"
fetch "$(github a2aproject/a2a-cli "v${A2A_VERSION}")/${a2a}" "$a2a"
fetch "$(github a2aproject/a2a-cli "v${A2A_VERSION}")/checksums.txt" a2a.sums
check "$a2a" a2a.sums
tar -xzf "$work/$a2a" -C "$out" a2a

chmod 0755 "$out"/*
