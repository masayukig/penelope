// Command sentinel is the relay every outbound connection of the sandbox goes
// through (ADR-0003). `sentinel serve -config PATH` serves the configuration
// of docs/sentinel-config.md; `sentinel version` reports the version.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

const usage = "usage: sentinel serve -config PATH | sentinel version"

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		_, _ = fmt.Fprintln(stderr, usage)
		return 2
	}
	switch args[0] {
	case "version":
		_, _ = fmt.Fprintln(stdout, version)
		return 0
	case "serve":
		fs := flag.NewFlagSet("serve", flag.ContinueOnError)
		fs.SetOutput(stderr)
		path := fs.String("config", "", "the configuration file (docs/sentinel-config.md)")
		if err := fs.Parse(args[1:]); err != nil {
			return 2
		}
		if *path == "" || fs.NArg() != 0 {
			_, _ = fmt.Fprintln(stderr, usage)
			return 2
		}
		logger := slog.New(slog.NewJSONHandler(stderr, nil))
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if err := serve(ctx, *path, stdout, logger, nil); err != nil {
			logger.Error("the Sentinel stopped", "error", err.Error())
			return 1
		}
		return 0
	}
	_, _ = fmt.Fprintln(stderr, usage)
	return 2
}
