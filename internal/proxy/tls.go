package proxy

import (
	"bytes"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"time"

	"github.com/yuanying/penelope/internal/config"
	"github.com/yuanying/penelope/internal/record"
)

// handshakeTimeout bounds a handshake the Sentinel takes part in.
const handshakeTimeout = 10 * time.Second

var errNotOpened = errors.New("not a registered host")

// handshake reads the ClientHello. A registered host's is answered with a
// certificate of the Sentinel's CA, and the connection handed to the open
// HTTP server. Any other is passed through from its first byte, with
// nothing of the Sentinel's side of the handshake sent.
func (p *Proxy) handshake(pc *peekConn, cn *conn) {
	var (
		sni  string
		host *config.Host
	)
	// Muted until the Sentinel decides to answer: a handshake it does not
	// finish is handed on whole, and nothing it would have said is sent.
	hc := &helloConn{Conn: pc, keep: true, mute: true}
	conf := &tls.Config{
		MinVersion: tls.VersionTLS12,
		GetConfigForClient: func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
			sni = config.Normalize(hello.ServerName)
			if sni == "" {
				return nil, errNotOpened
			}
			host = cn.policy.Lookup(sni, cn.dst.Port())
			if host == nil {
				return nil, errNotOpened
			}
			cert, err := p.cfg.Minter.Certificate(sni)
			if err != nil {
				return nil, err
			}
			hc.mute = false
			hc.keep = false
			return &tls.Config{
				MinVersion:   tls.VersionTLS12,
				Certificates: []tls.Certificate{*cert},
				// HTTP/1.1 only: Upgrade (WebSocket, SPDY) works on
				// it, and the upstreams are spoken to in it.
				NextProtos: []string{"http/1.1"},
			}, nil
		},
	}
	tc := tls.Server(hc, conf)
	_ = pc.SetDeadline(time.Now().Add(handshakeTimeout))
	err := tc.Handshake()
	if err != nil && host == nil {
		// Not opened: a host not registered, no SNI, or a hello Go's
		// TLS does not read. Its bytes go on as they came.
		_ = pc.SetDeadline(time.Time{})
		replay := &peekConn{Conn: pc.Conn, r: io.MultiReader(bytes.NewReader(hc.kept.Bytes()), pc.r)}
		p.raw(replay, cn, sni)
		return
	}
	if err != nil {
		rec := p.base(record.KindTCP, cn)
		rec.Host = sni
		rec.Error = err.Error()
		p.refuse(tc, rec, ReasonHandshake)
		return
	}
	_ = pc.SetDeadline(time.Time{})
	if err := p.openq.push(&taggedConn{Conn: tc, conn: cn, host: host, name: sni}); err != nil {
		_ = tc.Close()
	}
}

// helloConn is a connection whose reads can be kept, and whose writes can
// be muted. Ported from natsumi-sentinel's internal/gate/granted.go.
type helloConn struct {
	net.Conn
	keep, mute bool
	kept       bytes.Buffer
}

func (h *helloConn) Read(b []byte) (int, error) {
	n, err := h.Conn.Read(b)
	if h.keep && n > 0 {
		h.kept.Write(b[:n])
	}
	return n, err
}

func (h *helloConn) Write(b []byte) (int, error) {
	if h.mute {
		return len(b), nil
	}
	return h.Conn.Write(b)
}
