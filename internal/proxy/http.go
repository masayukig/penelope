package proxy

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/yuanying/penelope/internal/config"
	"github.com/yuanying/penelope/internal/credentials"
	"github.com/yuanying/penelope/internal/record"
)

// MarkHeader is on every response the Sentinel makes itself, and is taken
// off every response from upstream, so that the sandbox can tell the
// Sentinel's refusals from the upstream's. Its value is MarkDeny or
// MarkError.
const MarkHeader = "Penelope-Sentinel"

const (
	// MarkDeny is a refusal: the request was not sent upstream.
	MarkDeny = "deny"
	// MarkError is the Sentinel failing to get an answer: the request was
	// not sent, or not answered.
	MarkError = "error"
)

// writeMark writes one of the Sentinel's own answers.
func writeMark(w http.ResponseWriter, status int, mark, text string) {
	h := w.Header()
	h.Set(MarkHeader, mark)
	h.Set("Content-Type", "text/plain; charset=utf-8")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = fmt.Fprintf(w, "penelope-sentinel: %s\n", text)
}

// request begins the record of a request read on a connection.
func (p *Proxy) request(r *http.Request, cn *conn, action record.Action, host string) *record.Record {
	rec := p.base(record.KindHTTP, cn)
	rec.Action = action
	rec.Host = host
	rec.Method = r.Method
	rec.Path = record.Scrub(r.URL.Path, cn.policy.Surrogates())
	return rec
}

func (p *Proxy) deny(w http.ResponseWriter, rec *record.Record, status int, reason, text string) {
	rec.Action = record.Deny
	rec.Reason = reason
	rec.Status = status
	p.cfg.Log.Write(rec)
	writeMark(w, status, MarkDeny, text)
}

// serveOpen takes one request on an opened host: it checks the Host,
// swaps the surrogates and sends the request to the host's upstream.
func (p *Proxy) serveOpen(w http.ResponseWriter, r *http.Request) {
	tc, _ := r.Context().Value(connKey{}).(*taggedConn)
	if tc == nil || tc.host == nil {
		writeMark(w, http.StatusInternalServerError, MarkError, "the connection was not set up by the Sentinel")
		return
	}
	cn, h := tc.conn, tc.host
	rec := p.request(r, cn, record.Open, h.Name)

	if !sameHost(r.Host, h, cn.dst.Port()) {
		p.deny(w, rec, http.StatusForbidden, ReasonHostMismatch,
			fmt.Sprintf("the Host of the request is not %s, the name the connection was opened for", h.Name))
		return
	}
	if err := credentials.Swap(r.Context(), r, h, cn.policy.Surrogates(), p.cfg.Keys); err != nil {
		ref, _ := credentials.IsRefusal(err)
		status := http.StatusForbidden
		if ref == nil {
			ref = &credentials.Refusal{Reason: credentials.ReasonKey, Message: "the surrogates could not be swapped"}
		}
		if ref.Reason == credentials.ReasonKey {
			status = http.StatusServiceUnavailable
		}
		p.deny(w, rec, status, string(ref.Reason), ref.Message)
		return
	}
	rp := p.upstreams.get(cn.policy, h)
	p.forward(w, r, rec, rp)
}

