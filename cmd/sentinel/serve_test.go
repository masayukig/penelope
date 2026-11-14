package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/yuanying/penelope/internal/config"
	"github.com/yuanying/penelope/internal/testca"
)

// syncBuffer is a buffer written by the Sentinel and read by the test.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func writeConfig(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func sentinelConfig(ca *testca.CA, resolver, rest string) string {
	return "listen:\n  proxy: [\"127.0.0.1:0\"]\n  dns: [\"127.0.0.1:0\"]\n" +
		"resolver: " + resolver + "\n" +
		"ca: {cert: " + ca.CertFile + ", key: " + ca.KeyFile + "}\n" + rest
}

func TestServeRefusesAConfigurationItCannotServe(t *testing.T) {
	ca := testca.New(t)
	dir := t.TempDir()
	tests := map[string]string{
		"a missing file": "",
		"a connector":    sentinelConfig(ca, "127.0.0.1:53", "hosts:\n  - name: api.example.com\n    connector: github\n"),
		"default ask":    sentinelConfig(ca, "127.0.0.1:53", "default: ask\n"),
		"a CA that is not there": strings.Replace(sentinelConfig(ca, "127.0.0.1:53", ""),
			ca.CertFile, filepath.Join(dir, "missing.crt"), 1),
	}
	for name, body := range tests {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "sentinel.yaml")
			if body != "" {
				writeConfig(t, path, body)
			}
			var stdout, stderr bytes.Buffer
			if code := run([]string{"serve", "-config", path}, &stdout, &stderr); code == 0 {
				t.Fatal("serve started")
			}
			if stderr.Len() == 0 {
				t.Error("nothing was said about why")
			}
		})
	}
}

func TestServeNeedsAConfiguration(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := run([]string{"serve"}, &stdout, &stderr); code != 2 {
		t.Errorf("serve without -config = %d, want 2", code)
	}
}

// fakeResolver answers every UDP query with its own bytes and the QR bit.
func fakeResolver(t *testing.T) string {
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
			r := append([]byte(nil), buf[:n]...)
			r[2] |= 0x80
			_, _ = pc.WriteTo(r, addr)
		}
	}()
	return pc.LocalAddr().String()
}

func dnsQuery(name string) []byte {
	b := []byte{0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0}
	for _, l := range strings.Split(name, ".") {
		b = append(b, byte(len(l)))
		b = append(b, l...)
	}
	b = append(b, 0)
	b = binary.BigEndian.AppendUint16(b, 1)
	return binary.BigEndian.AppendUint16(b, 1)
}

