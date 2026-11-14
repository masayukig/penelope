import assert from "node:assert/strict";
import { test } from "node:test";

import { run } from "../src/main.ts";

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
  const result = run(["serve"], {});
  assert.equal(result.code, 2);
  assert.match(result.stderr, /^usage: /);
});
