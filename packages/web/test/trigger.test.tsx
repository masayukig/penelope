// What made her speak, beside the name of a reply (docs/design/README.md,
// 13): one line, its kind whole and in bold, its words cut at the end of the
// line by CSS alone, and nothing to open.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";

import type { HistoryEntry } from "@penelope/contract";

import { App } from "../src/ui/App.tsx";
import { triggerWords } from "../src/ui/words.ts";
import { FakeBackend } from "./fake-backend.ts";

const sleep = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

const ALERT = "[FIRING warning] KubeJobFailed: Job failed to complete.";
const REVIEW = "2件の独立レビューを完了し、証跡と投稿案を保存しました。**いずれも承認相当、今回の差分に起因する blocker は見つかりません。**";

const reply = (id: string, source: string, summary: string): HistoryEntry => ({
  kind: "agent",
  id,
  at: new Date().toISOString(),
  text: `reply ${id}`,
  agent: "main",
  trigger: { source, summary },
});

let style: HTMLStyleElement | undefined;

async function start(history: HistoryEntry[], name = "Iris") {
  style = document.createElement("style");
  style.textContent = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/^@import .*$/gm, "");
  document.head.append(style);
  const backend = new FakeBackend();
  backend.agent = { name };
  backend.history = history;
  render(<App fetch={backend.fetch} sleep={sleep} />);
  await backend.connected();
  const timeline = screen.getByRole("log");
  await waitFor(() => within(timeline).getByText(`reply ${history.at(-1)!.id}`));
  return timeline;
}

const css = (el: Element) => getComputedStyle(el);
const cut = (el: Element) => {
  assert.equal(css(el).whiteSpace, "nowrap", el.className);
  assert.equal(css(el).overflow, "hidden", el.className);
  assert.equal(css(el).textOverflow, "ellipsis", el.className);
  assert.equal(parseFloat(css(el).minWidth), 0, el.className);
};

afterEach(() => {
  cleanup();
  style?.remove();
});

describe("the words of what made her speak", () => {
  it("drop the marks of Markdown and put the lines on one", () => {
    assert.equal(triggerWords(REVIEW), "2件の独立レビューを完了し、証跡と投稿案を保存しました。いずれも承認相当、今回の差分に起因する blocker は見つかりません。");
    assert.equal(triggerWords("__strong__ *em* _em_ ~~gone~~ `code` [a link](https://example.com)"), "strong em em gone code a link");
    assert.equal(triggerWords("# 見出し\n- 一つ目\r\n- 二つ目\n\n> 引用"), "見出し 一つ目 二つ目 引用");
    assert.equal(triggerWords("  毎朝 9:00  "), "毎朝 9:00");
  });

  it("keep what is not a mark", () => {
    assert.equal(triggerWords(ALERT), ALERT);
    assert.equal(triggerWords("snake_case_name と 2 * 3"), "snake_case_name と 2 * 3");
  });
});

describe("the mark of what made her speak", () => {
  it("shows its kind in bold and its words whole in the page, with nothing to open", async () => {
    const timeline = await start([reply("r-1", "alertmanager", ALERT), reply("r-2", "self", REVIEW)]);
    const marks = [...timeline.querySelectorAll(".reply-trigger")];
    assert.equal(marks.length, 2);
    const [alert, review] = marks as [HTMLElement, HTMLElement];
    assert.equal(alert.querySelector(".reply-trigger-kind")!.textContent, "alertmanager");
    assert.equal(alert.querySelector(".reply-trigger-words")!.textContent, `・ ${ALERT}`);
    assert.equal(review.querySelector(".reply-trigger-kind")!.textContent, "自分から");
    assert.equal(review.querySelector(".reply-trigger-words")!.textContent, `・ ${triggerWords(REVIEW)}`);
    for (const mark of marks) {
      assert.equal(mark.querySelector("[title]"), null);
      assert.equal(mark.getAttribute("title"), null);
      assert.equal(mark.querySelector("button, a, [tabindex]"), null);
      assert.equal(mark.closest("button, a"), null);
      assert.equal(css(mark.querySelector(".reply-trigger-kind")!).fontWeight, "600");
    }
  });

  it("stays on one line and cuts only its words", async () => {
    const timeline = await start([reply("r-1", "alertmanager", ALERT)]);
    const mark = timeline.querySelector(".reply-trigger")!;
    cut(mark.querySelector(".reply-trigger-words")!);
    assert.equal(css(mark.querySelector(".reply-trigger-kind")!).flexShrink, "0");
    assert.equal(css(mark.querySelector(".reply-trigger-kind")!).flexGrow, "0");
    assert.equal(parseFloat(css(mark).minWidth), 0);
    assert.equal(css(mark).maxWidth, "78%");
    assert.equal(css(mark).display, "flex");
    assert.equal(css(mark).fontSize, "12px");
  });

  it("is a line of its own in the flow, in the middle, before the reply and outside it", async () => {
    const timeline = await start([reply("r-1", "alertmanager", ALERT)]);
    const line = timeline.querySelector(".timeline-event")!;
    assert.equal(css(line).display, "flex");
    assert.equal(css(line).justifyContent, "center");
    assert.equal(parseFloat(css(line).minWidth), 0);
    assert.equal(line.children.length, 1);
    assert.equal(line.closest(".astryx-chat-message"), null);
    const bubble = timeline.querySelector(".reply-bubble")!;
    assert.ok(line.compareDocumentPosition(bubble) & 4, "the line comes before the reply");
    assert.equal(timeline.querySelector(".reply-name"), null);
  });

  it("does not stretch a short one to the end of the line", async () => {
    const timeline = await start([reply("r-1", "cron", "毎朝 9:00")]);
    const mark = timeline.querySelector(".reply-trigger")!;
    assert.equal(mark.querySelector(".reply-trigger-kind")!.textContent, "予約");
    assert.equal(mark.querySelector(".reply-trigger-words")!.textContent, "・ 毎朝 9:00");
    assert.notEqual(css(mark).flexGrow, "1");
    assert.notEqual(css(mark).width, "100%");
  });
});
