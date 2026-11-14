package dns_test

import (
	"encoding/binary"
	"io"
	"net"
	"net/netip"
	"sync"
	"testing"
	"time"

	"github.com/yuanying/penelope/internal/dns"
	"github.com/yuanying/penelope/internal/record"
)

type recorder struct {
	mu   sync.Mutex
	recs []*record.Record
}

func (r *recorder) Write(rec *record.Record) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.recs = append(r.recs, rec)
}

func (r *recorder) wait(t *testing.T, n int) []*record.Record {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		r.mu.Lock()
		if len(r.recs) >= n {
			defer r.mu.Unlock()
			return append([]*record.Record(nil), r.recs...)
		}
		r.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("fewer than %d records", n)
	return nil
}

type owners struct{}

func (owners) UID(string, netip.AddrPort) (int, bool) { return 1000, true }

// query builds a DNS query for name of type qtype.
func query(id uint16, name string, qtype uint16) []byte {
	b := make([]byte, 12)
	binary.BigEndian.PutUint16(b[0:], id)
	binary.BigEndian.PutUint16(b[2:], 0x0100) // RD
	binary.BigEndian.PutUint16(b[4:], 1)
	for _, label := range splitLabels(name) {
		b = append(b, byte(len(label)))
		b = append(b, label...)
	}
	b = append(b, 0)
	b = binary.BigEndian.AppendUint16(b, qtype)
	b = binary.BigEndian.AppendUint16(b, 1)
	return b
}

func splitLabels(name string) []string {
	var out []string
	start := 0
	for i := 0; i <= len(name); i++ {
		if i == len(name) || name[i] == '.' {
			out = append(out, name[start:i])
			start = i + 1
		}
	}
	return out
}

// answer turns a query into a response the way a resolver would: the same
// ID and question, the QR bit set, and a marker byte at the end.
func answer(q []byte) []byte {
	r := append([]byte(nil), q...)
	r[2] |= 0x80
	return append(r, 0xAB)
}

func upstreamUDP(t *testing.T) string {
	t.Helper()
	pc, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	go func() {
		buf := make([]byte, 65535)
		for {
			n, addr, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			_, _ = pc.WriteTo(answer(buf[:n]), addr)
		}
	}()
	return pc.LocalAddr().String()
}

func upstreamTCP(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() { _ = c.Close() }()
				for {
					q, err := readTCP(c)
					if err != nil {
						return
					}
					if err := writeTCP(c, answer(q)); err != nil {
						return
					}
				}
			}()
		}
	}()
	return ln.Addr().String()
}

func readTCP(c net.Conn) ([]byte, error) {
	var n [2]byte
	if _, err := io.ReadFull(c, n[:]); err != nil {
		return nil, err
	}
	b := make([]byte, binary.BigEndian.Uint16(n[:]))
	_, err := io.ReadFull(c, b)
	return b, err
}

func writeTCP(c net.Conn, b []byte) error {
	_, err := c.Write(append(binary.BigEndian.AppendUint16(nil, uint16(len(b))), b...))
	return err
}

func TestAQueryOverUDPIsRelayedAndRecorded(t *testing.T) {
	rec := &recorder{}
	up := upstreamUDP(t)
	s := dns.New(dns.Config{Upstream: up, Log: rec, Owners: owners{}})
	pc, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = s.ServeUDP(pc) }()
	t.Cleanup(func() { _ = pc.Close() })

	c, err := net.Dial("udp4", pc.LocalAddr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.Close() }()
	q := query(0x1234, "api.example.com", 28)
	if _, err := c.Write(q); err != nil {
		t.Fatal(err)
	}
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	buf := make([]byte, 512)
	n, err := c.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := buf[:n], answer(q); string(got) != string(want) {
		t.Errorf("answer = %x, want the upstream's %x", got, want)
	}
	r := rec.wait(t, 1)[0]
	if r.Kind != record.KindDNS || r.Host != "api.example.com" || r.QType != "AAAA" || r.Action != record.Passthrough {
		t.Errorf("record = %+v", r)
	}
	if r.UID == nil || *r.UID != 1000 {
		t.Errorf("record's UID = %v, want 1000", r.UID)
	}
	if r.Addr != "127.0.0.1" {
		t.Errorf("record's addr = %q, want the resolver's", r.Addr)
	}
}

func TestQueriesOverTCPAreRelayedAndRecorded(t *testing.T) {
	rec := &recorder{}
	s := dns.New(dns.Config{Upstream: upstreamTCP(t), Log: rec})
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = s.ServeTCP(ln) }()
	t.Cleanup(func() { _ = ln.Close() })

	c, err := net.Dial("tcp4", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.Close() }()
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	for i, name := range []string{"a.example.com", "B.Example.COM."} {
		q := query(uint16(i), name, 1)
		if err := writeTCP(c, q); err != nil {
			t.Fatal(err)
		}
		got, err := readTCP(c)
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != string(answer(q)) {
			t.Errorf("answer %d = %x", i, got)
		}
	}
	recs := rec.wait(t, 2)
	if recs[0].Host != "a.example.com" || recs[1].Host != "b.example.com" || recs[0].QType != "A" {
		t.Errorf("records = %+v, %+v", recs[0], recs[1])
	}
}

func TestAQueryTheResolverDoesNotAnswerFailsAndIsRecorded(t *testing.T) {
	rec := &recorder{}
	// Nothing listens on the upstream.
	dead, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	up := dead.LocalAddr().String()
	_ = dead.Close()
	s := dns.New(dns.Config{Upstream: up, Log: rec, Timeout: 200 * time.Millisecond})
	pc, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = s.ServeUDP(pc) }()
	t.Cleanup(func() { _ = pc.Close() })

	c, err := net.Dial("udp4", pc.LocalAddr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.Close() }()
	q := query(7, "api.example.com", 1)
	if _, err := c.Write(q); err != nil {
		t.Fatal(err)
	}
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	buf := make([]byte, 512)
	n, err := c.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if n < 12 || binary.BigEndian.Uint16(buf[0:]) != 7 || buf[2]&0x80 == 0 || buf[3]&0x0F != 2 {
		t.Errorf("answer = %x, want SERVFAIL for the query", buf[:n])
	}
	if r := rec.wait(t, 1)[0]; r.Error == "" || r.Host != "api.example.com" {
		t.Errorf("record = %+v, want the name and an error", r)
	}
}

func TestSomethingThatIsNotAQueryIsDropped(t *testing.T) {
	rec := &recorder{}
	s := dns.New(dns.Config{Upstream: upstreamUDP(t), Log: rec})
	pc, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = s.ServeUDP(pc) }()
	t.Cleanup(func() { _ = pc.Close() })
	c, err := net.Dial("udp4", pc.LocalAddr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.Close() }()
	if _, err := c.Write([]byte{1, 2, 3}); err != nil {
		t.Fatal(err)
	}
	_ = c.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	if _, err := c.Read(make([]byte, 512)); err == nil {
		t.Error("something that is not a query got an answer")
	}
}
