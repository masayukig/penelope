package config_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yuanying/penelope/internal/config"
	"github.com/yuanying/penelope/internal/testca"
)

// base is the Sentinel's own part of a configuration, which every test
// needs; the tests add the rest.
const base = `
listen:
  proxy: ["127.0.0.1:15001", "[::1]:15001"]
  dns: ["127.0.0.1:15053"]
ca:
  cert: /run/ca/tls.crt
  key: /run/ca/tls.key
`

func parse(t *testing.T, rest string) (*config.Config, error) {
	t.Helper()
	return config.Parse([]byte(base + rest))
}

func mustParse(t *testing.T, rest string) *config.Config {
	t.Helper()
	c, err := parse(t, rest)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	return c
}

func TestTheExampleOfTheSpecificationIsRead(t *testing.T) {
	ca := testca.New(t)
	c := mustParse(t, `
default: passthrough
hosts:
  - name: api.example.com
    credentials:
      - place: bearer
        surrogate: surrogate-example-0001
        source: { file: /run/secrets/example/token }
  - name: backend.example.com
    upstream: unix:///run/penelope/backend/sandbox.sock
    credentials:
      - place: bearer
        surrogate: surrogate-example-0003
        source: { file: /run/secrets/example/backend-token }
  - name: kubernetes.default.svc
    upstream_ca: `+ca.CertFile+`
    credentials:
      - place: bearer
        surrogate: surrogate-example-0002
        source: { file: /run/secrets/example/sa-token }
allow: []
`)
	if c.Default != config.Passthrough {
		t.Errorf("Default = %q, want passthrough", c.Default)
	}
	if got := len(c.Hosts); got != 3 {
		t.Fatalf("%d hosts, want 3", got)
	}
	api := c.Lookup("api.example.com", 443)
	if api == nil {
		t.Fatal("api.example.com:443 is not registered")
	}
	if api.Upstream.Scheme != "https" || api.Upstream.Address != "api.example.com:443" {
		t.Errorf("api's upstream = %+v, want https to api.example.com:443", api.Upstream)
	}
	be := c.Lookup("backend.example.com", 443)
	if be == nil || be.Upstream.Scheme != "unix" || be.Upstream.Address != "/run/penelope/backend/sandbox.sock" {
		t.Errorf("backend's upstream = %+v, want the unix socket", be)
	}
	k := c.Lookup("kubernetes.default.svc", 443)
	if k == nil || k.RootCAs == nil {
		t.Error("the cluster's registration has no CA for its upstream")
	}
	if got := c.Surrogates(); len(got) != 3 {
		t.Errorf("Surrogates = %d values, want 3", len(got))
	}
}

func TestTheSentinelsOwnPartIsRead(t *testing.T) {
	c := mustParse(t, "resolver: 10.0.0.10:53\n")
	if got := c.Listen.Proxy; len(got) != 2 || got[0] != "127.0.0.1:15001" || got[1] != "[::1]:15001" {
		t.Errorf("Listen.Proxy = %v", got)
	}
	if got := c.Listen.DNS; len(got) != 1 || got[0] != "127.0.0.1:15053" {
		t.Errorf("Listen.DNS = %v", got)
	}
	if c.Resolver != "10.0.0.10:53" {
		t.Errorf("Resolver = %q", c.Resolver)
	}
	if c.CA.Cert != "/run/ca/tls.crt" || c.CA.Key != "/run/ca/tls.key" {
		t.Errorf("CA = %+v", c.CA)
	}
}

func TestDefaultsAreFilledIn(t *testing.T) {
	c := mustParse(t, `
hosts:
  - name: API.Example.com.
`)
	if c.Default != config.Passthrough {
		t.Errorf("Default = %q, want passthrough when left out", c.Default)
	}
	h := c.Lookup("api.example.com", 443)
	if h == nil {
		t.Fatal("the name is not compared without case and trailing dot, or the port is not 443")
	}
	if h.Name != "api.example.com" {
		t.Errorf("Name = %q", h.Name)
	}
	if c.Lookup("api.example.com", 8443) != nil {
		t.Error("a registration answers for a port that is not its own")
	}
	if c.Lookup("API.example.com.", 443) != h {
		t.Error("Lookup does not compare without case and trailing dot")
	}
}

