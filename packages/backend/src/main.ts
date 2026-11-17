// The backend holds the queue of events, the sandbox's and the UI's APIs,
// the nightly switch and the commits of the memory (ADR-0001, ADR-0002).
// `backend serve` runs it with the settings of docs/backend.md.
import { readFileSync } from "node:fs";
import process from "node:process";

import { startBackend } from "./app.ts";
import { ConfigError, loadConfig } from "./config.ts";

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

const USAGE = "usage: backend serve|version\n";

// The version is given by the image (the Dockerfile's VERSION build argument).
export function run(args: readonly string[], env: Readonly<Record<string, string | undefined>>): Result {
  if (args.length === 1 && args[0] === "version") {
    return { code: 0, stdout: `${env.PENELOPE_VERSION ?? "dev"}\n`, stderr: "" };
  }
  return { code: 2, stdout: "", stderr: USAGE };
}

/** Runs until SIGTERM or SIGINT, then closes what is open and exits. */
async function serve(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env, (file) => readFileSync(file, "utf8"));
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    process.stderr.write(`backend: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  let backend;
  try {
    backend = await startBackend(config);
  } catch (error) {
    // The chosen avatar is looked for only when it is copied, at the start.
    if (!(error instanceof ConfigError)) throw error;
    process.stderr.write(`backend: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  const stop = () => {
    backend.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "serve") {
    await serve();
  } else {
    const result = run(args, process.env);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.code;
  }
}
