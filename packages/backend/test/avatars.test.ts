// The avatars the backend's image carries (assets/avatars/, the default
// PENELOPE_AVATARS_DIR): each one loads as the backend reads it, with a face
// for every expression in the Web UI's WebP and in Slack's PNG.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";

const DIR = path.resolve(import.meta.dirname, "../../../assets/avatars");
/** The faces every avatar has (ADR-0016). */
const FACES = ["angry", "happy", "laughing", "neutral", "sad", "sleepy", "surprised", "thinking", "worried"];
const WEBP = (body: Buffer) => body.subarray(0, 4).toString("latin1") === "RIFF" && body.subarray(8, 12).toString("latin1") === "WEBP";
const PNG = (body: Buffer) => body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

const avatars = readdirSync(DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

describe("the avatars in the image", () => {
  it("are the ones moved from natsumi", () => {
    assert.deepEqual(avatars, ["aki", "myao", "natsumi", "penelope"]);
  });

  for (const id of avatars) {
    it(`${id} has a name and every face, in WebP and in PNG`, () => {
      const { agent } = loadConfig({ PENELOPE_AVATARS_DIR: DIR, PENELOPE_AVATAR: id }, (file) => readFileSync(file, "utf8"));
      assert.notEqual(agent.name, "Agent");
      assert.deepEqual(Object.keys(agent.icons).sort(), FACES);
      assert.deepEqual(Object.keys(agent.pngIcons ?? {}).sort(), FACES);
      for (const face of FACES) {
        assert.ok(WEBP(readFileSync(agent.icons[face]!)), `${id}'s ${face} is a WebP`);
        assert.ok(PNG(readFileSync(agent.pngIcons![face]!)), `${id}'s ${face} is a PNG`);
      }
    });
  }
});
