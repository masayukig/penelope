package dns

import (
	"errors"
	"net"
	"net/netip"

	"golang.org/x/sys/unix"
)

// serveUDPFromDst answers each query from the address it reached, which the
// kernel tells with IP_PKTINFO (IPV6_PKTINFO). A query that iptables
// redirected to the listener reached the address it was redirected to, and
// its reply has to leave from there for the redirection to be undone on the
// way back: a listener on every address would otherwise answer from the
// address the route to the client prefers, and a client that connected its
// socket (glibc, Node) drops that answer. It reports false when the socket
// cannot be told to give the addresses, and ServeUDP serves it as it is.
func (s *Server) serveUDPFromDst(c *net.UDPConn) (bool, error) {
	v4 := false
	if a, ok := c.LocalAddr().(*net.UDPAddr); ok && a.IP.To4() != nil {
		v4 = true
	}
	raw, err := c.SyscallConn()
	if err != nil {
		return false, nil
	}
	var serr error
	if err := raw.Control(func(fd uintptr) {
		if v4 {
			serr = unix.SetsockoptInt(int(fd), unix.IPPROTO_IP, unix.IP_PKTINFO, 1)
		} else {
			serr = unix.SetsockoptInt(int(fd), unix.IPPROTO_IPV6, unix.IPV6_RECVPKTINFO, 1)
		}
	}); err != nil || serr != nil {
		return false, nil
	}

	buf := make([]byte, 65535)
	oob := make([]byte, 512)
	for {
		n, oobn, _, from, err := c.ReadMsgUDPAddrPort(buf, oob)
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return true, nil
			}
			return true, err
		}
		q := append([]byte(nil), buf[:n]...)
		src := replySource(oob[:oobn])
		go func() {
			resp := s.relay("udp", q, net.UDPAddrFromAddrPort(from))
			if resp != nil {
				_, _, _ = c.WriteMsgUDPAddrPort(resp, src, from)
			}
		}()
	}
}

// replySource is the control message that makes a reply leave from the
// address the query reached, or nil when the query's messages do not say it.
func replySource(oob []byte) []byte {
	msgs, err := unix.ParseSocketControlMessage(oob)
	if err != nil {
		return nil
	}
	for _, m := range msgs {
		switch {
		case m.Header.Level == unix.IPPROTO_IP && m.Header.Type == unix.IP_PKTINFO && len(m.Data) >= 12:
			// struct in_pktinfo: the interface, the local address, then the header's destination.
			dst, _ := netip.AddrFromSlice(m.Data[8:12])
			return unix.PktInfo4(&unix.Inet4Pktinfo{Spec_dst: dst.As4()})
		case m.Header.Level == unix.IPPROTO_IPV6 && m.Header.Type == unix.IPV6_PKTINFO && len(m.Data) >= 16:
			// struct in6_pktinfo: the destination, then the interface.
			dst, _ := netip.AddrFromSlice(m.Data[0:16])
			return unix.PktInfo6(&unix.Inet6Pktinfo{Addr: dst.As16()})
		}
	}
	return nil
}
