// The backend holds the queue of events, the UI's API, the nightly switch,
// the commits of the memory and the window for approvals (ADR-0001, ADR-0002).
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
  return { code: 2, stdout: "", stderr: "usage: backend version\n" };
}

if (import.meta.main) {
  const result = run(process.argv.slice(2), process.env);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
