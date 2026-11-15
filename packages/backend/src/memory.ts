// The commits of /memory (ADR-0006): at the end of each turn the backend
// commits what changed, as it is, with no checks. Only the backend writes
// `.git`; the sandbox mounts it read-only.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type Author = { name: string; email: string };

export class Memory {
  private readonly dir: string;
  private readonly author: Author;
  /** Commits run one after another; a turn's end waits for the one before. */
  private last: Promise<unknown> = Promise.resolve();

  constructor(dir: string, author: Author) {
    this.dir = dir;
    this.author = author;
  }

  /** Commits everything that changed in the work tree. `clean` when nothing did. */
  commit({ agent, turnId }: { agent: string; turnId: string }): Promise<"committed" | "clean"> {
    const next = this.last.then(
      () => this.commitNow(agent, turnId),
      () => this.commitNow(agent, turnId),
    );
    this.last = next.catch(() => {});
    return next;
  }

  private async commitNow(agent: string, turnId: string): Promise<"committed" | "clean"> {
    // A Pod mounts .git on its own, so it can be there and empty: a repository has its HEAD.
    if (!existsSync(path.join(this.dir, ".git", "HEAD"))) await this.git("init", "--quiet", "--initial-branch=main");
    await this.git("add", "--all");
    const { stdout } = await this.git("status", "--porcelain");
    if (stdout === "") return "clean";
    await this.git("commit", "--quiet", "--no-verify", "--message", `Turn ${turnId}`, "--message", `Agent: ${agent}`);
    return "committed";
  }

  /**
   * git in /memory, with nothing taken from the backend's own git
   * configuration: the files belong to the sandbox's user, so the directory
   * is named safe; there are no hooks, no signing and no editor.
   */
  private git(...args: string[]) {
    return run(
      "git",
      [
        "-c",
        `safe.directory=${this.dir}`,
        "-c",
        `user.name=${this.author.name}`,
        "-c",
        `user.email=${this.author.email}`,
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      {
        cwd: this.dir,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
      },
    );
  }
}
