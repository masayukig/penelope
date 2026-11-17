// avatar: the agent's tool for her avatar in /memory/avatar/ (ADR-0036).
// `avatar check` reads it as the backend does and says what is wrong in it.
import process from "node:process";

import { readAvatar } from "./index.ts";

export type Result = { code: number; stdout: string; stderr: string };

/** Where the backend keeps the avatar it reads. */
export const DEFAULT_DIR = "/memory/avatar";

const USAGE = `usage: avatar check [DIR]

Reads the avatar in DIR (default ${DEFAULT_DIR}) as the backend reads it:
avatar.json, and the image of each face it lists. Prints what is wrong, one
line each, and exits 1; or prints what the backend takes, and exits 0.
`;

export function run(args: readonly string[]): Result {
  const [command, dir = DEFAULT_DIR, ...rest] = args;
  if (command !== "check" || rest.length > 0) return { code: 2, stdout: "", stderr: USAGE };
  const { avatar, problems } = readAvatar(dir);
  if (problems.length > 0) return { code: 1, stdout: problems.map((problem) => `${problem}\n`).join(""), stderr: "" };
  const faces = (images: Record<string, string>) => Object.keys(images).sort().join(", ") || "none";
  return {
    code: 0,
    stdout: `ok: ${dir}\nname: ${avatar.name ?? "none"}\nicons: ${faces(avatar.icons)}\npngIcons: ${faces(avatar.pngIcons)}\n`,
    stderr: "",
  };
}

if (import.meta.main) {
  const result = run(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
