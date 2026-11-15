import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { run } from "../src/main.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "receivers-main-"));

after(() => rmSync(dir, { recursive: true, force: true }));

test("version prints the version from PENELOPE_VERSION", () => {
  assert.deepEqual(run(["version"], { PENELOPE_VERSION: "v1.2.3" }), {
    code: 0,
    stdout: "v1.2.3\n",
    stderr: "",
  });
});

test("version prints dev when no version was given", () => {
  assert.equal(run(["version"], {}).stdout, "dev\n");
});

test("anything else prints the usage and exits with 2", () => {
  const result = run(["start"], {});
  assert.equal(result.code, 2);
  assert.match(result.stderr, /^usage: receivers serve\|version\n$/);
});

test("serve does not start on settings it cannot use, and says why in one line", () => {
  const config = join(dir, "bad.json");
  writeFileSync(config, JSON.stringify({ plugins: [{ name: "fraction", plugin: "alertmanager", settings: { token_file: join(dir, "missing") } }] }));
  const result = spawnSync(process.execPath, [MAIN, "serve"], { env: { ...process.env, PENELOPE_RECEIVERS_CONFIG: config }, encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^receivers: plugins\[0\]\.settings\.token_file: [^\n]*\n$/);
});

test("serve answers /healthz and exits on SIGTERM", async () => {
  const config = join(dir, "good.json");
  writeFileSync(config, JSON.stringify({ listen: "127.0.0.1:0", intake: join(dir, "backend.sock") }));
  const child = spawn(process.execPath, [MAIN, "serve"], { env: { ...process.env, PENELOPE_RECEIVERS_CONFIG: config }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  const port = await new Promise<number>((resolve, reject) => {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (part: string) => {
      stderr += part;
      const found = /listening on 127\.0\.0\.1:(\d+)/.exec(stderr);
      if (found) resolve(Number(found[1]));
    });
    child.on("exit", () => reject(new Error(`exited: ${stderr}`)));
  });
  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.deepEqual([health.status, await health.text()], [200, "ok"]);
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  child.kill("SIGTERM");
  assert.equal(await exited, 0);
});
