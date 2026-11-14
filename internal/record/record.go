// Package record writes the Sentinel's records: one line of JSON for each
// connection, request and name lookup, in the shape of
// docs/sentinel-config.md "記録". A record never holds a key or a
// surrogate.
package record

import (
	"encoding/json"
	"io"
	"strings"
	"sync"
	"time"
)

// Kind is what a record is of.
type Kind string

const (
	// KindTCP is a connection that was not read as HTTP: passed through
	// as it was, or refused.
	KindTCP Kind = "tcp"
	// KindHTTP is one request read: on an opened host, or in plain HTTP.
	KindHTTP Kind = "http"
	// KindDNS is one name lookup.
	KindDNS Kind = "dns"
)

// Action is what the Sentinel did.
type Action string

const (
	Passthrough Action = "passthrough"
	Open        Action = "open"
	Deny        Action = "deny"
)

// Record is one line.
type Record struct {
	Time time.Time `json:"time"`
	Kind Kind      `json:"kind"`
	// UID is the sender's, when it was found.
	UID   *int   `json:"uid,omitempty"`
	Agent string `json:"agent,omitempty"`
	// Host is the SNI or the Host, or the name looked up.
	Host   string `json:"host,omitempty"`
	Addr   string `json:"addr,omitempty"`
	Port   uint16 `json:"port,omitempty"`
	Action Action `json:"action"`
	Reason string `json:"reason,omitempty"`
	// Method, Path and Status are for a request read.
	Method string `json:"method,omitempty"`
	Path   string `json:"path,omitempty"`
	Status int    `json:"status,omitempty"`
	// QType is the type of a name lookup (A, AAAA, ...).
	QType string `json:"qtype,omitempty"`
	// BytesIn came from the upstream to the sandbox, BytesOut went from
	// the sandbox to the upstream.
	BytesIn  int64         `json:"bytes_in"`
	BytesOut int64         `json:"bytes_out"`
	Duration time.Duration `json:"-"`
	// Error is what went wrong on the way, for a connection or request
	// that was not refused but did not get through.
	Error string `json:"error,omitempty"`
}

// MarshalJSON writes the duration in milliseconds.
func (r *Record) MarshalJSON() ([]byte, error) {
	type plain Record
	return json.Marshal(struct {
		*plain
		DurationMS int64 `json:"duration_ms"`
	}{(*plain)(r), r.Duration.Milliseconds()})
}

// Log writes records to one writer, a whole line at a time.
type Log struct {
	mu sync.Mutex
	w  io.Writer
}

// NewLog makes a Log that writes to w.
func NewLog(w io.Writer) *Log { return &Log{w: w} }

// Write writes rec as one line. A record that cannot be written is lost:
// the connection it is of has already gone its way.
func (l *Log) Write(rec *Record) {
	b, err := json.Marshal(rec)
	if err != nil {
		return
	}
	b = append(b, '\n')
	l.mu.Lock()
	defer l.mu.Unlock()
	_, _ = l.w.Write(b)
}

// Scrub replaces each surrogate in s, so that s can be recorded.
func Scrub(s string, surrogates []string) string {
	for _, sur := range surrogates {
		s = strings.ReplaceAll(s, sur, "[surrogate]")
	}
	return s
}
