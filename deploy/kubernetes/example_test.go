// Package kubernetes holds no code: these tests keep the example deployment
// (example/) one that the Pod accepts, so that copying it is a working start.
// That `kustomize build` takes it is checked by `make test-deploy`.
package kubernetes_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"go.yaml.in/yaml/v4"

	"github.com/yuanying/penelope/internal/config"
)

const example = "example"

func loadSentinel(t *testing.T) *config.Config {
	t.Helper()
	c, err := config.Load(filepath.Join(example, "sentinel", "sentinel.yaml"))
	if err != nil {
		t.Fatalf("the Sentinel refuses the example's sentinel.yaml: %v", err)
	}
	return c
}

// The Sentinel starts on the example's settings.
func TestExampleSentinelConfigLoads(t *testing.T) {
	loadSentinel(t)
}

// Every surrogate the sandbox is given is one the Sentinel swaps; a surrogate
// it does not know would be refused on its way out.
func TestExampleSandboxSurrogatesAreRegistered(t *testing.T) {
	registered := loadSentinel(t).Surrogates()

	var given []string
	env, err := os.ReadFile(filepath.Join(example, "sandbox", "surrogates.env"))
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(env), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		_, value, _ := strings.Cut(line, "=")
		if strings.HasPrefix(value, "https://") {
			continue // an endpoint, not a surrogate
		}
		given = append(given, value)
	}

	b, err := os.ReadFile(filepath.Join(example, "sandbox", "models.json"))
	if err != nil {
		t.Fatal(err)
	}
	var models struct {
		Providers map[string]struct {
			APIKey string `json:"apiKey"`
		} `json:"providers"`
	}
	if err := json.Unmarshal(b, &models); err != nil {
		t.Fatal(err)
	}
	for _, p := range models.Providers {
		given = append(given, p.APIKey)
	}

	for _, v := range given {
		if !slices.Contains(registered, v) {
			t.Errorf("the sandbox has a surrogate the Sentinel does not register: %s", v)
		}
	}
}

// The connectors and the registrations agree (docs/sentinel-config.md,
// "コネクタの文書"): every host a document names is registered, and every
// registration that swaps a key is named by a document.
func TestExampleConnectorsMatchRegistrations(t *testing.T) {
	c := loadSentinel(t)
	var registered []string
	for _, h := range c.Hosts {
		registered = append(registered, h.Name)
	}

	files, err := filepath.Glob(filepath.Join(example, "connectors", "*.md"))
	if err != nil {
		t.Fatal(err)
	}
	var named []string
	for _, file := range files {
		b, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		parts := strings.SplitN(string(b), "---\n", 3)
		if len(parts) != 3 || parts[0] != "" {
			t.Errorf("%s: no front matter", file)
			continue
		}
		var front struct {
			Name  string   `yaml:"name"`
			Hosts []string `yaml:"hosts"`
		}
		if err := yaml.Unmarshal([]byte(parts[1]), &front); err != nil {
			t.Errorf("%s: %v", file, err)
			continue
		}
		if front.Name != strings.TrimSuffix(filepath.Base(file), ".md") {
			t.Errorf("%s: name %q is not the file's name", file, front.Name)
		}
		for _, h := range front.Hosts {
			if !slices.Contains(registered, h) {
				t.Errorf("%s: host %s is not registered with the Sentinel", file, h)
			}
		}
		named = append(named, front.Hosts...)
	}

	for _, h := range c.Hosts {
		if len(h.Credentials) > 0 && !slices.Contains(named, h.Name) {
			t.Errorf("registration %s swaps a key but no connector names it", h.Name)
		}
	}
}
