//go:build netns

// These tests need root in a network namespace of their own, where they
// add iptables rules. Run them with `make test-netns`, never on a host's
// own namespace.

package proxy_test

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/yuanying/penelope/internal/certs"
	"github.com/yuanying/penelope/internal/config"
	"github.com/yuanying/penelope/internal/credentials"
	"github.com/yuanying/penelope/internal/origdst"
	"github.com/yuanying/penelope/internal/proxy"
	"github.com/yuanying/penelope/internal/record"
	"github.com/yuanying/penelope/internal/testca"
)

func command(t *testing.T, name string, args ...string) {
	t.Helper()
	if out, err := exec.Command(name, args...).CombinedOutput(); err != nil {
		t.Fatalf("%s %v: %v\n%s", name, args, err, out)
	}
}

// redirect makes iptables (or ip6tables) redirect TCP to dst:dport, from
// this namespace's own processes, to port. The rule is removed afterwards.
func redirect(t *testing.T, tables, dst string, dport, port int) {
	t.Helper()
	rule := []string{"OUTPUT", "-p", "tcp", "-d", dst, "--dport", fmt.Sprint(dport), "-j", "REDIRECT", "--to-ports", fmt.Sprint(port)}
	command(t, tables, append([]string{"-t", "nat", "-A"}, rule...)...)
	t.Cleanup(func() { _ = exec.Command(tables, append([]string{"-t", "nat", "-D"}, rule...)...).Run() })
}

// echo listens on addr and answers each line with "echo: " and the line.
func echo(t *testing.T, network, addr string) string {
	t.Helper()
	ln, err := net.Listen(network, addr)
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
				line, _ := bufio.NewReader(c).ReadString('\n')
				_, _ = io.WriteString(c, "echo: "+line)
			}()
		}
	}()
	return ln.Addr().String()
}

// sentinel starts a Proxy on network's loopback that finds destinations
// with SO_ORIGINAL_DST, and sends what it passes through to routes.
func sentinel(t *testing.T, network string, routes map[string]string) (int, *recorder) {
	t.Helper()
	ca := testca.New(t)
	minter, err := certs.Load(ca.CertFile, ca.KeyFile)
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Parse([]byte("listen: {proxy: [\"127.0.0.1:15001\"], dns: [\"127.0.0.1:15053\"]}\nca: {cert: a, key: b}\n"))
	if err != nil {
		t.Fatal(err)
	}
	rec := &recorder{}
	p := proxy.New(proxy.Config{
		Policy:      func() *config.Config { return cfg },
		Minter:      minter,
		Keys:        credentials.Files{},
		Log:         rec,
		OriginalDst: origdst.Lookup,
		// The Sentinel's own connections would be redirected again in
		// this namespace: they go where the test says instead.
		Dial: func(ctx context.Context, _, addr string) (net.Conn, error) {
			real, ok := routes[addr]
			if !ok {
				return nil, fmt.Errorf("nothing at %s", addr)
			}
			return (&net.Dialer{}).DialContext(ctx, "tcp", real)
		},
		PeekTimeout: 200 * time.Millisecond,
	})
	addr := "127.0.0.1:0"
	if network == "tcp6" {
		addr = "[::1]:0"
	}
	ln, err := net.Listen(network, addr)
	if err != nil {
		t.Skipf("skipped: no %s loopback: %v", network, err)
	}
	go func() { _ = p.Serve(ln) }()
	t.Cleanup(func() { _ = p.Close() })
	return ln.Addr().(*net.TCPAddr).Port, rec
}

func needRoot(t *testing.T) {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Fatal("needs root in a network namespace of its own; run `make test-netns`")
	}
}

func say(t *testing.T, network, addr string) (string, error) {
	t.Helper()
	c, err := net.DialTimeout(network, addr, 5*time.Second)
	if err != nil {
		return "", err
	}
	defer func() { _ = c.Close() }()
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	_, _ = io.WriteString(c, "hello\n")
	return bufio.NewReader(c).ReadString('\n')
}

func TestARedirectedConnectionIsPassedThroughToWhereItWasGoing(t *testing.T) {
	needRoot(t)
	up := echo(t, "tcp4", "127.0.0.1:0")
	port, rec := sentinel(t, "tcp4", map[string]string{"127.0.0.2:7000": up})
	redirect(t, "iptables", "127.0.0.2", 7000, port)

	if got, err := say(t, "tcp4", "127.0.0.2:7000"); err != nil || got != "echo: hello\n" {
		t.Fatalf("got %q, %v", got, err)
	}
	r := rec.wait(t, 1)[0]
	if r.Action != record.Passthrough || r.Addr != "127.0.0.2" || r.Port != 7000 {
		t.Errorf("record = %+v", r)
	}
}

func TestARedirectedIPv6ConnectionIsPassedThrough(t *testing.T) {
	needRoot(t)
	if out, err := exec.Command("ip6tables", "-t", "nat", "-L", "OUTPUT").CombinedOutput(); err != nil {
		t.Skipf("skipped: no IPv6 NAT here (%v: %s)", err, out)
	}
	if out, err := exec.Command("ip", "-6", "addr", "add", "2001:db8::2/128", "dev", "lo", "nodad").CombinedOutput(); err != nil {
		t.Skipf("skipped: no IPv6 on the loopback (%v: %s)", err, out)
	}
	t.Cleanup(func() { _ = exec.Command("ip", "-6", "addr", "del", "2001:db8::2/128", "dev", "lo").Run() })
	up := echo(t, "tcp4", "127.0.0.1:0")
	port, rec := sentinel(t, "tcp6", map[string]string{"[2001:db8::2]:7000": up})
	redirect(t, "ip6tables", "2001:db8::2", 7000, port)

	if got, err := say(t, "tcp6", "[2001:db8::2]:7000"); err != nil || got != "echo: hello\n" {
		t.Fatalf("got %q, %v", got, err)
	}
	r := rec.wait(t, 1)[0]
	if r.Action != record.Passthrough || r.Addr != "2001:db8::2" || r.Port != 7000 {
		t.Errorf("record = %+v", r)
	}
}

func TestARedirectedConnectionToALinkLocalAddressIsRefused(t *testing.T) {
	needRoot(t)
	command(t, "ip", "addr", "add", "169.254.169.254/32", "dev", "lo")
	t.Cleanup(func() { _ = exec.Command("ip", "addr", "del", "169.254.169.254/32", "dev", "lo").Run() })
	port, rec := sentinel(t, "tcp4", map[string]string{})
	redirect(t, "iptables", "169.254.169.254", 80, port)

	if got, err := say(t, "tcp4", "169.254.169.254:80"); err == nil && got != "" {
		t.Errorf("the metadata address answered %q", got)
	}
	r := rec.wait(t, 1)[0]
	if r.Action != record.Deny || r.Reason != proxy.ReasonLinkLocal {
		t.Errorf("record = %+v", r)
	}
}

func TestAConnectionStraightToTheListenerIsRefused(t *testing.T) {
	needRoot(t)
	port, rec := sentinel(t, "tcp4", map[string]string{})
	if got, err := say(t, "tcp4", fmt.Sprintf("127.0.0.1:%d", port)); err == nil && got != "" {
		t.Errorf("the listener answered %q", got)
	}
	r := rec.wait(t, 1)[0]
	if r.Action != record.Deny || r.Reason != proxy.ReasonDirect {
		t.Errorf("record = %+v", r)
	}
}
