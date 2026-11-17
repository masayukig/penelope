// Checks which bot changes plan-release.sh releases, on a throwaway git
// repository.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
delete env.GITHUB_STEP_SUMMARY;
delete env.RELEASE_IGNORE;

// A repository tagged v0.1.0, with one commit on top for each of the given
// authors, each changing the given paths.
function repositoryWith(...commits) {
  const dir = mkdtempSync(join(tmpdir(), "plan-release-"));
  const git = (author, ...args) =>
    execFileSync("git", args, { cwd: dir, env: { ...env, GIT_AUTHOR_NAME: author } });
  git("renovate[bot]", "init", "--quiet");
  writeFileSync(join(dir, "README.md"), "x\n");
  git("renovate[bot]", "add", ".");
  git("renovate[bot]", "commit", "--quiet", "-m", "first");
  git("renovate[bot]", "tag", "v0.1.0");
  for (const [i, { author, paths }] of commits.entries()) {
    for (const path of paths) {
      mkdirSync(join(dir, dirname(path)), { recursive: true });
      writeFileSync(join(dir, path), `changed ${i}\n`);
    }
    git(author, "add", ".");
    git(author, "commit", "--quiet", "-m", `Change ${i} by ${author}`);
  }
  return dir;
}

// A repository tagged v0.1.0, with one commit by Renovate on top that
// changes the given paths.
function repositoryChanging(paths) {
  return repositoryWith({ author: "renovate[bot]", paths });
}

function plan(dir, ...args) {
  return execFileSync("bash", [script, ...args, dir], { env, encoding: "utf8" });
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

// The vulnerability responder's fixes go out without a person, as Renovate's
// updates do.
test("fraction-vuln-responder's change to the code alone is released", (t) => {
  const dir = repositoryWith({ author: "fraction-vuln-responder[bot]", paths: ["Dockerfile"] });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.match(plan(dir), /^release v0\.1\.1: /);
});

// A person's change is never released as a bot's: it waits for a tag by hand.
test("a person's commit next to fraction-vuln-responder's holds the release back", (t) => {
  const dir = repositoryWith(
    { author: "fraction-vuln-responder[bot]", paths: ["Dockerfile"] },
    { author: "Someone", paths: ["packages/backend/package.json"] },
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.match(plan(dir), /^no release: commits since v0\.1\.0 by Someone /);
});

// When a merged fix is held back, the owner has to find in the run which
// commits held it and how to release by hand.
test("a held vulnerability fix lists the person's commits and the commands in the summary", (t) => {
  const dir = repositoryWith(
    { author: "fraction-vuln-responder[bot]", paths: ["Dockerfile"] },
    { author: "Someone", paths: ["packages/backend/package.json"] },
  );
  const summary = join(dir, "summary.md");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("bash", [script, "--vuln-fix", dir], { env: { ...env, GITHUB_STEP_SUMMARY: summary }, encoding: "utf8" });
  const text = readFileSync(summary, "utf8");
  assert.match(text, /Change 1 by Someone/);
  assert.doesNotMatch(text, /Change 0 by fraction-vuln-responder/);
  assert.match(text, /git tag -a v0\.1\.1 /);
});

// A run started again after a newer release would plan the version that
// release already took, and push its images over that version's.
test("the next version is not released when its tag already exists elsewhere", (t) => {
  const dir = repositoryChanging(["packages/backend/package.json"]);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: dir, env });
  git("checkout", "--quiet", "-b", "newer");
  writeFileSync(join(dir, "newer.txt"), "x\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "Newer change");
  git("tag", "v0.1.1");
  git("checkout", "--quiet", "-");
  assert.match(plan(dir), /^no release: v0\.1\.1 is already tagged/);
});

// Not reaching origin says nothing about whether the version is tagged
// there, so the plan fails rather than releasing a version that may be taken.
test("the plan fails without releasing when origin cannot be reached", (t) => {
  const dir = repositoryChanging(["packages/backend/package.json"]);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["remote", "add", "origin", join(dir, "missing")], { cwd: dir, env });
  const output = join(dir, "output");
  assert.throws(() =>
    execFileSync("bash", [script, dir], { env: { ...env, GITHUB_OUTPUT: output }, stdio: "pipe" }),
  );
  assert.doesNotMatch(readFileSync(output, { encoding: "utf8", flag: "a+" }), /^version=v/m);
});
