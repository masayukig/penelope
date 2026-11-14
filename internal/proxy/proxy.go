// Package proxy is the Sentinel's transparent listener: it takes the TCP
// connections iptables redirects to it from the sandbox, finds where each
// was going, and passes it through, opens it, or refuses it (ADR-0003,
// ADR-0004, ADR-0014, docs/sentinel-config.md).
//
//   - A connection to a link-local address, and one that reached the
//     listener without being redirected, is refused.
//   - TLS whose SNI and port are a registered host's is opened: TLS is
//     terminated with a certificate of the Sentinel's CA, each request is
//     read, its surrogates swapped (internal/credentials) and sent to the
//     host's upstream.
//   - Plain HTTP is read too, so that a surrogate in it is refused, and
//     is otherwise passed on to where it was going.
//   - Anything else (TLS to a host not registered, other protocols, a
//     connection that says nothing first) is passed through unread, or
//     refused under the default deny.
//
// Every connection or request becomes a record.
//
// The SNI peek, the passthrough and the hand-off of terminated connections
// to an HTTP server are ported from natsumi-sentinel's internal/gate.
package proxy

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"sync"
	"time"

	"github.com/yuanying/penelope/internal/certs"
	"github.com/yuanying/penelope/internal/config"
	"github.com/yuanying/penelope/internal/credentials"
	"github.com/yuanying/penelope/internal/record"
)

// Recorder takes the records.
type Recorder interface {
	Write(rec *record.Record)
}

// Owners find the UID that sent a connection. sockowner.Table is one.
type Owners interface {
	UID(proto string, addr netip.AddrPort) (int, bool)
}

// Reasons recorded for what the Sentinel refuses.
const (
	ReasonLinkLocal     = "link-local"
	ReasonDirect        = "direct"
	ReasonNotRegistered = "not-registered"
	ReasonHostMismatch  = "host-mismatch"
	ReasonHandshake     = "tls-handshake-failed"
)

// Config is what a Proxy needs.
type Config struct {
	// Policy returns the configuration in use. It is asked once per
	// connection, so a configuration read again applies to new ones.
	Policy func() *config.Config
	Minter *certs.Minter
	Keys   credentials.Source
	Log    Recorder
	// Owners may be nil: then no UID is recorded.
	Owners Owners
	// OriginalDst finds where a connection was going.
	OriginalDst func(net.Conn) (netip.AddrPort, error)
	// Dial connects upstream: to the original destination, to a
	// registered host's upstream, and ("unix") to an upstream socket.
	// Defaults to a net.Dialer.
	Dial func(ctx context.Context, network, addr string) (net.Conn, error)
	// PeekTimeout is how long a connection may stay silent before it is
	// passed through without being read: some protocols wait for the
	// server to speak first. Defaults to 1s.
	PeekTimeout time.Duration
	// Logger is for what goes wrong in the Sentinel itself.
	Logger *slog.Logger
	Now    func() time.Time
}

// Proxy serves listeners.
type Proxy struct {
	cfg       Config
	open      *http.Server
	openq     *connQueue
	plain     *http.Server
	plainq    *connQueue
	upstreams *upstreams
	direct    *http.Transport

	mu        sync.Mutex
	listeners []net.Listener
	closed    bool
}