func TestUpstreamsAreURLs(t *testing.T) {
	tests := map[string]struct {
		upstream, scheme, address string
	}{
		"https with a port":    {"https://10.0.0.1:6443", "https", "10.0.0.1:6443"},
		"https without a port": {"https://upstream.example.com", "https", "upstream.example.com:443"},
		"http with a port":     {"http://backend.example.com:8080", "http", "backend.example.com:8080"},
		"http without a port":  {"http://backend.example.com", "http", "backend.example.com:80"},
		"a unix socket":        {"unix:///run/x.sock", "unix", "/run/x.sock"},
	}
	for name, tt := range tests {
		t.Run(name, func(t *testing.T) {
			c := mustParse(t, "hosts:\n  - name: api.example.com\n    upstream: "+tt.upstream+"\n")
			u := c.Lookup("api.example.com", 443).Upstream
			if u.Scheme != tt.scheme || u.Address != tt.address {
				t.Errorf("upstream = %+v, want %s %s", u, tt.scheme, tt.address)
			}
		})
	}
}

func TestAskIsRefusedUntilApprovalsAreServed(t *testing.T) {
	_, err := parse(t, "default: ask\n")
	if err == nil || !strings.Contains(err.Error(), "ask") {
		t.Fatalf("Parse = %v, want an error about ask", err)
	}
	c := mustParse(t, "default: deny\n")
	if c.Default != config.Deny {
		t.Errorf("Default = %q, want deny", c.Default)
	}
}

func TestAConfigurationThatCannotBeServedIsRefused(t *testing.T) {
	tests := map[string]string{
		"an unknown field":         "hosts:\n  - name: api.example.com\n    uptream: http://x\n",
		"an unknown default":       "default: open\n",
		"an allow list":            "allow: [api.example.com]\n",
		"a connector":              "hosts:\n  - name: api.example.com\n    connector: github\n",
		"a connector's config":     "hosts:\n  - name: api.example.com\n    connector_config: {a: 1}\n",
		"a host without a name":    "hosts:\n  - port: 443\n",
		"a name that is an IP":     "hosts:\n  - name: 10.0.0.1\n",
		"a name that is not one":   "hosts:\n  - name: api..example.com\n",
		"a port out of range":      "hosts:\n  - name: api.example.com\n    port: 70000\n",
		"the same host twice":      "hosts:\n  - name: api.example.com\n  - name: API.example.com\n",
		"an upstream of no scheme": "hosts:\n  - name: api.example.com\n    upstream: api.example.com:443\n",
		"an upstream with a path":  "hosts:\n  - name: api.example.com\n    upstream: https://api.example.com/v1\n",
		"a relative unix socket":   "hosts:\n  - name: api.example.com\n    upstream: unix://run/x.sock\n",
		"an upstream CA missing":   "hosts:\n  - name: api.example.com\n    upstream_ca: /nonexistent/ca.crt\n",
		"an unknown place":         cred("place: query", "surrogate-example-0001"),
		"a header place unnamed":   cred("place: header", "surrogate-example-0001"),
		"a header on bearer":       cred("place: bearer\n        header: x-api-key", "surrogate-example-0001"),
		"a short surrogate":        cred("place: bearer", "short"),
		"a surrogate with a space": cred("place: bearer", "'surrogate example 0001'"),
		"no source":                "hosts:\n  - name: api.example.com\n    credentials:\n      - place: bearer\n        surrogate: surrogate-example-0001\n",
		"the same surrogate twice": "hosts:\n  - name: a.example.com\n" + creds("surrogate-example-0001") +
			"  - name: b.example.com\n" + creds("surrogate-example-0001"),
		"no proxy listener": "",
	}
	for name, rest := range tests {
		t.Run(name, func(t *testing.T) {
			src := base + rest
			if name == "no proxy listener" {
				src = "listen:\n  dns: [\"127.0.0.1:15053\"]\nca: {cert: a, key: b}\n"
			}
			if _, err := config.Parse([]byte(src)); err == nil {
				t.Fatal("Parse returned no error")
			}
		})
	}
}

