// Checks which of Renovate's changes plan-release.sh releases, on a throwaway
// git repository.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "plan-release.sh");

// The git of the tests reads no configuration of the machine it runs on.
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "renovate[bot]",
  GIT_AUTHOR_EMAIL: "bot@example.com",
  GIT_COMMITTER_NAME: "renovate[bot]",
  GIT_COMMITTER_EMAIL: "bot@example.com",
};
delete env.GITHUB_OUTPUT;
delete env.RELEASE_IGNORE;

// A repository tagged v0.1.0, with one commit by Renovate on top that
// changes the given paths.
function repositoryChanging(paths) {
  const dir = mkdtempSync(join(tmpdir(), "plan-release-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, env });
  git("init", "--quiet");
  writeFileSync(join(dir, "README.md"), "x\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "first");
  git("tag", "v0.1.0");
  for (const path of paths) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), "changed\n");
  }
  git("add", ".");
  git("commit", "--quiet", "-m", "Update dependencies");
  return dir;
}

function plan(dir) {
  return execFileSync("bash", [script, dir], { env, encoding: "utf8" });
}

// The example's image versions follow every release, so releasing for them
// would release every week.
test("Renovate's change to deploy/ alone is not released", (t) => {
  const dir = repositoryChanging(["deploy/kubernetes/example/kustomization.yaml"]);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.match(plan(dir), /^no release: /);
});

test("Renovate's change to deploy/ and to the code is released", (t) => {
  const dir = repositoryChanging(["deploy/kubernetes/example/kustomization.yaml", "packages/backend/package.json"]);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.match(plan(dir), /^release v0\.1\.1: /);
});
