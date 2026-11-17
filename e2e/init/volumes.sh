#!/bin/sh
# Gives each volume the owner that the Pod's fsGroup and the deployment give
# it (docs/pod.md, "volume"), and puts Pi's settings in the sandbox's home.
# Docker makes a named volume root's; a Pod would not.
set -eu

chown 1000:1000 /volumes/home
# The work tree of /memory is the sandbox's, in the group the two share, so
# that the backend can put her avatar in it (docs/pod.md, "アバター").
chown 1000:2000 /volumes/memory
chmod 2770 /volumes/memory
for dir in memory-git sources database intake sandbox-socket admin-socket; do
  chown 1001:1001 "/volumes/$dir"
done

mkdir -p /volumes/home/.pi/agent
cp /e2e/config/models.json /volumes/home/.pi/agent/models.json
chown -R 1000:1000 /volumes/home/.pi
