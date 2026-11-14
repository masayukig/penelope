// Package credentials swaps the surrogates of a request to a registered
// host for the real keys (ADR-0004), and finds surrogates where nothing
// swaps them, so that the request is refused (docs/sentinel-config.md
// "登録の無いホストへのサロゲート").
//
// The places a surrogate is swapped in are the Bearer (and token) of an
// Authorization, the password of a Basic Authorization, and a header named
// in the registration. The handling of these places is ported from
// natsumi-sentinel's internal/authd/handler.go.
//
// Nothing this package returns holds a surrogate or a key.
package credentials

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/yuanying/penelope/internal/config"
)

// Source gives the real key of a credential. It is asked each time a
// surrogate is swapped, so that a key that changes is picked up.
type Source interface {
	Key(ctx context.Context, cr config.Credential) (string, error)
}

// Files is the Source that reads the key from the credential's file each
// time, without the whitespace around it (ADR-0004: a ServiceAccount token
// the kubelet writes again is read again).
type Files struct{}

// Key reads the key from cr.File.
func (Files) Key(_ context.Context, cr config.Credential) (string, error) {
	b, err := os.ReadFile(cr.File)
	if err != nil {
		return "", err
	}
	key := strings.TrimSpace(string(b))
	if key == "" {
		return "", fmt.Errorf("%s is empty", cr.File)
	}
	return key, nil
}

// Reason names why a request was refused.
type Reason string

const (
	// ReasonSurrogate is a surrogate where nothing swaps it.
	ReasonSurrogate Reason = "surrogate-out-of-place"
	// ReasonKey is a real key that could not be read.
	ReasonKey Reason = "key-unavailable"
)

// Refusal is a request that is not to be sent.
type Refusal struct {
	Reason  Reason
	Message string
}

func (r *Refusal) Error() string { return string(r.Reason) + ": " + r.Message }

// edit is one surrogate found in its place, to be swapped.
type edit struct {
	header string
	// index is the value's among the header's values.
	index int
	cred  config.Credential
}

// Swap swaps the surrogates of h's credentials found in their places in r
// for the real keys from src. Then no surrogate of all may be left in r:
// one that is (in another place, or another host's) has the request
// refused. A request with no surrogate is left as it came. r is changed
// only when nothing is refused.
func Swap(ctx context.Context, r *http.Request, h *config.Host, all []string, src Source) error {
	var edits []edit
	for _, cr := range h.Credentials {
		switch cr.Place {
		case config.Bearer, config.Basic:
			for i, v := range r.Header.Values("Authorization") {
				if s, ok := inAuthorization(cr.Place, v); ok && s == cr.Surrogate {
					edits = append(edits, edit{header: "Authorization", index: i, cred: cr})
				}
			}
		case config.Header:
			name := http.CanonicalHeaderKey(cr.HeaderName)
			for i, v := range r.Header.Values(name) {
				if strings.TrimSpace(v) == cr.Surrogate {
					edits = append(edits, edit{header: name, index: i, cred: cr})
				}
			}
		}
	}

	keys := map[string]string{}
	for _, e := range edits {
		if _, ok := keys[e.cred.Surrogate]; ok {
			continue
		}
		key, err := src.Key(ctx, e.cred)
		if err != nil {
			return &Refusal{Reason: ReasonKey, Message: "the real key for a surrogate of this host cannot be read"}
		}
		keys[e.cred.Surrogate] = key
	}

	header := r.Header.Clone()
	for _, e := range edits {
		key := keys[e.cred.Surrogate]
		old := header[e.header][e.index]
		switch e.cred.Place {
		case config.Bearer:
			scheme, _, _ := strings.Cut(strings.TrimSpace(old), " ")
			header[e.header][e.index] = scheme + " " + key
		case config.Basic:
			user, _ := basicUser(old)
			header[e.header][e.index] = "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+key))
		case config.Header:
			header[e.header][e.index] = key
		}
	}

	swapped := *r
	swapped.Header = header
	if where := Holds(&swapped, all); where != "" {
		return &Refusal{Reason: ReasonSurrogate, Message: "a surrogate is in the request's " + where + ", where nothing swaps it"}
	}
	r.Header = header
	return nil
}

// Holds says where in r one of the surrogates is: in a header's name or
// value (a Basic one decoded), the path or the query, as they came or
// unescaped. It is empty when there is none. The body is not looked in.
func Holds(r *http.Request, surrogates []string) string {
	if len(surrogates) == 0 {
		return ""
	}
	in := func(s string) bool {
		for _, sur := range surrogates {
			if strings.Contains(s, sur) {
				return true
			}
		}
		return false
	}
	for k, vs := range r.Header {
		// A header's name loses its case on the way: compare without.
		if inName(k, surrogates) {
			return "headers"
		}
		for _, v := range vs {
			if in(v) {
				return "headers"
			}
			if scheme, rest, ok := strings.Cut(strings.TrimSpace(v), " "); ok && strings.EqualFold(scheme, "Basic") {
				if b, err := base64.StdEncoding.DecodeString(strings.TrimSpace(rest)); err == nil && in(string(b)) {
					return "headers"
				}
			}
		}
	}
	if in(r.URL.Path) || in(r.URL.RawPath) || in(unescape(r.URL.EscapedPath())) {
		return "path"
	}
	if q := r.URL.RawQuery; in(q) || in(unescape(q)) {
		return "query"
	}
	return ""
}

func inName(name string, surrogates []string) bool {
	name = strings.ToLower(name)
	for _, sur := range surrogates {
		if strings.Contains(name, strings.ToLower(sur)) {
			return true
		}
	}
	return false
}

func unescape(s string) string {
	u, err := url.QueryUnescape(s)
	if err != nil {
		return ""
	}
	return u
}

// inAuthorization returns the candidate surrogate in an Authorization value
// for a bearer or basic place.
func inAuthorization(p config.Place, v string) (string, bool) {
	scheme, rest, ok := strings.Cut(strings.TrimSpace(v), " ")
	if !ok {
		return "", false
	}
	rest = strings.TrimSpace(rest)
	switch p {
	case config.Bearer:
		if strings.EqualFold(scheme, "Bearer") || strings.EqualFold(scheme, "token") {
			return rest, true
		}
	case config.Basic:
		if strings.EqualFold(scheme, "Basic") {
			b, err := base64.StdEncoding.DecodeString(rest)
			if err != nil {
				return "", false
			}
			_, pass, ok := strings.Cut(string(b), ":")
			return pass, ok
		}
	}
	return "", false
}

func basicUser(v string) (string, bool) {
	_, rest, _ := strings.Cut(strings.TrimSpace(v), " ")
	b, err := base64.StdEncoding.DecodeString(strings.TrimSpace(rest))
	if err != nil {
		return "", false
	}
	user, _, ok := strings.Cut(string(b), ":")
	return user, ok
}

// IsRefusal reports whether err is a Refusal, and returns it.
func IsRefusal(err error) (*Refusal, bool) {
	return errors.AsType[*Refusal](err)
}
