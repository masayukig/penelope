// What the service worker does with a push and with a click on its
// notification (docs/ui-api.md, "知らせ").
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { notificationOf, openConversation, type WindowLike } from "../src/sw/notice.ts";

describe("the notification of a reply", () => {
  const agent = { name: "Iris", icons: { neutral: "/api/agent/icons/neutral", happy: "/api/agent/icons/happy" } };

  it("is titled with her name and says the head of the reply, with her face", () => {
    const { title, options } = notificationOf({ id: "r1", agent: "Iris", text: "終わりました", expression: "happy" }, agent, { focused: false });
    assert.equal(title, "Iris");
    assert.equal(options.body, "終わりました");
    assert.equal(options.icon, "/api/agent/icons/happy");
    assert.equal(options.tag, "r1");
    assert.equal(options.silent, false);
  });

  it("shows the neutral face for one the avatar has not, and the built icon without an avatar", () => {
    assert.equal(notificationOf({ id: "r1", agent: "Iris", text: "x", expression: "odd" }, agent, { focused: false }).options.icon, "/api/agent/icons/neutral");
    assert.equal(notificationOf({ id: "r1", agent: "Iris", text: "x" }, { name: "Iris" }, { focused: false }).options.icon, "/icon.svg");
  });

  it("says how many images came with it", () => {
    assert.equal(notificationOf({ id: "r1", agent: "Iris", text: "見て", images: 2 }, agent, { focused: false }).options.body, "見て\n（画像 2 枚）");
    assert.equal(notificationOf({ id: "r1", agent: "Iris", text: "", images: 1 }, agent, { focused: false }).options.body, "（画像 1 枚）");
  });

  it("is shown without a sound while the conversation is in front of the owner", () => {
    assert.equal(notificationOf({ id: "r1", agent: "Iris", text: "x" }, agent, { focused: true }).options.silent, true);
  });
});

describe("a click on the notification", () => {
  const window = (focused = false) => {
    const calls: string[] = [];
    const client: WindowLike = {
      url: "https://penelope.example.com/",
      focused,
      focus: async () => {
        calls.push("focus");
        return client;
      },
    };
    return { client, calls };
  };

  it("brings the open conversation to the front", async () => {
    const first = window();
    const opened: string[] = [];
    await openConversation([first.client], async (url) => {
      opened.push(url);
      return null;
    });
    assert.deepEqual(first.calls, ["focus"]);
    assert.deepEqual(opened, []);
  });

  it("opens the conversation when none is open", async () => {
    const opened: string[] = [];
    await openConversation([], async (url) => {
      opened.push(url);
      return null;
    });
    assert.deepEqual(opened, ["/"]);
  });
});
