import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { describe, it } from "node:test";

import { close, listenTcp } from "../src/http.ts";
import { webHandler } from "../src/web.ts";
import { ask, tempDir } from "./support.ts";

async function setup(t: { after: (fn: () => void | Promise<void>) => void }, { built = true, icons = {} as Record<string, string> } = {}) {
  const root = tempDir(t);
  const dir = path.join(root, "web");
  mkdirSync(dir);
  writeFileSync(path.join(root, "outside.txt"), "outside");
  if (built) {
    mkdirSync(path.join(dir, "assets"));
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>ui</title>");
    writeFileSync(path.join(dir, "assets", "app.js"), "console.log(1)");
    writeFileSync(path.join(dir, "assets", "app.css"), "body{}");
    writeFileSync(path.join(dir, "icon.svg"), "<svg/>");
  }
  const server = await listenTcp(webHandler({ dir, agent: { name: "Iris", icons } }), "127.0.0.1", 0);
  t.after(() => close(server));
  return { target: { port: (server.address() as AddressInfo).port } };
}

describe("the Web UI's files", () => {
  // The backend is what serves the built UI (docs/ui-api.md).
  it("serves the page at the top and its files under their paths", async (t) => {
    const { target } = await setup(t);
    const page = await ask(target, "/");
    assert.equal(page.status, 200);
    assert.match(String(page.headers["content-type"]), /^text\/html/);
    assert.match(page.text, /<title>ui<\/title>/);
    const script = await ask(target, "/assets/app.js");
    assert.match(String(script.headers["content-type"]), /^text\/javascript/);
    assert.equal(script.text, "console.log(1)");
    assert.match(String((await ask(target, "/assets/app.css")).headers["content-type"]), /^text\/css/);
  });

  // Guards against: a new build whose page a browser keeps showing from its cache, with the old files' names in it.
  it("lets the files under assets/ be cached long, and has everything else looked at again", async (t) => {
    const { target } = await setup(t);
    const cacheOf = async (pathname: string) => String((await ask(target, pathname)).headers["cache-control"] ?? "");
    const longLived = await cacheOf("/assets/app.js");
    assert.match(longLived, /max-age=(\d+)/);
    assert.ok(Number(/max-age=(\d+)/.exec(longLived)![1]) >= 24 * 60 * 60, longLived);
    for (const pathname of ["/", "/icon.svg", "/manifest.webmanifest"]) {
      assert.match(await cacheOf(pathname), /no-cache|max-age=0/, pathname);
    }
  });

  it("answers 404 for a file it does not have", async (t) => {
    const { target } = await setup(t);
    assert.equal((await ask(target, "/assets/missing.js")).status, 404);
  });

  // A path must not reach a file outside the directory of the build.
  it("serves nothing from outside its directory", async (t) => {
    const { target } = await setup(t);
    for (const pathname of ["/../outside.txt", "/%2e%2e/outside.txt", "/assets/..%2f..%2foutside.txt"]) {
      const answer = await ask(target, pathname);
      assert.notEqual(answer.status, 200, pathname);
      assert.notEqual(answer.text, "outside", pathname);
    }
  });

  it("answers 404 until the UI is built", async (t) => {
    const { target } = await setup(t, { built: false });
    assert.equal((await ask(target, "/")).status, 404);
  });

  // The home screen shows her name, which only the settings know (ADR-0001).
  it("gives a manifest with the name from the settings, to be put on the home screen", async (t) => {
    const { target } = await setup(t);
    const answer = await ask(target, "/manifest.webmanifest");
    assert.equal(answer.status, 200);
    assert.match(String(answer.headers["content-type"]), /^application\/manifest\+json/);
    const manifest = answer.json();
    assert.equal(manifest.name, "Iris");
    assert.deepEqual(manifest.icons.map((icon: { src: string }) => icon.src), ["/icon.svg"]);
  });

  it("puts the avatar's neutral face in the manifest when there is one", async (t) => {
    const { target } = await setup(t, { icons: { neutral: "/avatars/iris/icons/neutral.webp", happy: "/avatars/iris/icons/happy.webp" } });
    const manifest = (await ask(target, "/manifest.webmanifest")).json();
    assert.deepEqual(
      manifest.icons.map((icon: { src: string; type: string }) => [icon.src, icon.type]),
      [["/api/agent/icons/neutral", "image/webp"]],
    );
  });
});
