// Package origdst reads where a redirected connection was going: the
// destination the sandbox's process connected to before iptables REDIRECT
// pointed it at the Sentinel (ADR-0003).
package origdst

import (
	"errors"
	"net"
	"net/netip"
)

// ErrNotTCP is returned for a connection that is not a TCP socket.
var ErrNotTCP = errors.New("not a TCP connection")

// Lookup returns the original destination of c, which must be a
// *net.TCPConn accepted on a listener that iptables redirects to. A
// connection that reached the listener without being redirected has no
// original destination of its own: Linux answers with the listener's own
// address, or with an error when it kept no record of the connection.
func Lookup(c net.Conn) (netip.AddrPort, error) {
	tc, ok := c.(*net.TCPConn)
	if !ok {
		return netip.AddrPort{}, ErrNotTCP
	}
	return lookup(tc)
}
