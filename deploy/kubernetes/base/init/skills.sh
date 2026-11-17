#!/bin/sh
# The init container "skills" (README.md, "Skills"). Puts the deployment's
# own skills into the emptyDir /skills, which the sandbox reads through
# PENELOPE_OWNER_SKILLS_DIR (docs/pod.md). The skills that come with the
# sandbox image are not copied here: they work without the deployment.
#
# What to put comes from the optional ConfigMap penelope-skills, mounted at
# /etc/penelope/skills:
#   <name>.SKILL.md  written as /skills/<name>/SKILL.md
#   skills.list      one line per repository: <git URL> <branch> <skill>...
#                    Each <skill> is the directory skills/<skill> of that
#                    repository. Blank lines and lines starting with # are
#                    skipped.
#
# It runs before the redirect, as a UID other than the sandbox's, so it
# reaches the repositories directly; they have to be public. A skill that
# cannot be fetched is left out and the Pod still starts; the log says so.
set -u

in=/etc/penelope/skills
out=/skills
work=/tmp/skills

for f in "$in"/*.SKILL.md; do
  [ -f "$f" ] || continue
  name=$(basename "$f" .SKILL.md)
  mkdir -p "$out/$name"
  cp "$f" "$out/$name/SKILL.md"
  echo "skills: $name (ConfigMap)"
done

[ -f "$in/skills.list" ] || exit 0

n=0
grep -v '^[[:space:]]*\(#\|$\)' "$in/skills.list" | while read -r repo branch skills; do
  n=$((n + 1))
  dir="$work/$n"
  rm -rf "$dir"
  if ! git clone --quiet --depth 1 --branch "$branch" "$repo" "$dir"; then
    echo "skills: $repo could not be fetched; left out: $skills" >&2
    continue
  fi
  for s in $skills; do
    if [ -f "$dir/skills/$s/SKILL.md" ]; then
      rm -rf "${out:?}/$s"
      cp -R "$dir/skills/$s" "$out/$s"
      echo "skills: $s ($repo $(git -C "$dir" rev-parse --short HEAD))"
    else
      echo "skills: $s is not in $repo; left out" >&2
    fi
  done
done
rm -rf "$work"
exit 0
