import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { AgentAvatar, seedAvatar } from "../src/avatar.ts";
import { ConfigError } from "../src/config.ts";
import { Memory } from "../src/memory.ts";
import { tempDir } from "./support.ts";

const author = { name: "penelope-backend", email: "backend@penelope.invalid" };
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);
const quiet = () => {};

/** An avatar `id` under `dir`, named `name`, with a neutral face. */
function avatarIn(dir: string, id: string, name: string): void {
  mkdirSync(path.join(dir, id, "icons"), { recursive: true });
  writeFileSync(path.join(dir, id, "avatar.json"), JSON.stringify({ name, icons: { neutral: "icons/neutral.webp" } }));
  writeFileSync(path.join(dir, id, "icons/neutral.webp"), WEBP);
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-c", `safe.directory=${dir}`, ...args], { cwd: dir, encoding: "utf8" });
}

describe("copying the avatar into /memory", () => {
  it("copies the chosen avatar when /memory has none, and commits it", async (t) => {
    const root = tempDir(t);
    const memoryDir = path.join(root, "memory");
    mkdirSync(memoryDir);
    avatarIn(path.join(root, "image"), "iris", "Iris");
    const memory = new Memory(memoryDir, author);
    const dir = await seedAvatar({ name: undefined, chosen: "iris", from: [path.join(root, "image")] }, memoryDir, memory, quiet);
    assert.equal(dir, path.join(memoryDir, "avatar"));
    assert.equal(readFileSync(path.join(memoryDir, "avatar/icons/neutral.webp")).equals(WEBP), true);
    assert.equal(git(memoryDir, "log", "--format=%s", "--name-only").trim(), "Avatar iris\n\navatar/avatar.json\navatar/icons/neutral.webp");
  });

  it("leaves /memory/avatar as it is when it is there", async (t) => {
    const root = tempDir(t);
    const memoryDir = path.join(root, "memory");
    avatarIn(memoryDir, "avatar", "Grown");
    avatarIn(path.join(root, "image"), "iris", "Iris");
    await seedAvatar({ name: undefined, chosen: "iris", from: [path.join(root, "image")] }, memoryDir, new Memory(memoryDir, author), quiet);
    assert.match(readFileSync(path.join(memoryDir, "avatar/avatar.json"), "utf8"), /Grown/);
  });

  it("takes the avatar from the deployment's place before the image's", async (t) => {
    const root = tempDir(t);
    const memoryDir = path.join(root, "memory");
    mkdirSync(memoryDir);
    avatarIn(path.join(root, "deployment"), "iris", "Iris of the deployment");
    avatarIn(path.join(root, "image"), "iris", "Iris of the image");
    const from = [path.join(root, "deployment"), path.join(root, "image")];
    await seedAvatar({ name: undefined, chosen: "iris", from }, memoryDir, new Memory(memoryDir, author), quiet);
    assert.match(readFileSync(path.join(memoryDir, "avatar/avatar.json"), "utf8"), /of the deployment/);
  });

  // Guards against her being unable to overwrite the copied avatar from the sandbox, which shares only /memory's group
  // with the backend: the copy must not keep the backend's own group, whatever the source's owner or /memory's set-group-ID.
  it("gives the copy /memory's group, writable by the group, its directories set-group-ID", async (t) => {
    const shared = (process.getgroups?.() ?? []).find((gid) => gid !== userInfo().gid);
    if (shared === undefined) return t.skip("no supplementary group to stand for the Pod's shared group");
    const root = tempDir(t);
    const memoryDir = path.join(root, "memory");
    mkdirSync(memoryDir);
    chownSync(memoryDir, -1, shared);
    avatarIn(path.join(root, "image"), "iris", "Iris");
    chmodSync(path.join(root, "image/iris/avatar.json"), 0o644);
    chmodSync(path.join(root, "image/iris/icons"), 0o755);
    await seedAvatar({ name: undefined, chosen: "iris", from: [path.join(root, "image")] }, memoryDir, new Memory(memoryDir, author), quiet);
    const modes = ["avatar", "avatar/icons", "avatar/avatar.json", "avatar/icons/neutral.webp"].map((file) => {
      const stat = statSync(path.join(memoryDir, file));
      return [file, stat.gid, (stat.mode & 0o7777).toString(8)];
    });
    assert.deepEqual(modes, [
      ["avatar", shared, "2775"],
      ["avatar/icons", shared, "2775"],
      ["avatar/avatar.json", shared, "664"],
      ["avatar/icons/neutral.webp", shared, "664"],
    ]);
  });

  // A Kubernetes volume's files are links into a hidden ..data directory.
  it("copies the files a volume links to, without the volume's hidden directories", async (t) => {
    const root = tempDir(t);
    const memoryDir = path.join(root, "memory");
    mkdirSync(memoryDir);
    const volume = path.join(root, "volume");
    avatarIn(path.join(volume, "..2026_11_17"), "iris", "Iris");
    symlinkSync("..2026_11_17", path.join(volume, "..data"));
    mkdirSync(path.join(volume, "iris"));
    symlinkSync("../..data/iris/avatar.json", path.join(volume, "iris/avatar.json"));
    symlinkSync("../..data/iris/icons", path.join(volume, "iris/icons"));
    await seedAvatar({ name: undefined, chosen: "iris", from: [volume] }, memoryDir, new Memory(memoryDir, author), quiet);
    assert.equal(lstatSync(path.join(memoryDir, "avatar/avatar.json")).isFile(), true);
    assert.equal(lstatSync(path.join(memoryDir, "avatar/icons/neutral.webp")).isFile(), true);
  });

  it("copies nothing when the deployment chose no avatar", async (t) => {
    const memoryDir = tempDir(t);
    assert.equal(await seedAvatar({ name: undefined, chosen: undefined, from: [] }, memoryDir, new Memory(memoryDir, author), quiet), undefined);
    assert.equal(existsSync(path.join(memoryDir, "avatar")), false);
  });

  // Guards against a deployment whose backend cannot write /memory losing its faces, or not starting.
  it("shows the chosen avatar from where it is when it cannot be copied", async (t) => {
    const root = tempDir(t);
    avatarIn(path.join(root, "image"), "iris", "Iris");
    const memoryDir = path.join(root, "memory");
    writeFileSync(memoryDir, "a file where a directory should be");
    const dir = await seedAvatar({ name: undefined, chosen: "iris", from: [path.join(root, "image")] }, memoryDir, new Memory(memoryDir, author), quiet);
    assert.equal(dir, path.join(root, "image/iris"));
  });

  it("stops the start when no place has the chosen avatar", async (t) => {
    const memoryDir = tempDir(t);
    await assert.rejects(seedAvatar({ name: undefined, chosen: "iris", from: [path.join(memoryDir, "none")] }, memoryDir, new Memory(memoryDir, author), quiet), ConfigError);
  });
});

describe("the avatar in /memory", () => {
  it("names her from the settings before her avatar", (t) => {
    const memoryDir = tempDir(t);
    avatarIn(memoryDir, "avatar", "Iris");
    const dir = path.join(memoryDir, "avatar");
    assert.equal(new AgentAvatar(dir, "Kestrel", quiet).settings().name, "Kestrel");
    assert.equal(new AgentAvatar(dir, undefined, quiet).settings().name, "Iris");
  });

  it("gives a name and no faces when avatar.json is broken", (t) => {
    const memoryDir = tempDir(t);
    mkdirSync(path.join(memoryDir, "avatar"));
    writeFileSync(path.join(memoryDir, "avatar/avatar.json"), "{");
    const lines: string[] = [];
    const settings = new AgentAvatar(path.join(memoryDir, "avatar"), undefined, (line) => lines.push(line)).settings();
    assert.equal(settings.name, "Agent");
    assert.deepEqual(settings.icons, {});
    assert.match(lines[0]!, /avatar check/);
  });
});
