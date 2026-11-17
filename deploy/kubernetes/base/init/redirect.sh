#!/bin/sh
# The init container (docs/pod.md, "網"): the sandbox's outbound TCP and name
# lookups, IPv4 and IPv6, go to the Sentinel. Its loopback is left alone, and
# so is every other UID's traffic. Link-local addresses are redirected like
# any other, for the Sentinel to refuse.
#
# The plain iptables and ip6tables are not called. In a distroless-iptables
# image they are a wrapper that picks nft or legacy on the first call and
# writes a link for it, which fails on a read-only root file system. Only
# iptables-nft is named, and there is no way down to legacy: if the rules
# cannot be set, the container fails. The restore replaces the whole nat
# table, so the rules do not pile up when the init container runs again (no
# one else uses the nat table of the Pod's network namespace).
set -eu

uid="${SANDBOX_UID:-1000}"
proxy="${PROXY_PORT:-15001}"
dns="${DNS_PORT:-15053}"

rules() {
  cat <<EOF
*nat
:PREROUTING ACCEPT [0:0]
:INPUT ACCEPT [0:0]
:OUTPUT ACCEPT [0:0]
:POSTROUTING ACCEPT [0:0]
:PENELOPE_SANDBOX - [0:0]
-A PENELOPE_SANDBOX -o lo -j RETURN
-A PENELOPE_SANDBOX -p udp --dport 53 -j REDIRECT --to-ports ${dns}
-A PENELOPE_SANDBOX -p tcp --dport 53 -j REDIRECT --to-ports ${dns}
-A PENELOPE_SANDBOX -p tcp -j REDIRECT --to-ports ${proxy}
-A OUTPUT -m owner --uid-owner ${uid} -j PENELOPE_SANDBOX
COMMIT
EOF
}

rules | iptables-nft-restore
rules | ip6tables-nft-restore
iptables-nft-save -t nat
ip6tables-nft-save -t nat
