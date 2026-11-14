package proxy

import "net/netip"

// The IPv6 forms that carry an IPv4 address, so that no form of a
// link-local IPv4 address passes as some other IPv6 one. Ported from
// natsumi-sentinel's internal/upstream/addr.go.
var (
	// nat64 (RFC 6052) carries an IPv4 address in its last 32 bits.
	nat64 = netip.MustParsePrefix("64:ff9b::/96")
	// sixToFour (RFC 3056) carries an IPv4 address in bits 16 to 47, and
	// compatible (the IPv4-compatible form RFC 4291 deprecates) in its
	// last 32 bits.
	sixToFour  = netip.MustParsePrefix("2002::/16")
	compatible = netip.MustParsePrefix("::/96")
)

// carried is the IPv4 address a carries in one of the IPv6 forms that
// carry one, or a itself.
func carried(a netip.Addr) netip.Addr {
	a = a.Unmap()
	if !a.Is6() {
		return a
	}
	b := a.As16()
	switch {
	case nat64.Contains(a), compatible.Contains(a):
		return netip.AddrFrom4([4]byte{b[12], b[13], b[14], b[15]})
	case sixToFour.Contains(a):
		return netip.AddrFrom4([4]byte{b[2], b[3], b[4], b[5]})
	}
	return a
}

// linkLocal reports whether a is link-local (169.254.0.0/16, fe80::/10),
// in any of its forms: the cloud's metadata and the like (ADR-0014).
func linkLocal(a netip.Addr) bool {
	c := carried(a)
	return c.IsLinkLocalUnicast() || c.IsLinkLocalMulticast()
}
