#!/usr/bin/env bash
#
# Decides a release made without a person (weekly-release.yml). The next
# patch version is released only when every commit since the latest vX.Y.Z
# tag, merge commits aside, is a bot's (Renovate's or the vulnerability
# responder's), and they changed something that goes into a release.
# Anything a person wrote is left to a tag pushed by hand.
#
#   .github/scripts/plan-release.sh [--vuln-fix] [repository]
#
# The weekly run calls it bare. --vuln-fix is for the run that starts when a
# pull request of the vulnerability responder's is merged: the tag says it is
# a vulnerability fix, and when the release is held back, the reason, the
# commits that held it and the commands to release by hand go to
# $GITHUB_STEP_SUMMARY.
#
# Prints the reason. When $GITHUB_OUTPUT is set, writes `version` (empty when
# nothing is released) and `message`, the annotation for the tag.
#
# What does not go into a release is matched by RELEASE_IGNORE, an extended
# regular expression over the paths `git diff --name-only` prints. Workflows,
# the Renovate config, documentation and deploy/ (the Kubernetes example and
# the migrate manifests, which go into no image) change nothing a user runs.

set -euo pipefail

# Renovate, and the vulnerability responder (the GitHub App
# fraction-vuln-responder, whose pull requests raise a dependency or the base
# image to fix a vulnerability).
bots="renovate[bot]
fraction-vuln-responder[bot]"
ignore="${RELEASE_IGNORE:-^(\.github/|renovate\.json$|docs/|deploy/|.*\.md$)}"

trigger=weekly
if [[ "${1:-}" == "--vuln-fix" ]]; then
  trigger=vuln-fix
  shift
fi

cd "${1:-.}"

output() {
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s\n' "$@" >> "${GITHUB_OUTPUT}"
  fi
}

summary() {
  if [[ "${trigger}" == "vuln-fix" && -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$@" >> "${GITHUB_STEP_SUMMARY}"
  fi
}

no_release() {
  echo "no release: $1"
  output "version="
  summary "## The vulnerability fix was not released at once" "" "Reason: $1" ""
}

next_version() {
  local major minor patch
  IFS=. read -r major minor patch <<< "${tag#v}"
  echo "v${major}.${minor}.$((patch + 1))"
}

tag="$(git tag --list --merged HEAD 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1 || true)"
if [[ -z "${tag}" ]]; then
  no_release "no vX.Y.Z tag is reachable from HEAD"
  exit 0
fi

authors="$(git log --no-merges --format=%an "${tag}..HEAD" | sort -u)"
if [[ -z "${authors}" ]]; then
  no_release "there are no commits since ${tag}"
  exit 0
fi

others="$(grep -vxF "${bots}" <<< "${authors}" || true)"
if [[ -n "${others}" ]]; then
  no_release "commits since ${tag} by $(paste -sd, - <<< "${others}") are left to a release by hand"
  # The commits that held the fix back, and how to release HEAD by hand. A
  # tag pushed by a person starts release.yml, which pushes the images.
  version="$(next_version)"
  held="$(git log --no-merges --reverse --format='%h%x09%an%x09%s' "${tag}..HEAD" \
    | awk -F '\t' 'NR == FNR { bot[$0] = 1; next } !($2 in bot) { printf "- `%s` %s (%s)\n", $1, $3, $2 }' \
      <(printf '%s\n' "${bots}") -)"
  summary "### Commits since ${tag} that are not a bot's" "" "${held}" "" \
    "### To release by hand" "" \
    "Check what changed, write it in the tag's message and push the tag (raise the version to fit the change)." "" \
    '```sh' \
    "git fetch origin --tags" \
    "git tag -a ${version} -m \"${version}: <what changed>\" $(git rev-parse HEAD)" \
    "git push origin refs/tags/${version}" \
    '```' ""
  exit 0
fi

changed="$(git diff --name-only "${tag}" HEAD | grep -vE "${ignore}" || true)"
if [[ -z "${changed}" ]]; then
  no_release "the bots' commits since ${tag} change nothing that is released"
  exit 0
fi

version="$(next_version)"
subjects="$(git log --no-merges --reverse --format='- %s' "${tag}..HEAD")"
if [[ "${trigger}" == "vuln-fix" ]]; then
  title="vulnerability fix, released as soon as the vulnerability responder's pull request was merged"
else
  title="dependency updates, released weekly as the commits are bots' alone"
fi

echo "release ${version}: the bots' commits since ${tag} change $(paste -sd, - <<< "${changed}")"
delimiter="EOF-$$-${RANDOM}"
output "version=${version}" \
  "message<<${delimiter}" \
  "${version}: ${title}" \
  "" \
  "${subjects}" \
  "${delimiter}"
