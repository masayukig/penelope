package credentials_test

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yuanying/penelope/internal/config"
	"github.com/yuanying/penelope/internal/credentials"
)

const (
	bearerSurrogate = "surrogate-bearer-0001"
	basicSurrogate  = "surrogate-basic-00002"
	headerSurrogate = "surrogate-header-0003"
	otherSurrogate  = "surrogate-other-00004"
)

// keys is a key source of fixed keys, by the credential's surrogate.
type keys map[string]string

func (k keys) Key(_ context.Context, cr config.Credential) (string, error) {
	v, ok := k[cr.Surrogate]
	if !ok {
		return "", errors.New("no key")
	}
	return v, nil
}

func host() *config.Host {
	return &config.Host{
		Name: "api.example.com",
		Port: 443,
		Credentials: []config.Credential{
			{Place: config.Bearer, Surrogate: bearerSurrogate, File: "/k/bearer"},
			{Place: config.Basic, Surrogate: basicSurrogate, File: "/k/basic"},
			{Place: config.Header, HeaderName: "X-Api-Key", Surrogate: headerSurrogate, File: "/k/header"},
		},
	}
}

var all = []string{bearerSurrogate, basicSurrogate, headerSurrogate, otherSurrogate}

var real = keys{
	bearerSurrogate: "real-bearer",
	basicSurrogate:  "real-basic",
	headerSurrogate: "real-header",
}

func request(t *testing.T, target string, header http.Header) *http.Request {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, target, nil)
	for k, vs := range header {
		for _, v := range vs {
			r.Header.Add(k, v)
		}
	}
	return r
}

func basic(user, pass string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+pass))
}

func TestSurrogatesInTheirPlacesAreSwapped(t *testing.T) {
	tests := map[string]struct {
		header     http.Header
		key, value string
	}{
		"a bearer token": {
			header: http.Header{"Authorization": {"Bearer " + bearerSurrogate}},
			key:    "Authorization", value: "Bearer real-bearer",
		},
		"a token of the token scheme": {
			header: http.Header{"Authorization": {"token " + bearerSurrogate}},
			key:    "Authorization", value: "token real-bearer",
		},
		"a basic password": {
			header: http.Header{"Authorization": {basic("x-access-token", basicSurrogate)}},
			key:    "Authorization", value: basic("x-access-token", "real-basic"),
		},
		"a named header": {
			header: http.Header{"X-Api-Key": {headerSurrogate}},
			key:    "X-Api-Key", value: "real-header",
		},
	}
	for name, tt := range tests {
		t.Run(name, func(t *testing.T) {
			r := request(t, "https://api.example.com/v1", tt.header)
			if err := credentials.Swap(context.Background(), r, host(), all, real); err != nil {
				t.Fatalf("Swap: %v", err)
			}
			if got := r.Header.Get(tt.key); got != tt.value {
				t.Errorf("%s = %q, want %q", tt.key, got, tt.value)
			}
		})
	}
}

func TestARequestWithoutASurrogateIsSentAsItIs(t *testing.T) {
	r := request(t, "https://api.example.com/v1?a=b", http.Header{"Authorization": {"Bearer owners-own-token"}})
	if err := credentials.Swap(context.Background(), r, host(), all, real); err != nil {
		t.Fatalf("Swap: %v", err)
	}
	if got := r.Header.Get("Authorization"); got != "Bearer owners-own-token" {
		t.Errorf("Authorization = %q, want it as it came", got)
	}
}

func TestASurrogateOutOfItsPlaceIsRefused(t *testing.T) {
	tests := map[string]struct {
		target string
		header http.Header
	}{
		"a bearer surrogate in another header": {
			"https://api.example.com/", http.Header{"X-Other": {bearerSurrogate}},
		},
		"a header surrogate as a bearer": {
			"https://api.example.com/", http.Header{"Authorization": {"Bearer " + headerSurrogate}},
		},
		"a basic surrogate as the user": {
			"https://api.example.com/", http.Header{"Authorization": {basic(basicSurrogate, "x")}},
		},
		"another host's surrogate": {
			"https://api.example.com/", http.Header{"Authorization": {"Bearer " + otherSurrogate}},
		},
		"a surrogate in the query": {
			"https://api.example.com/?token=" + bearerSurrogate, nil,
		},
		"a surrogate escaped in the query": {
			"https://api.example.com/?token=" + strings.ReplaceAll(bearerSurrogate, "-", "%2D"), nil,
		},
		"a surrogate in the path": {
			"https://api.example.com/hooks/" + bearerSurrogate, nil,
		},
		"a surrogate in a header's name": {
			"https://api.example.com/", http.Header{"X-" + headerSurrogate: {"1"}},
		},
		"a surrogate inside a longer value": {
			"https://api.example.com/", http.Header{"Authorization": {"Bearer x" + bearerSurrogate}},
		},
	}
	for name, tt := range tests {
		t.Run(name, func(t *testing.T) {
			r := request(t, tt.target, tt.header)
			err := credentials.Swap(context.Background(), r, host(), all, real)
			var ref *credentials.Refusal
			if !errors.As(err, &ref) || ref.Reason != credentials.ReasonSurrogate {
				t.Fatalf("Swap = %v, want a refusal for a surrogate", err)
			}
			for _, s := range all {
				if strings.Contains(err.Error(), s) {
					t.Errorf("the refusal holds a surrogate: %v", err)
				}
			}
		})
	}
}

func TestARequestWhoseKeyCannotBeReadIsRefused(t *testing.T) {
	r := request(t, "https://api.example.com/", http.Header{"Authorization": {"Bearer " + bearerSurrogate}})
	err := credentials.Swap(context.Background(), r, host(), all, keys{})
	var ref *credentials.Refusal
	if !errors.As(err, &ref) || ref.Reason != credentials.ReasonKey {
		t.Fatalf("Swap = %v, want a refusal for the key", err)
	}
	if got := r.Header.Get("Authorization"); got != "Bearer "+bearerSurrogate {
		t.Errorf("a refused request was changed: Authorization = %q", got)
	}
}

func TestFindTellsWhetherARequestHoldsASurrogate(t *testing.T) {
	if credentials.Holds(request(t, "http://x.example.com/", http.Header{"Cookie": {"a=" + otherSurrogate}}), all) == "" {
		t.Error("a surrogate in a cookie is not found")
	}
	if got := credentials.Holds(request(t, "http://x.example.com/?q=1", http.Header{"Accept": {"*/*"}}), all); got != "" {
		t.Errorf("Holds = %q for a request without a surrogate", got)
	}
}

func TestTheFileSourceReadsTheKeyEachTime(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")
	cr := config.Credential{Place: config.Bearer, Surrogate: bearerSurrogate, File: path}
	var src credentials.Files
	if _, err := src.Key(context.Background(), cr); err == nil {
		t.Error("a missing file gave a key")
	}
	if err := os.WriteFile(path, []byte("first\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, err := src.Key(context.Background(), cr); err != nil || got != "first" {
		t.Errorf("Key = %q, %v, want first without its newline", got, err)
	}
	if err := os.WriteFile(path, []byte("second"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, _ := src.Key(context.Background(), cr); got != "second" {
		t.Errorf("Key = %q after the file changed, want second", got)
	}
	if err := os.WriteFile(path, []byte("\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := src.Key(context.Background(), cr); err == nil {
		t.Error("an empty file gave a key")
	}
}
