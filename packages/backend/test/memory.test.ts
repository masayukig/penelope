import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { Memory } from "../src/memory.ts";
import { tempDir } from "./support.ts";

const author = { name: "penelope-backend", email: "backend@penelope.invalid" };

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-c", `safe.directory=${dir}`, ...args], { cwd: dir, encoding: "utf8" });
}

describe("the memory", () => {
  it("makes the repository when /memory has none yet", async (t) => {
    const dir = tempDir(t);
    writeFileSync(path.join(dir, "always.md"), "# always\n");
    const memory = new Memory(dir, author);
    assert.equal(await memory.commit({ agent: "main", turnId: "t-1" }), "committed");
    assert.equal(git(dir, "ls-files"), "always.md\n");
  });

  it("commits what changed as it is, as the backend, saying which turn", async (t) => {
    const dir = tempDir(t);
    const memory = new Memory(dir, author);
    writeFileSync(path.join(dir, "always.md"), "# always\n");
    mkdirSync(path.join(dir, "diary"));
    writeFileSync(path.join(dir, "diary/2026-11-14.md"), "today\n");
    await memory.commit({ agent: "main", turnId: "t-1" });
    rmSync(path.join(dir, "always.md"));
    writeFileSync(path.join(dir, "diary/2026-11-14.md"), "today, later\n");
    writeFileSync(path.join(dir, "notes.bin"), Buffer.from([0, 1, 2]));
    assert.equal(await memory.commit({ agent: "main", turnId: "t-2" }), "committed");

    assert.equal(git(dir, "log", "-1", "--format=%an <%ae>%n%s%n%b").trim(), [
      "penelope-backend <backend@penelope.invalid>",
      "Turn t-2",
      "Agent: main",
    ].join("\n"));
    assert.equal(git(dir, "show", "--name-status", "--format=", "HEAD").trim(), [
      "D\talways.md",
      "M\tdiary/2026-11-14.md",
      "A\tnotes.bin",
    ].join("\n"));
  });

  it("makes no commit when nothing changed", async (t) => {
    const dir = tempDir(t);
    const memory = new Memory(dir, author);
    writeFileSync(path.join(dir, "always.md"), "# always\n");
    await memory.commit({ agent: "main", turnId: "t-1" });
    assert.equal(await memory.commit({ agent: "main", turnId: "t-2" }), "clean");
    assert.equal(git(dir, "rev-list", "--count", "HEAD").trim(), "1");
  });

  it("makes no commit in a new repository with nothing in it", async (t) => {
    const memory = new Memory(tempDir(t), author);
    assert.equal(await memory.commit({ agent: "main", turnId: "t-1" }), "clean");
  });

  it("commits one turn after another when two ends come at once", async (t) => {
    const dir = tempDir(t);
    const memory = new Memory(dir, author);
    writeFileSync(path.join(dir, "a.md"), "a\n");
    const first = memory.commit({ agent: "main", turnId: "t-1" });
    const second = memory.commit({ agent: "main", turnId: "t-2" });
    assert.deepEqual(await Promise.all([first, second]), ["committed", "clean"]);
  });

  it("fails, saying why, when git fails", async (t) => {
    const dir = path.join(tempDir(t), "not-there");
    await assert.rejects(new Memory(dir, author).commit({ agent: "main", turnId: "t-1" }));
  });
});
