#!/bin/sh
# Puts the counts of natsumi's side and of the copy side by side (docs/
# migrate-from-natsumi.md, "照らす"). Run as root in the migrate Pod after
# copy.sh. Each line is "<what>: <natsumi> <copy>"; the two numbers are the
# same when the copy is whole. Only counts and exit codes are printed, never a
# file name, a commit message or what is in a file.
set -u

old=/old
memory=/new/memory/memory
work=/new/state/home/work

entries() { find "$1" | wc -l; }
# The bytes of the regular files: unlike du, the same on any file system.
bytes() { find "$1" -type f -printf '%s\n' | awk '{ s += $1 } END { print s + 0 }'; }
g() { git -c safe.directory='*' --no-optional-locks -C "$@"; }

echo "memory entries: $(entries "$old/memory") $(entries "$memory")"
echo "memory bytes: $(bytes "$old/memory") $(bytes "$memory")"
echo "commits: $(g "$old/memory" rev-list --count HEAD) $(g "$memory" rev-list --count HEAD)"
echo "uncommitted: $(g "$old/memory" status --porcelain | wc -l) $(g "$memory" status --porcelain | wc -l)"
echo "work entries: $(entries "$old/work") $(entries "$work")"
echo "work bytes: $(bytes "$old/work") $(bytes "$work")"
g "$memory" fsck --no-progress >/dev/null 2>&1
echo "fsck of the copy: $?"
# The backend copies the chosen avatar into memory only when memory has none.
if [ -e "$memory/avatar" ]; then echo "memory avatar/: there"; else echo "memory avatar/: none"; fi