// servePlain takes one request of plain HTTP: it is refused when it
// carries a surrogate, and is otherwise sent to where it was going.
func (p *Proxy) servePlain(w http.ResponseWriter, r *http.Request) {
	tc, _ := r.Context().Value(connKey{}).(*taggedConn)
	if tc == nil {
		writeMark(w, http.StatusInternalServerError, MarkError, "the connection was not set up by the Sentinel")
		return
	}
	cn := tc.conn
	rec := p.request(r, cn, record.Passthrough, config.Normalize(hostOnly(r.Host)))
	if where := credentials.Holds(r, cn.policy.Surrogates()); where != "" {
		p.deny(w, rec, http.StatusForbidden, string(credentials.ReasonSurrogate),
			"a surrogate is in the request's "+where+"; surrogates are swapped only for the hosts registered with the Sentinel, over HTTPS")
		return
	}
	if cn.policy.Default != config.Passthrough {
		// Nothing more on this connection will go anywhere.
		w.Header().Set("Connection", "close")
		p.deny(w, rec, http.StatusForbidden, ReasonNotRegistered, "the host is not registered with the Sentinel")
		return
	}
	dst := cn.dst.String()
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL.Scheme = "http"
			pr.Out.URL.Host = dst
			pr.Out.Host = pr.In.Host
		},
		Transport:      p.direct,
		FlushInterval:  -1,
		ModifyResponse: unmark,
		ErrorHandler:   upstreamError,
		ErrorLog:       slog.NewLogLogger(p.cfg.Logger.Handler(), slog.LevelWarn),
	}
	p.forward(w, r, rec, rp)
}

type recKey struct{}

// forward sends r on through rp and records what came of it.
func (p *Proxy) forward(w http.ResponseWriter, r *http.Request, rec *record.Record, rp *httputil.ReverseProxy) {
	start := p.cfg.Now()
	cw := &countingWriter{ResponseWriter: w}
	body := &countingBody{ReadCloser: r.Body}
	if r.Body != nil && r.Body != http.NoBody {
		r.Body = body
	}
	r = r.WithContext(context.WithValue(r.Context(), recKey{}, rec))
	rp.ServeHTTP(cw, r)
	rec.Status = cw.status
	rec.BytesIn = cw.n.Load()
	rec.BytesOut = body.n.Load()
	rec.Duration = p.cfg.Now().Sub(start)
	p.cfg.Log.Write(rec)
}

// upstreamError answers for a request the upstream could not be asked or
// did not answer. The error's own text is recorded, not sent: it could
// carry the URL.
func upstreamError(w http.ResponseWriter, r *http.Request, err error) {
	if rec, ok := r.Context().Value(recKey{}).(*record.Record); ok {
		rec.Error = err.Error()
	}
	if errors.Is(err, context.Canceled) && r.Context().Err() != nil {
		return
	}
	writeMark(w, http.StatusBadGateway, MarkError, "the upstream could not be reached or did not answer")
}

// unmark takes the Sentinel's mark off a response from upstream.
func unmark(resp *http.Response) error {
	resp.Header.Del(MarkHeader)
	return nil
}

// sameHost reports whether the Host of a request is the registration's
// name, with no port or the port the connection was made to.
func sameHost(hostport string, h *config.Host, port uint16) bool {
	host, p, err := net.SplitHostPort(hostport)
	if err != nil {
		host, p = hostport, ""
	}
	if config.Normalize(host) != h.Name {
		return false
	}
	return p == "" || p == strconv.Itoa(int(port))
}

func hostOnly(hostport string) string {
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		return h
	}
	return hostport
}

// upstreams keeps a reverse proxy for each registered host of the
// configuration in use, made when the host is first asked for.
type upstreams struct {
	dial func(ctx context.Context, network, addr string) (net.Conn, error)
	log  *slog.Logger

	mu     sync.Mutex
	policy *config.Config
	byHost map[*config.Host]*upstream
}

type upstream struct {
	rp *httputil.ReverseProxy
	tr *http.Transport
}

func newUpstreams(dial func(ctx context.Context, network, addr string) (net.Conn, error), log *slog.Logger) *upstreams {
	return &upstreams{dial: dial, log: log, byHost: map[*config.Host]*upstream{}}
}

func (u *upstreams) get(policy *config.Config, h *config.Host) *httputil.ReverseProxy {
	u.mu.Lock()
	defer u.mu.Unlock()
	if policy != u.policy {
		// A configuration read again: the idle connections of the
		// old one's upstreams are let go.
		for _, up := range u.byHost {
			up.tr.CloseIdleConnections()
		}
		u.policy = policy
		u.byHost = map[*config.Host]*upstream{}
	}
	if up := u.byHost[h]; up != nil {
		return up.rp
	}
	up := u.make(h)
	u.byHost[h] = up
	return up.rp
}

