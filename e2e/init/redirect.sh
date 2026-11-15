#!/bin/sh
# The init container (docs/pod.md, "網"): the sandbox's outbound TCP and name
# lookups, IPv4 and IPv6, go to the Sentinel. Its loopback is left alone, and
# so is every other UID's traffic. Link-local addresses are redirected like
# any other, for the Sentinel to refuse.
set -eu

uid="${SANDBOX_UID:-1000}"
proxy="${PROXY_PORT:-15001}"
dns="${DNS_PORT:-15053}"

for ipt in iptables ip6tables; do
  "$ipt" -t nat -N PENELOPE_SANDBOX
  "$ipt" -t nat -A PENELOPE_SANDBOX -o lo -j RETURN
  "$ipt" -t nat -A PENELOPE_SANDBOX -p udp --dport 53 -j REDIRECT --to-ports "$dns"
  "$ipt" -t nat -A PENELOPE_SANDBOX -p tcp --dport 53 -j REDIRECT --to-ports "$dns"
  "$ipt" -t nat -A PENELOPE_SANDBOX -p tcp -j REDIRECT --to-ports "$proxy"
  "$ipt" -t nat -A OUTPUT -m owner --uid-owner "$uid" -j PENELOPE_SANDBOX
done
iptables -t nat -S
ip6tables -t nat -S
