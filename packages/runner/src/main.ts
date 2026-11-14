// The runner runs the session with Pi's SDK inside the sandbox, taking the
// events from the backend one turn at a time (ADR-0001, ADR-0002).
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
  return { code: 2, stdout: "", stderr: "usage: runner version\n" };
}

if (import.meta.main) {
  const result = run(process.argv.slice(2), process.env);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
