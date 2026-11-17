// The avatars the backend's image carries (assets/avatars/), which it copies
// into /memory/avatar/: each one reads with no problems, with a face for
// every expression in the Web UI's WebP and in Slack's PNG, and her figure.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { readAvatar } from "@penelope/avatar";

const DIR = path.resolve(import.meta.dirname, "../../../assets/avatars");
/** The faces every avatar has (ADR-0016). */
const FACES = ["angry", "happy", "laughing", "neutral", "sad", "sleepy", "surprised", "thinking", "worried"];

const avatars = readdirSync(DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

describe("the avatars in the image", () => {
  it("are the ones moved from natsumi", () => {
    assert.deepEqual(avatars, ["aki", "myao", "natsumi", "penelope"]);
  });

  for (const id of avatars) {
    it(`${id} has a name, every face in WebP and in PNG, and her figure`, () => {
      const { avatar, problems } = readAvatar(path.join(DIR, id));
      assert.deepEqual(problems, []);
      assert.ok(avatar.name);
      assert.deepEqual(Object.keys(avatar.icons).sort(), FACES);
      assert.ok(Object.values(avatar.icons).every((file) => file.endsWith(".webp")));
      assert.deepEqual(Object.keys(avatar.pngIcons).sort(), FACES);
      for (const file of ["appearance.yaml", "sdctl-params.yaml"]) assert.ok(existsSync(path.join(DIR, id, file)), `${id}/${file}`);
    });
  }
});