func TestServeListensAndRecordsToStandardOutput(t *testing.T) {
	ca := testca.New(t)
	path := filepath.Join(t.TempDir(), "sentinel.yaml")
	writeConfig(t, path, sentinelConfig(ca, fakeResolver(t), ""))

	stdout := &syncBuffer{}
	ctx, cancel := context.WithCancel(context.Background())
	addrs := make(chan net.Addr, 4)
	done := make(chan error, 1)
	go func() {
		done <- serve(ctx, path, stdout, slog.New(slog.DiscardHandler), func(kind string, a net.Addr) {
			if kind == "dns-udp" {
				addrs <- a
			}
		})
	}()
	var dnsAddr net.Addr
	select {
	case dnsAddr = <-addrs:
	case err := <-done:
		t.Fatalf("serve stopped: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("serve did not listen")
	}

	c, err := net.Dial("udp4", dnsAddr.String())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.Close() }()
	if _, err := c.Write(dnsQuery("api.example.com")); err != nil {
		t.Fatal(err)
	}
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := c.Read(make([]byte, 512)); err != nil {
		t.Fatalf("no answer: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(stdout.String(), "api.example.com") {
		if time.Now().After(deadline) {
			t.Fatalf("no record on stdout: %q", stdout.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
	var rec map[string]any
	if err := json.Unmarshal([]byte(strings.SplitN(stdout.String(), "\n", 2)[0]), &rec); err != nil {
		t.Fatalf("the record is not JSON: %v", err)
	}
	if rec["kind"] != "dns" || rec["host"] != "api.example.com" {
		t.Errorf("record = %v", rec)
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("serve = %v, want nil when stopped", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("serve did not stop")
	}
}

func TestAReloadKeepsTheConfigurationWhenTheNewOneCannotBeServed(t *testing.T) {
	ca := testca.New(t)
	path := filepath.Join(t.TempDir(), "sentinel.yaml")
	first := sentinelConfig(ca, "127.0.0.1:53", "")
	writeConfig(t, path, first)
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	r := newReloader(path, cfg, slog.New(slog.DiscardHandler))

	if r.check() {
		t.Error("an unchanged file was taken as a new configuration")
	}

	writeConfig(t, path, first+"hosts:\n  - name: api.example.com\n    connector: github\n")
	if r.check() || r.current() != cfg {
		t.Error("a configuration with a connector replaced the one in use")
	}

	writeConfig(t, path, strings.Replace(first, "127.0.0.1:53", "127.0.0.1:5353", 1))
	if r.check() || r.current() != cfg {
		t.Error("a change of the resolver was applied while running")
	}

	writeConfig(t, path, first+"default: deny\n")
	if !r.check() {
		t.Fatal("a configuration that can be served was not taken")
	}
	if r.current().Default != config.Deny {
		t.Errorf("Default = %q after the reload, want deny", r.current().Default)
	}

	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if r.check() || r.current().Default != config.Deny {
		t.Error("a file that went away replaced the configuration in use")
	}
}

func TestTheResolverIsTakenFromResolvConf(t *testing.T) {
	path := filepath.Join(t.TempDir(), "resolv.conf")
	writeConfig(t, path, "search svc.cluster.local\n# a comment\nnameserver 10.96.0.10\nnameserver 10.96.0.11\noptions ndots:5\n")
	got, err := resolverFrom(path)
	if err != nil || got != "10.96.0.10:53" {
		t.Errorf("resolverFrom = %q, %v, want 10.96.0.10:53", got, err)
	}
	writeConfig(t, path, "nameserver fd00::10\n")
	if got, _ := resolverFrom(path); got != "[fd00::10]:53" {
		t.Errorf("resolverFrom = %q, want [fd00::10]:53", got)
	}
	writeConfig(t, path, "search example.com\n")
	if _, err := resolverFrom(path); err == nil {
		t.Error("a resolv.conf without a nameserver gave a resolver")
	}
}

// logRecords keeps what the Sentinel logs, for the tests that can see a
// reload only there.
type logRecords struct {
	mu   sync.Mutex
	recs []slog.Record
}

func (l *logRecords) Enabled(context.Context, slog.Level) bool { return true }
func (l *logRecords) Handle(_ context.Context, r slog.Record) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.recs = append(l.recs, r.Clone())
	return nil
}
func (l *logRecords) WithAttrs([]slog.Attr) slog.Handler { return l }
func (l *logRecords) WithGroup(string) slog.Handler      { return l }

// saw reports whether an Info record holds an attribute of the value v.
func (l *logRecords) saw(v string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, r := range l.recs {
		found := false
		r.Attrs(func(a slog.Attr) bool {
			found = found || (r.Level == slog.LevelInfo && a.Value.String() == v)
			return !found
		})
		if found {
			return true
		}
	}
	return false
}

// Guards against: a SIGHUP that does not make the running Sentinel read its
// configuration again (docs/sentinel-config.md). The ten seconds of the
// regular reload are not waited for; the decision of what to take is
// TestAReloadKeepsTheConfigurationWhenTheNewOneCannotBeServed's.
func TestASIGHUPReadsTheConfigurationAgain(t *testing.T) {
	// This process takes SIGHUP itself first, so that a signal sent before
	// serve listens for it does not end the test.
	own := make(chan os.Signal, 16)
	signal.Notify(own, syscall.SIGHUP)
	defer signal.Stop(own)

	ca := testca.New(t)
	path := filepath.Join(t.TempDir(), "sentinel.yaml")
	first := sentinelConfig(ca, fakeResolver(t), "")
	writeConfig(t, path, first)
	logs := &logRecords{}
	ctx, cancel := context.WithCancel(context.Background())
	listening := make(chan struct{}, 8)
	done := make(chan error, 1)
	go func() {
		done <- serve(ctx, path, io.Discard, slog.New(logs), func(string, net.Addr) { listening <- struct{}{} })
	}()
	stop := func() {
		cancel()
		<-done
	}
	select {
	case <-listening:
	case err := <-done:
		t.Fatalf("serve stopped: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("serve did not listen")
	}
	defer stop()

	// Written whole, so that no read sees half of it.
	next := path + ".next"
	writeConfig(t, next, first+"default: deny\n")
	if err := os.Rename(next, path); err != nil {
		t.Fatal(err)
	}
	// The file is read again within the ten seconds anyway; a SIGHUP every
	// 50 ms makes it well before them.
	deadline := time.Now().Add(5 * time.Second)
	for !logs.saw(string(config.Deny)) {
		if time.Now().After(deadline) {
			t.Fatal("the configuration was not read again after SIGHUP")
		}
		if err := syscall.Kill(os.Getpid(), syscall.SIGHUP); err != nil {
			t.Fatal(err)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// Guards against: a Sentinel that runs on without one of its listeners
// (ADR-0014): it does not start when it cannot listen.
func TestServeDoesNotStartWhenItCannotListen(t *testing.T) {
	taken, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = taken.Close() }()
	ca := testca.New(t)
	for name, listen := range map[string]string{
		"the proxy": "listen:\n  proxy: [\"" + taken.Addr().String() + "\"]\n  dns: [\"127.0.0.1:0\"]\n",
		"DNS":       "listen:\n  proxy: [\"127.0.0.1:0\"]\n  dns: [\"" + taken.Addr().String() + "\"]\n",
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "sentinel.yaml")
			writeConfig(t, path, listen+"resolver: 127.0.0.1:53\nca: {cert: "+ca.CertFile+", key: "+ca.KeyFile+"}\n")
			done := make(chan error, 1)
			go func() { done <- serve(context.Background(), path, io.Discard, slog.New(slog.DiscardHandler), nil) }()
			select {
			case err := <-done:
				if err == nil {
					t.Error("serve = nil, want an error")
				}
			case <-time.After(5 * time.Second):
				t.Fatal("serve went on without its listener")
			}
		})
	}
}
