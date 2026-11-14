// Package dns relays the sandbox's name resolution, which iptables
// redirects to the Sentinel, to the resolver upstream, and records each
// query (ADR-0003 "名前解決も含めて"). It answers nothing itself: a query
// the resolver does not answer gets SERVFAIL.
package dns

import (
	"encoding/binary"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"github.com/yuanying/penelope/internal/record"
)

// Recorder takes the records.
type Recorder interface {
	Write(rec *record.Record)
}

// Owners find the UID that sent a query. sockowner.Table is one.
type Owners interface {
	UID(proto string, addr netip.AddrPort) (int, bool)
}

// Config is what a Server needs.
type Config struct {
	// Upstream is the resolver, as ip:port.
	Upstream string
	Log      Recorder
	// Owners may be nil: then no UID is recorded.
	Owners Owners
	// Timeout bounds one exchange with the resolver. Defaults to 5s.
	Timeout time.Duration
	Logger  *slog.Logger
	Now     func() time.Time
}

// Server relays queries.
type Server struct {
	cfg  Config
	addr string
	port uint16
}

// New makes a Server.
func New(cfg Config) *Server {
	if cfg.Timeout == 0 {
		cfg.Timeout = 5 * time.Second
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	s := &Server{cfg: cfg}
	if ap, err := netip.ParseAddrPort(cfg.Upstream); err == nil {
		s.addr, s.port = ap.Addr().String(), ap.Port()
	}
	return s
}

// ServeUDP answers queries on pc until it is closed. Where the platform
// tells the address each query reached, it is answered from that address
// (serveUDPFromDst).
func (s *Server) ServeUDP(pc net.PacketConn) error {
	if c, ok := pc.(*net.UDPConn); ok {
		if served, err := s.serveUDPFromDst(c); served {
			return err
		}
	}
	buf := make([]byte, 65535)
	for {
		n, from, err := pc.ReadFrom(buf)
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		q := append([]byte(nil), buf[:n]...)
		go func() {
			resp := s.relay("udp", q, from)
			if resp != nil {
				_, _ = pc.WriteTo(resp, from)
			}
		}()
	}
}

// ServeTCP answers queries on the connections ln takes until it is closed.
func (s *Server) ServeTCP(ln net.Listener) error {
	for {
		c, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		go s.serveConn(c)
	}
}

func (s *Server) serveConn(c net.Conn) {
	defer func() { _ = c.Close() }()
	for {
		_ = c.SetReadDeadline(time.Now().Add(30 * time.Second))
		q, err := readMsg(c)
		if err != nil {
			return
		}
		resp := s.relay("tcp", q, c.RemoteAddr())
		if resp == nil {
			return
		}
		_ = c.SetWriteDeadline(time.Now().Add(s.cfg.Timeout))
		if err := writeMsg(c, resp); err != nil {
			return
		}
	}
}

// relay sends q to the resolver over network and returns its answer, or
// SERVFAIL when there is none. Something that is not a query gets nothing.
func (s *Server) relay(network string, q []byte, from net.Addr) []byte {
	name, qtype, end, ok := question(q)
	if !ok {
		return nil
	}
	rec := &record.Record{
		Time:   s.cfg.Now(),
		Kind:   record.KindDNS,
		Host:   name,
		QType:  qtype,
		Addr:   s.addr,
		Port:   s.port,
		Action: record.Passthrough,
	}
	if s.cfg.Owners != nil {
		if ap, err := netip.ParseAddrPort(from.String()); err == nil {
			if uid, ok := s.cfg.Owners.UID(network, ap); ok {
				rec.UID = &uid
			}
		}
	}
	start := s.cfg.Now()
	resp, err := s.exchange(network, q)
	rec.Duration = s.cfg.Now().Sub(start)
	rec.BytesOut = int64(len(q))
	if err != nil {
		rec.Error = "the resolver did not answer: " + err.Error()
		resp = servfail(q[:end])
	}
	rec.BytesIn = int64(len(resp))
	s.cfg.Log.Write(rec)
	return resp
}

func (s *Server) exchange(network string, q []byte) ([]byte, error) {
	c, err := net.DialTimeout(network, s.cfg.Upstream, s.cfg.Timeout)
	if err != nil {
		return nil, err
	}
	defer func() { _ = c.Close() }()
	_ = c.SetDeadline(time.Now().Add(s.cfg.Timeout))
	if network == "tcp" {
		if err := writeMsg(c, q); err != nil {
			return nil, err
		}
		return readMsg(c)
	}
	if _, err := c.Write(q); err != nil {
		return nil, err
	}
	buf := make([]byte, 65535)
	n, err := c.Read(buf)
	if err != nil {
		return nil, err
	}
	return buf[:n], nil
}

func readMsg(r io.Reader) ([]byte, error) {
	var n [2]byte
	if _, err := io.ReadFull(r, n[:]); err != nil {
		return nil, err
	}
	b := make([]byte, binary.BigEndian.Uint16(n[:]))
	if _, err := io.ReadFull(r, b); err != nil {
		return nil, err
	}
	return b, nil
}

func writeMsg(w io.Writer, b []byte) error {
	_, err := w.Write(append(binary.BigEndian.AppendUint16(nil, uint16(len(b))), b...))
	return err
}

// question reads the first question of a query: its name (in lower case,
// without the trailing dot), its type, and where it ends. A message that
// is a response, or holds no question, is not a query.
func question(m []byte) (name, qtype string, end int, ok bool) {
	if len(m) < 12 || m[2]&0x80 != 0 || binary.BigEndian.Uint16(m[4:]) == 0 {
		return "", "", 0, false
	}
	var labels []string
	i := 12
	for {
		if i >= len(m) {
			return "", "", 0, false
		}
		l := int(m[i])
		i++
		if l == 0 {
			break
		}
		// A question's name is not compressed; a pointer here is not a
		// query this relays.
		if l > 63 || i+l > len(m) {
			return "", "", 0, false
		}
		labels = append(labels, strings.ToLower(string(m[i:i+l])))
		i += l
	}
	if i+4 > len(m) {
		return "", "", 0, false
	}
	return strings.Join(labels, "."), typeName(binary.BigEndian.Uint16(m[i:])), i + 4, true
}

// servfail makes a SERVFAIL for a query whose header and question are q.
func servfail(q []byte) []byte {
	r := append([]byte(nil), q...)
	// QR, the query's opcode and RD kept; RA; RCODE 2.
	r[2] = 0x80 | (q[2] & 0x79)
	r[3] = 0x80 | 2
	binary.BigEndian.PutUint16(r[4:], 1)
	binary.BigEndian.PutUint16(r[6:], 0)
	binary.BigEndian.PutUint16(r[8:], 0)
	binary.BigEndian.PutUint16(r[10:], 0)
	return r
}

var types = map[uint16]string{
	1: "A", 2: "NS", 5: "CNAME", 6: "SOA", 12: "PTR", 15: "MX", 16: "TXT",
	28: "AAAA", 33: "SRV", 64: "SVCB", 65: "HTTPS", 255: "ANY",
}

func typeName(t uint16) string {
	if n, ok := types[t]; ok {
		return n
	}
	return "TYPE" + strconv.Itoa(int(t))
}
