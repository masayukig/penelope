#!/bin/sh
# The sandbox's entrypoint. The Sentinel's CA certificate is mounted at start
# (docs/pod.md, "CA"); it is added to the system bundle that the image keeps
# writable by the sandbox's user, so that every tool which reads the system
# bundle, or SSL_CERT_FILE, NODE_EXTRA_CA_CERTS and REQUESTS_CA_BUNDLE that
# point at it, trusts the Sentinel. Without a mounted CA the bundle is
# Debian's as it is. Then the runner runs with the given arguments.
set -eu

ca_dir="${PENELOPE_CA_DIR:-/etc/penelope/ca}"
debian=/usr/share/penelope/ca-certificates.crt
bundle=/etc/ssl/certs/ca-certificates.crt

found=false
for cert in "$ca_dir"/*.crt; do
  if [ -f "$cert" ]; then found=true; fi
done
if [ "$found" = true ]; then
  cat "$debian" "$ca_dir"/*.crt > "$bundle"
fi

exec node /opt/penelope/runner/dist/main.js "$@"