// YAML diagnostics retain locations and unknown field names, never values.
func TestYAMLErrorShapes(t *testing.T) {
	const prefix = "the configuration is not YAML of the configuration's shape: "
	tests := []struct {
		name, src, want string
	}{
		{"unknown field", "hosts:\n  - name: api.example.com\n    uptream: surrogate-example-0001\n", "line 3: unknown field uptream"},
		{"wrong shape", "hosts:\n  - port: surrogate-example-0001\n", "line 2: a value of the wrong shape"},
		{"multiple errors", "hosts:\n  - port: surrogate-example-0001\n    credentials: surrogate-example-0002\n", "line 2: a value of the wrong shape; line 3: a value of the wrong shape"},
		{"syntax error", "hosts: [surrogate-example-0001\n", "line 2: not YAML"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := config.Parse([]byte(tt.src))
			if err == nil || err.Error() != prefix+tt.want {
				t.Fatalf("Parse = %v, want %q", err, prefix+tt.want)
			}
		})
	}
}

func TestTheSentinelsOwnPartIsRequired(t *testing.T) {
	tests := map[string]string{
		"no DNS listener": "listen:\n  proxy: [\"127.0.0.1:15001\"]\nca: {cert: a, key: b}\n",
		"no CA":           "listen:\n  proxy: [\"127.0.0.1:15001\"]\n  dns: [\"127.0.0.1:15053\"]\n",
		"a bad listener":  "listen:\n  proxy: [\"15001\"]\n  dns: [\"127.0.0.1:15053\"]\nca: {cert: a, key: b}\n",
		"a bad resolver":  base + "resolver: nowhere\n",
	}
	for name, src := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := config.Parse([]byte(src)); err == nil {
				t.Fatal("Parse returned no error")
			}
		})
	}
}

func TestErrorsNeverHoldASurrogate(t *testing.T) {
	_, err := parse(t, "hosts:\n  - name: a.example.com\n"+creds("surrogate-example-0001")+
		"  - name: b.example.com\n"+creds("surrogate-example-0001"))
	if err == nil {
		t.Fatal("Parse returned no error")
	}
	if strings.Contains(err.Error(), "surrogate-example-0001") {
		t.Errorf("the error holds the surrogate: %v", err)
	}
	for _, rest := range []string{
		"hosts:\n  - name: api.example.com\n    port: surrogate-example-0001\n",
		"hosts:\n  - name: api.example.com\n    credentials: surrogate-example-0001\n",
		"hosts: [surrogate-example-0001\n",
	} {
		_, err := parse(t, rest)
		if err == nil {
			t.Fatalf("Parse(%q) returned no error", rest)
		}
		if strings.Contains(err.Error(), "surrogate-example-0001") {
			t.Errorf("the YAML error holds what the document said: %v", err)
		}
	}
}

func TestLoadReadsAFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sentinel.yaml")
	if err := os.WriteFile(path, []byte(base), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := config.Load(path); err != nil {
		t.Fatalf("Load: %v", err)
	}
	if _, err := config.Load(filepath.Join(t.TempDir(), "missing.yaml")); err == nil {
		t.Error("Load of a missing file returned no error")
	}
}

func TestTheSentinelsOwnPartIsComparedForReloads(t *testing.T) {
	a := mustParse(t, "default: passthrough\n")
	b := mustParse(t, "default: deny\nhosts:\n  - name: api.example.com\n")
	if !a.SameServing(b) {
		t.Error("a change of hosts and default is taken as a change of the Sentinel's own part")
	}
	c, err := config.Parse([]byte(strings.Replace(base, "15053", "15054", 1)))
	if err != nil {
		t.Fatal(err)
	}
	if a.SameServing(c) {
		t.Error("a change of a listener is not seen")
	}
}

func cred(place, surrogate string) string {
	return "hosts:\n  - name: api.example.com\n    credentials:\n      - " + place +
		"\n        surrogate: " + surrogate + "\n        source: { file: /run/k }\n"
}

func creds(surrogate string) string {
	return "    credentials:\n      - place: bearer\n        surrogate: " + surrogate + "\n        source: { file: /run/k }\n"
}
