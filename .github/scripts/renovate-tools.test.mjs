import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);
const config = JSON.parse(readFileSync(new URL("renovate.json", root), "utf8"));
const dockerfile = readFileSync(new URL("Dockerfile", root), "utf8");
// Release tag -> value expected by fetch-tools.sh. Keep v for tools whose
// asset names contain it, but strip it for gh/a2a. Kustomize is a monorepo.
const tools = [
  ["KUBECTL", "kubernetes/kubernetes", "v1.36.6", "v1.36.6"],
  ["HELM", "helm/helm", "v4.3.1", "v4.3.1"],
  ["KUSTOMIZE", "kubernetes-sigs/kustomize", "kustomize/v5.8.3", "v5.8.3"],
  ["SOPS", "getsops/sops", "v3.13.3", "v3.13.3"],
  ["GH", "cli/cli", "v2.103.3", "2.103.3"],
  ["VMCTL", "yuanying/vmapi", "v0.2.0", "v0.2.0"],
  ["A2A", "a2aproject/a2a-cli", "v0.2.0", "0.2.0"],
];

for (const [name, depName, tag, value] of tools) {
  test(`${name}: extraction and release tag round trip`, () => {
    const managers = config.customManagers.filter((m) => m.depNameTemplate === depName);
    assert.equal(managers.length, 1);
    const manager = managers[0];
    assert.equal(manager.datasourceTemplate, "github-releases");
    assert.deepEqual(manager.managerFilePatterns, ["/^Dockerfile$/"]);
    const pattern = manager.matchStrings[0];
    const matches = [...dockerfile.matchAll(new RegExp(pattern, "g"))];
    assert.equal(matches.length, 1);
    // Read the current value rather than pinning it in the test: Renovate
    // should be able to update Dockerfile without updating these fixtures.
    const current = dockerfile.match(new RegExp(`ARG ${name}_VERSION=(\\S+)`))[1];
    assert.equal(matches[0].groups.currentValue, current);
    const releasePattern = new RegExp(manager.extractVersionTemplate);
    assert.equal(releasePattern.exec(tag)?.groups.version, value);
    assert.equal(releasePattern.exec("unrelated/v9.9.9"), null);
    assert.equal(releasePattern.exec(`${tag}-rc.1`), null);

    const nextTag = tag.replace(/\d+\.\d+\.\d+$/, "99.88.77");
    const nextValue = releasePattern.exec(nextTag).groups.version;
    assert.equal(nextValue, value.startsWith("v") ? "v99.88.77" : "99.88.77");
    const updated = dockerfile.replace(`ARG ${name}_VERSION=${current}`, `ARG ${name}_VERSION=${nextValue}`);
    assert.equal(new RegExp(pattern).exec(updated).groups.currentValue, nextValue);
    for (const input of [`ARG ${name}_VERSION=${value}`, `ARG ${name}_VERSION=${value}\r\n`, `\nARG ${name}_VERSION=${value} \n`]) {
      assert.equal(new RegExp(pattern).exec(input)?.groups.currentValue, value);
    }
    for (const input of [`# ARG ${name}_VERSION=${value}\n`, `ARG ${name}_VERSION=$OTHER\n`, `ARG ${name}_VERSION=${value}-rc.1\n`, `ARG ${name}_VERSION=${value}.4\n`]) {
      assert.equal(new RegExp(pattern).exec(input), null);
    }
  });
}

test("every pinned Dockerfile tool ARG has a custom manager", () => {
  const args = [...dockerfile.matchAll(/^ARG (\w+_VERSION)=(v?\d+\.\d+\.\d+)$/gm)];
  assert.equal(args.length, tools.length + 1); // porkadot is built from tags
  for (const [, name, value] of args) {
    const matching = config.customManagers.filter((m) => m.matchStrings.some((pattern) => {
      const match = new RegExp(pattern).exec(`ARG ${name}=${value}\n`);
      return match?.groups.currentValue === value;
    }));
    assert.equal(matching.length, 1, name);
  }
});

test("kustomize ignores other modules' releases", () => {
  const manager = config.customManagers.find((m) => m.depNameTemplate === "kubernetes-sigs/kustomize");
  for (const tag of ["kyaml/v0.21.3", "cmd/config/v0.21.3", "api/v0.21.3", "v5.8.3"]) {
    assert.equal(new RegExp(manager.extractVersionTemplate).exec(tag), null);
  }
});
