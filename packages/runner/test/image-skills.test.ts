import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

test("every skill the image carries is read by Pi without a complaint", async () => {
  // Guards against: a skill in packages/runner/image/skills that Pi leaves out of every deployment for its front matter.
  const dir = fileURLToPath(new URL("../image/skills", import.meta.url));
  const { skills, diagnostics } = loadSkillsFromDir({ dir, source: "image" });
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(skills.map((s) => s.name).sort(), (await readdir(dir)).sort());
});