// New makes a Proxy. Serve starts it.
func New(cfg Config) *Proxy {
	if cfg.Dial == nil {
		cfg.Dial = (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	}
	if cfg.PeekTimeout == 0 {
		cfg.PeekTimeout = time.Second
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	p := &Proxy{cfg: cfg, openq: newConnQueue(), plainq: newConnQueue()}
	p.upstreams = newUpstreams(cfg.Dial, cfg.Logger)
	p.direct = newTransport(func(ctx context.Context, _, addr string) (net.Conn, error) {
		return cfg.Dial(ctx, "tcp", addr)
	}, nil, "")
	p.open = p.server(http.HandlerFunc(p.serveOpen))
	p.plain = p.server(http.HandlerFunc(p.servePlain))
	go func() { _ = p.open.Serve(p.openq) }()
	go func() { _ = p.plain.Serve(p.plainq) }()
	return p
}

func (p *Proxy) server(h http.Handler) *http.Server {
	return &http.Server{
		Handler:           h,
		ReadHeaderTimeout: 30 * time.Second,
		IdleTimeout:       5 * time.Minute,
		ConnContext: func(ctx context.Context, c net.Conn) context.Context {
			if cc, ok := c.(*taggedConn); ok {
				return context.WithValue(ctx, connKey{}, cc)
			}
			return ctx
		},
		ErrorLog: slog.NewLogLogger(p.cfg.Logger.Handler(), slog.LevelWarn),
	}
}

// Serve takes connections from ln until it is closed.
func (p *Proxy) Serve(ln net.Listener) error {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return net.ErrClosed
	}
	p.listeners = append(p.listeners, ln)
	p.mu.Unlock()
	for {
		c, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			if ne, ok := errors.AsType[net.Error](err); ok && ne.Timeout() {
				continue
			}
			return err
		}
		go p.handle(c)
	}
}

// Close stops taking connections and closes the ones in flight.
func (p *Proxy) Close() error {
	p.mu.Lock()
	p.closed = true
	lns := p.listeners
	p.mu.Unlock()
	for _, ln := range lns {
		_ = ln.Close()
	}
	_ = p.plain.Close()
	return p.open.Close()
}

// conn is what is known of a connection before anything is read on it.
type conn struct {
	dst    netip.AddrPort
	uid    *int
	policy *config.Config
}

func (p *Proxy) base(kind record.Kind, cn *conn) *record.Record {
	rec := &record.Record{Time: p.cfg.Now(), Kind: kind, UID: cn.uid}
	if cn.dst.IsValid() {
		rec.Addr = cn.dst.Addr().Unmap().String()
		rec.Port = cn.dst.Port()
	}
	return rec
}

func (p *Proxy) refuse(c net.Conn, rec *record.Record, reason string) {
	_ = c.Close()
	rec.Action = record.Deny
	rec.Reason = reason
	p.cfg.Log.Write(rec)
}

func (p *Proxy) handle(c net.Conn) {
	cn := &conn{policy: p.cfg.Policy()}
	if p.cfg.Owners != nil {
		if ap, err := netip.ParseAddrPort(c.RemoteAddr().String()); err == nil {
			if uid, ok := p.cfg.Owners.UID("tcp", ap); ok {
				cn.uid = &uid
			}
		}
	}
	dst, err := p.cfg.OriginalDst(c)
	if err != nil {
		// Linux keeps no original destination for a connection that
		// was not redirected.
		rec := p.base(record.KindTCP, cn)
		rec.Error = err.Error()
		p.refuse(c, rec, ReasonDirect)
		return
	}
	cn.dst = netip.AddrPortFrom(dst.Addr().Unmap(), dst.Port())
	if local, err := netip.ParseAddrPort(c.LocalAddr().String()); err == nil &&
		netip.AddrPortFrom(local.Addr().Unmap(), local.Port()) == cn.dst {
		p.refuse(c, p.base(record.KindTCP, cn), ReasonDirect)
		return
	}
	if linkLocal(dst.Addr()) {
		p.refuse(c, p.base(record.KindTCP, cn), ReasonLinkLocal)
		return
	}

	br := bufio.NewReaderSize(c, 4096)
	pc := &peekConn{Conn: c, r: br}
	_ = c.SetReadDeadline(time.Now().Add(p.cfg.PeekTimeout))
	first, err := br.Peek(1)
	if err != nil {
		_ = c.SetReadDeadline(time.Time{})
		p.raw(pc, cn, "")
		return
	}
	switch {
	// 0x16 is a TLS handshake record.
	case first[0] == 0x16:
		p.handshake(pc, cn)
	case looksLikeHTTP(br):
		_ = c.SetReadDeadline(time.Time{})
		if err := p.plainq.push(&taggedConn{Conn: pc, conn: cn}); err != nil {
			_ = c.Close()
		}
	default:
		_ = c.SetReadDeadline(time.Time{})
		p.raw(pc, cn, "")
	}
}

