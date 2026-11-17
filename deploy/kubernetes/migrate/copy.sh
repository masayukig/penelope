#!/bin/sh
# Copies natsumi's memory (the work tree and .git, so its whole history) and
# its work place into the new PVCs, and gives them the owners and modes of
# base/init/volumes.sh (docs/migrate-from-natsumi.md, "写す"). Run as root in
# the migrate Pod (pod.yaml), with natsumi stopped.
#
#   /old/memory/  ->  /new/memory/memory/       (/memory; work tree 1000:2000, .git 1001:2000)
#   /old/work/    ->  /new/state/home/work/     (~/work; 1000:1000, the modes kept)
#
# What is in them is hers and has secrets in it: nothing here prints a file
# name or what is in one. Only fixed places, counts and sizes are printed.
# It refuses to copy into a place that is not empty, so that it never mixes
# two copies.
set -eu

old=/old
memory=/new/memory/memory
home=/new/state/home

for d in "$old/memory/.git" "$old/work"; do
  if [ ! -d "$d" ]; then
    echo "copy: $d is not there; is the subPath of the volume natsumi the data directory?" >&2
    exit 1
  fi
done

install -d -o 1000 -g 1000 -m 0700 "$home"
install -d -o 1000 -g 2000 -m 2770 "$memory"
if [ -n "$(ls -A "$memory")" ]; then
  echo "copy: $memory is not empty" >&2
  exit 1
fi
if [ -e "$home/work" ]; then
  echo "copy: $home/work is already there" >&2
  exit 1
fi

cp -a "$old/memory/." "$memory/"
cp -a "$old/work" "$home/work"

chown -hR 1000:2000 "$memory"
chown -hR 1001:2000 "$memory/.git"
chmod -R g+rwX,o-rwx "$memory"
find "$memory" -type d -exec chmod g+s {} +
chown -hR 1000:1000 "$home/work"

stat -c '%u:%g %a %n' "$memory" "$memory/.git" "$home" "$home/work"
