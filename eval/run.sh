#!/usr/bin/env bash
# Run this copy of the experiment against the two specified repository trees.
set -euo pipefail
if [[ $# != 3 || ( $1 != fake && $1 != live ) ]]; then
  echo 'usage: bash eval/run.sh fake|live BASE_REF CANDIDATE_REF' >&2
  exit 2
fi
mode=$1
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
base=$(git -C "$repo" rev-parse --verify --end-of-options "$2^{commit}")
candidate=$(git -C "$repo" rev-parse --verify --end-of-options "$3^{commit}")
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT

for label in base candidate; do
  ref=${!label}
  code=$root/$label
  mkdir -p "$code"
  git -C "$repo" archive "$ref" | tar -x -C "$code"
  mkdir -p "$code/night-eval"
  cp "$here"/*.ts "$code/night-eval/"
  (
    cd "$code"
    env -u EVAL_API_KEY npm ci --no-audit --no-fund >&2
    export HOME="$code/replay/home" TZ=UTC
    export PI_CODING_AGENT_DIR="$HOME/.pi/agent"
    node --conditions=penelope-source night-eval/replay.ts "$mode" "$label" "$ref"
  )
done
