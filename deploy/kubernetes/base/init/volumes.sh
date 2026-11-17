#!/bin/sh
# The init container "volumes" (README.md, "Volumes and owners"). Makes the
# places on the two PVCs with the owner and mode of the container that uses
# them, in place of the Pod's fsGroup, and leaves a place that is already
# there alone (owner, mode and contents). Pi's model settings (models.json)
# are written into the sandbox's home on every start.
#
#   PVC penelope         /volume/home      /home/agent of the sandbox (1000, 0700)
#                        /volume/backend   the backend's SQLite and copies (1001, 0700)
#                        /volume/sources   /sources (written by the backend, read by the sandbox)
#   PVC penelope-memory  /volume/memory/memory       the /memory work tree (sandbox; the
#                                                backend makes avatar/ in it)
#                        /volume/memory/memory/.git  its .git (backend)
#
# The shared places belong to group 2000 (the Pod's supplementalGroups) with
# the setgid bit, so what one side makes the other reads through the group.
set -eu

v=/volume
make() { # <dir> <owner> <mode>
  if [ ! -d "$v/$1" ]; then
    mkdir -p "$v/$1"
    chown "$2" "$v/$1"
    chmod "$3" "$v/$1"
  fi
}
make home 1000:1000 0700
make home/.pi 1000:1000 0700
make home/.pi/agent 1000:1000 0700
make backend 1001:1001 0700
make sources 1001:2000 2770
# .git is made here too. Without it, the kubelet makes the sandbox's subPath
# (memory/.git) as root's, and the backend cannot write it. The backend runs
# git init before its first commit.
make memory/memory 1000:2000 2770
make memory/memory/.git 1001:2000 2770

install -o 1000 -g 1000 -m 0600 /etc/penelope/models/models.json "$v/home/.pi/agent/models.json"
ls -ldn "$v/home" "$v/backend" "$v/sources" "$v/memory/memory" "$v/memory/memory/.git" "$v/home/.pi/agent/models.json"
