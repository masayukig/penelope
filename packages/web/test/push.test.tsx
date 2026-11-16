// The notices of the replies in the Web UI (ADR-0027): the owner turns them
// on and off from the place of the logout, and the browser's subscription
// is kept registered with the backend.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { App } from "../src/ui/App.tsx";
import { words } from "../src/ui/words.ts";
import { FakeBackend } from "./fake-backend.ts";
import { FakePush } from "./fake-push.ts";

const sleep = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
const KEY = Buffer.alloc(65, 4).toString("base64url");
const OTHER_KEY = Buffer.alloc(65, 5).toString("base64url");

function start({ backend = new FakeBackend(), push = new FakePush() } = {}) {
  render(<App fetch={backend.fetch} sleep={sleep} push={push} />);
  return { backend, push };
}

const button = (name: string) => screen.findByRole("button", { name });

/** Found first, then pressed: a find inside act() would hold back the render it waits for. */
async function press(name: string) {
  const found = await button(name);
  await act(async () => fireEvent.click(found));
}

afterEach(() => cleanup());

describe("the notices in the Web UI", () => {
  it("asks for the permission, subscribes with the deployment's key and registers it", async () => {
    const backend = new FakeBackend();
    backend.pushKey = KEY;
    const { push } = start({ backend });
    await backend.connected();
    await press(words.push.off);
    await button(words.push.on);
    assert.equal(push.granted, "granted");
    assert.deepEqual(push.subscribedWith, [KEY]);
    assert.deepEqual([...backend.subscriptions.values()], [
      { kind: "web-push", endpoint: "https://push.example.com/send/1", keys: { p256dh: "BrowserP256dh", auth: "BrowserAuth" } },
    ]);
  });

  it("stops them in the browser and at the backend", async () => {
    const backend = new FakeBackend();
    backend.pushKey = KEY;
    const { push } = start({ backend });
    await backend.connected();
    await press(words.push.off);
    const subscription = push.subscription!;
    await press(words.push.on);
    await button(words.push.off);
    assert.equal(subscription.ended, true);
    assert.equal(backend.subscriptions.size, 0);
  });

  it("registers again the subscription the browser has, so that the backend has it", async () => {
    const backend = new FakeBackend();
    backend.pushKey = KEY;
    const push = new FakePush();
    push.had(KEY);
    start({ backend, push });
    await button(words.push.on);
    await waitFor(() => assert.deepEqual([...backend.subscriptions.keys()], ["https://push.example.com/send/old"]));
    assert.deepEqual(push.subscribedWith, []);
  });

  it("makes the subscription again when the deployment's key changed", async () => {
    // Guards against: a subscription made with the old key, which every push service refuses.
    const backend = new FakeBackend();
    backend.pushKey = KEY;
    const push = new FakePush();
    const old = push.had(OTHER_KEY);
    start({ backend, push });
    await button(words.push.on);
    assert.equal(old.ended, true);
    assert.deepEqual(push.subscribedWith, [KEY]);
    await waitFor(() => assert.deepEqual([...backend.subscriptions.keys()], ["https://push.example.com/send/1"]));
  });

  it("says when the deployment has no Web Push", async () => {
    const backend = new FakeBackend();
    start({ backend });
    const off = await button(words.push.unavailable);
    assert.ok(off.hasAttribute("disabled") || off.getAttribute("aria-disabled") === "true");
  });

  it("says when this browser cannot take them", async () => {
    const backend = new FakeBackend();
    backend.pushKey = KEY;
    const push = new FakePush();
    push.has = false;
    start({ backend, push });
    const off = await button(words.push.unsupported);
    assert.ok(off.hasAttribute("disabled") || off.getAttribute("aria-disabled") === "true");
  });

  it("says when the owner declined them in the browser", async () => {
    const backend = new FakeBackend();
    backend.pushKey = KEY;
    const push = new FakePush();
    push.answer = "denied";
    start({ backend, push });
    await backend.connected();
    await press(words.push.off);
    await button(words.push.denied);
    assert.equal(backend.subscriptions.size, 0);
  });
});

type HappyWindow = { happyDOM: { setViewport: (viewport: { width: number; height?: number }) => void } };

describe("the notices on a phone", () => {
  afterEach(() => (window as unknown as HappyWindow).happyDOM.setViewport({ width: 1024 }));

  it("are turned on from the menu", async () => {
    (window as unknown as HappyWindow).happyDOM.setViewport({ width: 390, height: 844 });
    const backend = new FakeBackend();
    backend.pushKey = KEY;
    start({ backend });
    await backend.connected();
    await press(words.menu);
    await press(words.push.off);
    await button(words.push.on);
    assert.equal(backend.subscriptions.size, 1);
  });
});
