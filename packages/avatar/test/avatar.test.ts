import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { run } from "../src/cli.ts";
import { readAvatar } from "../src/index.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);

/** A fresh place with an avatar in `avatar/`: avatar.json from `list`, and the given files. */
function avatarWith(t: { after: (fn: () => void) => void }, list: unknown, files: Record<string, Buffer | string> = {}): string {
  const top = mkdtempSync(path.join(tmpdir(), "pa-"));
  t.after(() => rmSync(top, { recursive: true, force: true }));
  const dir = path.join(top, "avatar");
  mkdirSync(dir);
  writeFileSync(path.join(dir, "avatar.json"), typeof list === "string" ? list : JSON.stringify(list));
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), body);
  }
  return dir;
}

describe("reading an avatar", () => {
  it("takes the name and each face that is an image of its extension's type inside the avatar", (t) => {
    const dir = avatarWith(t, { name: " Iris ", icons: { neutral: "icons/neutral.webp" }, pngIcons: { neutral: "slack/neutral.png" }, model: "later.glb" }, {
      "icons/neutral.webp": WEBP,
      "slack/neutral.png": PNG,
    });
    assert.deepEqual(readAvatar(dir), {
      avatar: { name: "Iris", icons: { neutral: "icons/neutral.webp" }, pngIcons: { neutral: "slack/neutral.png" } },
      problems: [],
    });
  });

  // Guards against the backend serving, without a login, a file of its own that a face points at.
  it("leaves out a face outside the avatar, by its path or by a link, and says why", (t) => {
    const dir = avatarWith(t, { icons: { neutral: "../secret.webp", happy: "icons/happy.webp" } });
    writeFileSync(path.join(dir, "../secret.webp"), WEBP);
    mkdirSync(path.join(dir, "icons"));
    symlinkSync(path.join(dir, "../secret.webp"), path.join(dir, "icons/happy.webp"));
    const { avatar, problems } = readAvatar(dir);
    assert.deepEqual(avatar.icons, {});
    assert.equal(problems.length, 2);
    assert.match(problems[0]!, /^icons\.neutral: .*outside the avatar's directory/);
    assert.match(problems[1]!, /^icons\.happy: .*a link to outside the avatar's directory/);
  });

  it("reads nothing when the avatar's directory is a link", (t) => {
    const dir = avatarWith(t, { icons: { neutral: "neutral.webp" } }, { "neutral.webp": WEBP });
    const link = path.join(path.dirname(dir), "linked");
    symlinkSync(dir, link);
    const { avatar, problems } = readAvatar(link);
    assert.deepEqual(avatar.icons, {});
    assert.match(problems[0]!, /must be a directory, not a link/);
  });

  it("leaves out a face whose file is not what its extension says, or a PNG face that is not a PNG", (t) => {
    const dir = avatarWith(t, { icons: { neutral: "neutral.webp", happy: "happy.txt" }, pngIcons: { neutral: "neutral-slack.webp" } }, {
      "neutral.webp": PNG,
      "happy.txt": "hi",
      "neutral-slack.webp": WEBP,
    });
    const { avatar, problems } = readAvatar(dir);
    assert.deepEqual(avatar, { name: undefined, icons: {}, pngIcons: {} });
    assert.deepEqual(
      problems.map((problem) => problem.split(":")[0]),
      ["icons.neutral", "icons.happy", "pngIcons.neutral"],
    );
  });

  it("says when avatar.json cannot be read as a list, and gives no faces", (t) => {
    const dir = avatarWith(t, "{");
    const { avatar, problems } = readAvatar(dir);
    assert.deepEqual(avatar, { name: undefined, icons: {}, pngIcons: {} });
    assert.match(problems[0]!, /^avatar\.json: not JSON/);
  });
});

describe("avatar check", () => {
  it("prints each problem and exits 1, or what the backend takes and exits 0", (t) => {
    const broken = avatarWith(t, { name: "Iris", icons: { neutral: "missing.webp" } });
    assert.deepEqual(run(["check", broken]), { code: 1, stdout: "icons.neutral: missing.webp: not there\n", stderr: "" });
    const good = avatarWith(t, { name: "Iris", icons: { neutral: "neutral.webp" } }, { "neutral.webp": WEBP });
    assert.deepEqual(run(["check", good]), { code: 0, stdout: `ok: ${good}\nname: Iris\nicons: neutral\npngIcons: none\n`, stderr: "" });
  });
});