func (u *upstreams) make(h *config.Host) *upstream {
	var (
		scheme = "https"
		dial   = func(ctx context.Context, _, _ string) (net.Conn, error) {
			return u.dial(ctx, "tcp", h.Upstream.Address)
		}
		serverName string
	)
	switch h.Upstream.Scheme {
	case "https":
		serverName = hostOnly(h.Upstream.Address)
	case "http":
		scheme = "http"
	case "unix":
		scheme = "http"
		dial = func(ctx context.Context, _, _ string) (net.Conn, error) {
			return u.dial(ctx, "unix", h.Upstream.Address)
		}
	}
	tr := newTransport(dial, h.RootCAs, serverName)
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL.Scheme = scheme
			pr.Out.URL.Host = h.Upstream.Address
			if h.Upstream.Scheme == "unix" {
				pr.Out.URL.Host = h.Name
			}
			pr.Out.Host = pr.In.Host
		},
		Transport: tr,
		// Hand on each piece as it arrives: watches, logs -f, clones.
		FlushInterval:  -1,
		ModifyResponse: unmark,
		ErrorHandler:   upstreamError,
		ErrorLog:       slog.NewLogLogger(u.log.Handler(), slog.LevelWarn),
	}
	return &upstream{rp: rp, tr: tr}
}

// newTransport is a transport that speaks HTTP/1.1 (Upgrade works on it),
// never through a proxy from the environment, and leaves the body as the
// upstream sent it.
func newTransport(dial func(ctx context.Context, network, addr string) (net.Conn, error), roots *x509.CertPool, serverName string) *http.Transport {
	return &http.Transport{
		Proxy:       nil,
		DialContext: dial,
		TLSClientConfig: &tls.Config{
			ServerName: serverName,
			RootCAs:    roots,
			MinVersion: tls.VersionTLS12,
		},
		// An empty TLSNextProto turns HTTP/2 off.
		ForceAttemptHTTP2:     false,
		TLSNextProto:          map[string]func(string, *tls.Conn) http.RoundTripper{},
		DisableCompression:    true,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: time.Second,
		MaxIdleConnsPerHost:   16,
		IdleConnTimeout:       90 * time.Second,
	}
}

// countingWriter keeps the status and counts what is written, also after
// an Upgrade takes the connection over.
type countingWriter struct {
	http.ResponseWriter
	status int
	n      atomic.Int64
}

func (c *countingWriter) WriteHeader(status int) {
	if c.status == 0 || c.status < 200 {
		c.status = status
	}
	c.ResponseWriter.WriteHeader(status)
}

func (c *countingWriter) Write(b []byte) (int, error) {
	if c.status == 0 {
		c.status = http.StatusOK
	}
	n, err := c.ResponseWriter.Write(b)
	c.n.Add(int64(n))
	return n, err
}

func (c *countingWriter) Flush() {
	_ = http.NewResponseController(c.ResponseWriter).Flush()
}

func (c *countingWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, brw, err := http.NewResponseController(c.ResponseWriter).Hijack()
	if err != nil {
		return nil, nil, err
	}
	if c.status == 0 {
		c.status = http.StatusSwitchingProtocols
	}
	return &countingConn{Conn: conn, n: &c.n}, brw, nil
}

func (c *countingWriter) Unwrap() http.ResponseWriter { return c.ResponseWriter }

type countingConn struct {
	net.Conn
	n *atomic.Int64
}

func (c *countingConn) Write(b []byte) (int, error) {
	n, err := c.Conn.Write(b)
	c.n.Add(int64(n))
	return n, err
}

type countingBody struct {
	io.ReadCloser
	n atomic.Int64
}

func (c *countingBody) Read(b []byte) (int, error) {
	n, err := c.ReadCloser.Read(b)
	c.n.Add(int64(n))
	return n, err
}
