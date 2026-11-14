package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"os/signal"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/yuanying/penelope/internal/certs"
	"github.com/yuanying/penelope/internal/config"
	"github.com/yuanying/penelope/internal/credentials"
	"github.com/yuanying/penelope/internal/dns"
	"github.com/yuanying/penelope/internal/origdst"
	"github.com/yuanying/penelope/internal/proxy"
	"github.com/yuanying/penelope/internal/record"
	"github.com/yuanying/penelope/internal/sockowner"
)

// reloadEvery is how often the configuration file is looked at for a
// change. SIGHUP looks at once.
const reloadEvery = 10 * time.Second

// serve serves the configuration at path until ctx is done. Records go to
// records, what goes wrong in the Sentinel to logger. onListen, when set,
// is told each address listened on.
func serve(ctx context.Context, path string, records io.Writer, logger *slog.Logger, onListen func(kind string, addr net.Addr)) error {
	cfg, err := config.Load(path)
	if err != nil {
		return err
	}
	minter, err := certs.Load(cfg.CA.Cert, cfg.CA.Key)
	if err != nil {
		return err
	}
	resolver := cfg.Resolver
	if resolver == "" {
		if resolver, err = resolverFrom("/etc/resolv.conf"); err != nil {
			return fmt.Errorf("the resolver upstream: %w", err)
		}
	}
	if onListen == nil {
		onListen = func(string, net.Addr) {}
	}

	log := record.NewLog(records)
	owners := sockowner.Table{}
	reload := newReloader(path, cfg, logger)
	p := proxy.New(proxy.Config{
		Policy:      reload.current,
		Minter:      minter,
		Keys:        credentials.Files{},
		Log:         log,
		Owners:      owners,
		OriginalDst: origdst.Lookup,
		Logger:      logger,
	})
	d := dns.New(dns.Config{Upstream: resolver, Log: log, Owners: owners, Logger: logger})

	var (
		closers []io.Closer
		wg      sync.WaitGroup
		failed  = make(chan error, 1)
	)
	fail := func(err error) {
		if err != nil {
			select {
			case failed <- err:
			default:
			}
		}
	}
	closeAll := func() {
		for _, c := range closers {
			_ = c.Close()
		}
	}
	for _, a := range cfg.Listen.Proxy {
		ln, err := net.Listen(network("tcp", a), a)
		if err != nil {
			closeAll()
			return fmt.Errorf("listen for the proxy: %w", err)
		}
		closers = append(closers, ln)
		onListen("proxy", ln.Addr())
		wg.Go(func() { fail(p.Serve(ln)) })
	}
	for _, a := range cfg.Listen.DNS {
		pc, err := net.ListenPacket(network("udp", a), a)
		if err != nil {
			closeAll()
			return fmt.Errorf("listen for DNS: %w", err)
		}
		closers = append(closers, pc)
		onListen("dns-udp", pc.LocalAddr())
		wg.Go(func() { fail(d.ServeUDP(pc)) })
		ln, err := net.Listen(network("tcp", a), a)
		if err != nil {
			closeAll()
			return fmt.Errorf("listen for DNS: %w", err)
		}
		closers = append(closers, ln)
		onListen("dns-tcp", ln.Addr())
		wg.Go(func() { fail(d.ServeTCP(ln)) })
	}
	logger.Info("the Sentinel is serving", "version", version, "hosts", len(cfg.Hosts), "default", string(cfg.Default))

	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	defer signal.Stop(hup)
	tick := time.NewTicker(reloadEvery)
	defer tick.Stop()

	var runErr error
loop:
	for {
		select {
		case <-ctx.Done():
			break loop
		case err := <-failed:
			runErr = err
			break loop
		case <-tick.C:
			reload.check()
		case <-hup:
			reload.check()
		}
	}
	closeAll()
	_ = p.Close()
	wg.Wait()
	return runErr
}

// network is "tcp4" or "tcp6" (and so for udp) by the address's family, so
// that an IPv6 listener does not take IPv4 too and both can be listed.
func network(base, addr string) string {
	if ap, err := netip.ParseAddrPort(addr); err == nil && ap.Addr().Is6() && !ap.Addr().Is4In6() {
		return base + "6"
	}
	return base + "4"
}

// reloader holds the configuration in use and reads the file again when it
// changes. A file that cannot be served, or that changes what can only be
// changed by a restart, leaves the configuration in use as it is (ADR-0003).
type reloader struct {
	path   string
	logger *slog.Logger
	cfg    atomic.Pointer[config.Config]
	last   []byte
}

func newReloader(path string, cfg *config.Config, logger *slog.Logger) *reloader {
	r := &reloader{path: path, logger: logger}
	r.cfg.Store(cfg)
	r.last, _ = os.ReadFile(path)
	return r
}

func (r *reloader) current() *config.Config { return r.cfg.Load() }

// check reads the file again and reports whether a new configuration was
// taken.
func (r *reloader) check() bool {
	b, err := os.ReadFile(r.path)
	if err != nil {
		r.logger.Error("the configuration could not be read again; the one in use is kept", "error", err.Error())
		return false
	}
	if bytes.Equal(b, r.last) {
		return false
	}
	r.last = b
	cfg, err := config.Parse(b)
	if err != nil {
		r.logger.Error("the configuration read again cannot be served; the one in use is kept", "error", err.Error())
		return false
	}
	if !cfg.SameServing(r.current()) {
		r.logger.Error("the configuration read again changes the listeners, the resolver or the CA, which take a restart; the one in use is kept")
		return false
	}
	r.cfg.Store(cfg)
	r.logger.Info("the configuration was read again", "hosts", len(cfg.Hosts), "default", string(cfg.Default))
	return true
}

// resolverFrom takes the first nameserver of a resolv.conf, on port 53.
func resolverFrom(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	s := bufio.NewScanner(f)
	for s.Scan() {
		fields := strings.Fields(s.Text())
		if len(fields) >= 2 && fields[0] == "nameserver" {
			a, err := netip.ParseAddr(fields[1])
			if err != nil {
				continue
			}
			return netip.AddrPortFrom(a, 53).String(), nil
		}
	}
	if err := s.Err(); err != nil {
		return "", err
	}
	return "", errors.New(path + " names no nameserver")
}
