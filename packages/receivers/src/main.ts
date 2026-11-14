// The receivers take events from outside (Slack, webhooks, schedules, A2A)
// through plugins and post them to the backend's intake (ADR-0002).
// For now it only reports its version.
import process from "node:process";

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

// The version is given by the image (the Dockerfile's VERSION build argument).
export function run(args: readonly string[], env: Readonly<Record<string, string | undefined>>): Result {
  if (args.length === 1 && args[0] === "version") {
    return { code: 0, stdout: `${env.PENELOPE_VERSION ?? "dev"}\n`, stderr: "" };
  }
  return { code: 2, stdout: "", stderr: "usage: receivers version\n" };
}

if (import.meta.main) {
  const result = run(process.argv.slice(2), process.env);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
