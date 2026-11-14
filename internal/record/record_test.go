package record_test

import (
	"bytes"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yuanying/penelope/internal/record"
)

func TestARecordIsOneLineOfJSON(t *testing.T) {
	var buf bytes.Buffer
	log := record.NewLog(&buf)
	uid := 1000
	at := time.Date(2026, 11, 14, 9, 0, 0, 0, time.UTC)
	log.Write(&record.Record{
		Time: at, Kind: record.KindHTTP, UID: &uid, Host: "api.example.com",
		Addr: "203.0.113.1", Port: 443, Action: record.Open,
		Method: "GET", Path: "/v1", Status: 200, BytesIn: 10, BytesOut: 2,
		Duration: 1500 * time.Millisecond,
	})
	line := buf.String()
	if strings.Count(line, "\n") != 1 || !strings.HasSuffix(line, "\n") {
		t.Fatalf("not one line: %q", line)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(line), &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"time": "2026-11-14T09:00:00Z", "kind": "http", "uid": 1000.0, "host": "api.example.com",
		"addr": "203.0.113.1", "port": 443.0, "action": "open", "method": "GET", "path": "/v1",
		"status": 200.0, "bytes_in": 10.0, "bytes_out": 2.0, "duration_ms": 1500.0,
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %v, want %v", k, got[k], v)
		}
	}
	for _, k := range []string{"agent", "reason"} {
		if _, ok := got[k]; ok {
			t.Errorf("%s is written though empty", k)
		}
	}
}

func TestUIDZeroIsWrittenAndAnUnknownUIDIsNot(t *testing.T) {
	var buf bytes.Buffer
	log := record.NewLog(&buf)
	root := 0
	log.Write(&record.Record{Kind: record.KindTCP, Action: record.Passthrough, UID: &root})
	log.Write(&record.Record{Kind: record.KindTCP, Action: record.Passthrough})
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if !strings.Contains(lines[0], `"uid":0`) {
		t.Errorf("UID 0 is not written: %s", lines[0])
	}
	if strings.Contains(lines[1], `"uid"`) {
		t.Errorf("an unknown UID is written: %s", lines[1])
	}
}

func TestRecordsWrittenAtOnceStayWhole(t *testing.T) {
	var buf bytes.Buffer
	log := record.NewLog(&buf)
	var wg sync.WaitGroup
	for range 50 {
		wg.Go(func() {
			log.Write(&record.Record{Kind: record.KindDNS, Host: strings.Repeat("a", 200), Action: record.Passthrough})
		})
	}
	wg.Wait()
	for _, l := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		if !json.Valid([]byte(l)) {
			t.Fatalf("a broken line: %q", l)
		}
	}
}

func TestScrubTakesSurrogatesOut(t *testing.T) {
	got := record.Scrub("/hooks/surrogate-example-0001/x", []string{"surrogate-example-0001"})
	if strings.Contains(got, "surrogate-example-0001") {
		t.Errorf("Scrub = %q", got)
	}
	if got != "/hooks/[surrogate]/x" {
		t.Errorf("Scrub = %q, want /hooks/[surrogate]/x", got)
	}
}
