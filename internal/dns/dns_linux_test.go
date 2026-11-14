//go:build linux

package dns_test

import (
	"net"
	"testing"
	"time"

	"github.com/yuanying/penelope/internal/dns"
)

// A query that reached the listener at an address other than the one a reply
// would go out from by default is answered from the address it reached. That
// is what a query redirected by iptables needs: its reply has to come from
// the address it was redirected to, for the redirection to be undone on the
// way back to a client that connected its socket (glibc, Node). Here the
// listener takes every address and the query comes to 127.0.0.2 from
// 127.0.0.1, so a reply from the default address, 127.0.0.1, is not the
// connected client's.
func TestAQueryOverUDPIsAnsweredFromTheAddressItReached(t *testing.T) {
	up := upstreamUDP(t)
	s := dns.New(dns.Config{Upstream: up, Log: &recorder{}, Owners: owners{}})
	pc, err := net.ListenPacket("udp4", "0.0.0.0:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = s.ServeUDP(pc) }()
	t.Cleanup(func() { _ = pc.Close() })
	port := pc.LocalAddr().(*net.UDPAddr).Port

	c, err := net.DialUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)}, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 2), Port: port})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.Close() }()
	q := query(0x4321, "api.example.com", 1)
	if _, err := c.Write(q); err != nil {
		t.Fatal(err)
	}
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 512)
	n, err := c.Read(buf)
	if err != nil {
		t.Fatalf("no answer reached the connected client: %v", err)
	}
	if got, want := buf[:n], answer(q); string(got) != string(want) {
		t.Errorf("answer = %x, want the upstream's %x", got, want)
	}
}
