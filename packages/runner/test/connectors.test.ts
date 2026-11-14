import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readConnectors } from "../src/connectors.ts";

async function dir(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "connectors-"));
  for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content);
  return root;
}

const doc = (name: string, description: string, hosts: string[]) =>
  `---\nname: ${name}\ndescription: ${description}\nhosts:\n${hosts.map((h) => `  - ${h}`).join("\n")}\n---\n\n# ${name}\n\nUse GH_TOKEN.\n`;

test("each <name>.md with its front matter is listed, in the order of the names", async () => {
  const root = await dir({
    "vmapi.md": doc("vmapi", "The VM API.", ["vm.example.com"]),
    "github.md": doc("github", "GitHub through gh.", ["api.github.com", "github.com"]),
  });
  const { connectors, skipped } = await readConnectors(root);
  assert.deepEqual(connectors, [
    { name: "github", description: "GitHub through gh.", hosts: ["api.github.com", "github.com"], path: join(root, "github.md") },
    { name: "vmapi", description: "The VM API.", hosts: ["vm.example.com"], path: join(root, "vmapi.md") },
  ]);
  assert.deepEqual(skipped, []);
});

test("a directory that is not there has no connectors", async () => {
  // Guards against: a session that cannot start before the deployment puts the documents in place.
  const { connectors, skipped } = await readConnectors(join(tmpdir(), "no-such-connectors-dir"));
  assert.deepEqual(connectors, []);
  assert.deepEqual(skipped, []);
});

test("a file whose front matter is missing or incomplete is left out, and said why", async () => {
  const root = await dir({
    "plain.md": "# plain\n\nno front matter\n",
    "nodesc.md": "---\nname: nodesc\nhosts: [a.example.com]\n---\n",
    "nohosts.md": "---\nname: nohosts\ndescription: d\n---\n",
    "emptyhosts.md": "---\nname: emptyhosts\ndescription: d\nhosts: []\n---\n",
    "badhost.md": "---\nname: badhost\ndescription: d\nhosts: [1]\n---\n",
    "other.md": doc("another", "Its name is not its file's.", ["a.example.com"]),
    "broken.md": "---\nname: [broken\n---\n",
    "ok.md": doc("ok", "Fine.", ["ok.example.com"]),
  });
  const { connectors, skipped } = await readConnectors(root);
  // Guards against: one broken document hiding the others, or a connector listed without what she needs to use it.
  assert.deepEqual(
    connectors.map((c) => c.name),
    ["ok"],
  );
  assert.deepEqual(skipped.map((s) => s.path).sort(), ["badhost.md", "broken.md", "emptyhosts.md", "nodesc.md", "nohosts.md", "other.md", "plain.md"].map((f) => join(root, f)));
  for (const s of skipped) assert.ok(s.reason.length > 0, s.path);
});

test("only the .md files directly in the directory are read; hidden ones and others are passed over", async () => {
  const root = await dir({ "notes.txt": "x", ".hidden.md": doc("hidden", "h", ["h.example.com"]) });
  await mkdir(join(root, "sub.md"));
  const { connectors, skipped } = await readConnectors(root);
  assert.deepEqual(connectors, []);
  assert.deepEqual(skipped, []);
});

test("a document mounted as a link, the way a ConfigMap is, is read", async () => {
  // Guards against: a runner that lists nothing from a ConfigMap, whose files are links into ..data/.
  const root = await dir({});
  await mkdir(join(root, "..data"));
  await writeFile(join(root, "..data", "github.md"), doc("github", "GitHub.", ["api.github.com"]));
  await symlink(join("..data", "github.md"), join(root, "github.md"));
  const { connectors, skipped } = await readConnectors(root);
  assert.deepEqual(
    connectors.map((c) => c.name),
    ["github"],
  );
  assert.deepEqual(skipped, []);
});
