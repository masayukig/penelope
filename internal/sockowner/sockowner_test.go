package sockowner_test

import (
	"net/netip"
	"os"
	"path/filepath"
	"testing"

	"github.com/yuanying/penelope/internal/sockowner"
)

// These are lines of /proc/net/tcp and tcp6 as a little-endian Linux
// writes them.
const tcp = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:3A99 00000000:0000 0A 00000000:00000000 00:00000000 00000000 65532        0 1 1 0000000000000000 100 0 0 10 0
   1: 0201000A:D431 0100710A:01BB 01 00000000:00000000 00:00000000 00000000  1000        0 2 1 0000000000000000 20 4 30 10 -1
`

const tcp6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:3A99 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 65532        0 3 1 0000000000000000 100 0 0 10 0
   1: B80D0120000000000000000002000000:C350 B80D0120000000000000000001000000:01BB 01 00000000:00000000 00:00000000 00000000  1001        0 4 1 0000000000000000 20 4 30 10 -1
   2: 0000000000000000FFFF00000301000A:C351 0000000000000000FFFF00000100710A:01BB 01 00000000:00000000 00:00000000 00000000  1002        0 5 1 0000000000000000 20 4 30 10 -1
`

func table(t *testing.T) sockowner.Table {
	t.Helper()
	dir := t.TempDir()
	for name, body := range map[string]string{"tcp": tcp, "tcp6": tcp6, "udp": tcp, "udp6": ""} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return sockowner.Table{Dir: dir}
}

func TestTheOwnerOfASocketIsFoundByItsAddress(t *testing.T) {
	tab := table(t)
	tests := map[string]struct {
		proto string
		addr  string
		uid   int
	}{
		"IPv4":                    {"tcp", "10.0.1.2:54321", 1000},
		"IPv6":                    {"tcp", "[2001:db8::2]:50000", 1001},
		"IPv4 on an IPv6 socket":  {"tcp", "10.0.1.3:50001", 1002},
		"UDP":                     {"udp", "10.0.1.2:54321", 1000},
		"IPv4 given as IPv6-ish":  {"tcp", "[::ffff:10.0.1.2]:54321", 1000},
		"the Sentinel's listener": {"tcp", "127.0.0.1:15001", 65532},
	}
	for name, tt := range tests {
		t.Run(name, func(t *testing.T) {
			uid, ok := tab.UID(tt.proto, netip.MustParseAddrPort(tt.addr))
			if !ok || uid != tt.uid {
				t.Errorf("UID = %d, %v, want %d", uid, ok, tt.uid)
			}
		})
	}
}

func TestAnUnknownSocketHasNoOwner(t *testing.T) {
	tab := table(t)
	if uid, ok := tab.UID("tcp", netip.MustParseAddrPort("10.0.1.9:1")); ok {
		t.Errorf("UID = %d for a socket that is not there", uid)
	}
	missing := sockowner.Table{Dir: filepath.Join(t.TempDir(), "none")}
	if _, ok := missing.UID("tcp", netip.MustParseAddrPort("10.0.1.2:54321")); ok {
		t.Error("an owner was found without the files")
	}
}
