// Package sockowner finds the UID that owns a socket of the Pod's network
// namespace, from /proc/net. The Sentinel shares the namespace with the
// sandbox, so the sender of a redirected connection is there, under the
// address the Sentinel sees as the connection's peer (docs/sentinel-config.md
// "記録" uid).
package sockowner

import (
	"bufio"
	"encoding/binary"
	"encoding/hex"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Table reads the socket tables under Dir.
type Table struct {
	// Dir is /proc/net when empty.
	Dir string
}

// UID returns the owner of the socket of proto ("tcp" or "udp") bound to
// addr. An IPv4 socket may sit in the IPv6 table, as an IPv4-mapped
// address, and is found there too.
func (t Table) UID(proto string, addr netip.AddrPort) (int, bool) {
	dir := t.Dir
	if dir == "" {
		dir = "/proc/net"
	}
	want := netip.AddrPortFrom(addr.Addr().Unmap(), addr.Port())
	for _, name := range []string{proto, proto + "6"} {
		if uid, ok := find(filepath.Join(dir, name), want); ok {
			return uid, true
		}
	}
	return 0, false
}

func find(path string, want netip.AddrPort) (int, bool) {
	f, err := os.Open(path)
	if err != nil {
		return 0, false
	}
	defer func() { _ = f.Close() }()
	s := bufio.NewScanner(f)
	s.Buffer(make([]byte, 0, 4096), 1<<20)
	for s.Scan() {
		fields := strings.Fields(s.Text())
		// sl local rem st tx:rx tr:when retrnsmt uid ...
		if len(fields) < 8 {
			continue
		}
		local, ok := parse(fields[1])
		if !ok || local != want {
			continue
		}
		uid, err := strconv.Atoi(fields[7])
		if err != nil {
			continue
		}
		return uid, true
	}
	return 0, false
}

// parse reads an address as the kernel prints it: the address as 32-bit
// words in the host's byte order, each in hex, then ':' and the port in hex.
func parse(s string) (netip.AddrPort, bool) {
	a, p, ok := strings.Cut(s, ":")
	if !ok {
		return netip.AddrPort{}, false
	}
	raw, err := hex.DecodeString(a)
	if err != nil || (len(raw) != 4 && len(raw) != 16) {
		return netip.AddrPort{}, false
	}
	port, err := strconv.ParseUint(p, 16, 16)
	if err != nil {
		return netip.AddrPort{}, false
	}
	b := make([]byte, len(raw))
	for i := 0; i < len(raw); i += 4 {
		binary.NativeEndian.PutUint32(b[i:], binary.BigEndian.Uint32(raw[i:]))
	}
	addr, _ := netip.AddrFromSlice(b)
	return netip.AddrPortFrom(addr.Unmap(), uint16(port)), true
}