// raw passes c through to its original destination unread, or refuses it
// under the default deny. host is the SNI, when one was read.
func (p *Proxy) raw(c net.Conn, cn *conn, host string) {
	rec := p.base(record.KindTCP, cn)
	rec.Host = host
	if cn.policy.Default != config.Passthrough {
		p.refuse(c, rec, ReasonNotRegistered)
		return
	}
	defer func() { _ = c.Close() }()
	rec.Action = record.Passthrough
	start := p.cfg.Now()
	defer func() {
		rec.Duration = p.cfg.Now().Sub(start)
		p.cfg.Log.Write(rec)
	}()
	up, err := p.cfg.Dial(context.Background(), "tcp", cn.dst.String())
	if err != nil {
		rec.Error = err.Error()
		return
	}
	defer func() { _ = up.Close() }()
	var wg sync.WaitGroup
	wg.Go(func() {
		rec.BytesOut, _ = io.Copy(up, c)
		closeWrite(up)
	})
	rec.BytesIn, _ = io.Copy(c, up)
	closeWrite(c)
	wg.Wait()
}

// looksLikeHTTP reports whether the first line buffered in br is an HTTP/1
// request line. It waits for the line within the read deadline.
func looksLikeHTTP(br *bufio.Reader) bool {
	for {
		buf, _ := br.Peek(br.Buffered())
		if i := bytes.IndexByte(buf, '\n'); i >= 0 {
			return isRequestLine(bytes.TrimRight(buf[:i], "\r"))
		}
		if br.Buffered() == br.Size() {
			return false
		}
		if _, err := br.Peek(br.Buffered() + 1); err != nil {
			return false
		}
	}
}

func isRequestLine(line []byte) bool {
	method, rest, ok := bytes.Cut(line, []byte(" "))
	if !ok || len(method) == 0 {
		return false
	}
	for _, b := range method {
		if b < 'A' || b > 'Z' {
			return false
		}
	}
	_, proto, ok := bytes.Cut(rest, []byte(" "))
	return ok && bytes.HasPrefix(proto, []byte("HTTP/1."))
}

// closeWrite passes an end of stream on to the other side, keeping the
// other direction open.
func closeWrite(c net.Conn) {
	if pc, ok := c.(*peekConn); ok {
		c = pc.Conn
	}
	if cw, ok := c.(interface{ CloseWrite() error }); ok {
		_ = cw.CloseWrite()
		return
	}
	_ = c.Close()
}

// peekConn is a connection whose first bytes may be buffered in r.
type peekConn struct {
	net.Conn
	r io.Reader
}

func (p *peekConn) Read(b []byte) (int, error) { return p.r.Read(b) }

// taggedConn is a connection handed to an HTTP server, with what was
// learned of it before.
type taggedConn struct {
	net.Conn
	conn *conn
	// host is the registration a connection was opened for.
	host *config.Host
}

type connKey struct{}

// connQueue is a net.Listener fed by the Proxy, so that an HTTP server
// serves connections the Proxy has already looked at.
type connQueue struct {
	ch   chan net.Conn
	done chan struct{}
	once sync.Once
}

func newConnQueue() *connQueue {
	return &connQueue{ch: make(chan net.Conn), done: make(chan struct{})}
}

func (q *connQueue) push(c net.Conn) error {
	select {
	case q.ch <- c:
		return nil
	case <-q.done:
		return net.ErrClosed
	}
}

func (q *connQueue) Accept() (net.Conn, error) {
	select {
	case c := <-q.ch:
		return c, nil
	case <-q.done:
		return nil, net.ErrClosed
	}
}

func (q *connQueue) Close() error {
	q.once.Do(func() { close(q.done) })
	return nil
}

func (q *connQueue) Addr() net.Addr { return queueAddr{} }

type queueAddr struct{}

func (queueAddr) Network() string { return "sentinel" }
func (queueAddr) String() string  { return "sentinel" }
