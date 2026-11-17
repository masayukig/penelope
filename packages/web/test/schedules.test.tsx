// Her schedules in the Web UI (docs/ui-api.md, "予約"): listed in the place
// of the events and the schedules, by when they come next and a day at a
// time, and removed by the owner after a confirmation. Nothing adds one from
// here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { ScheduleEntry } from "@penelope/contract";

import { App } from "../src/ui/App.tsx";
import { words } from "../src/ui/words.ts";
import { FakeBackend } from "./fake-backend.ts";

const sleep = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

type HappyWindow = { happyDOM: { setViewport: (viewport: { width: number; height?: number }) => void } };

const daysOn = (days: number, hour: number, minute = 0) => {
  const day = new Date();
  day.setDate(day.getDate() + days);
  day.setHours(hour, minute, 0, 0);
  return day.toISOString();
};

const PATROL = "朝のクラスタの見回り。ノードと Pod の様子を確かめて、気になることがあれば知らせる。";
const TIDY = "週ごとの片付け。作業の場所の古いファイルをまとめて、一覧を知らせる。";

/** In the order she made them, which is not the order they come in. */
const four = (): ScheduleEntry[] => [
  { id: "s-1", reason: TIDY, cron: "0 18 * * 0", next_at: daysOn(3, 18) },
  { id: "s-2", reason: "PR を見直す", at: "2030-01-02T12:00:00Z", next_at: "2030-01-02T12:00:00.000Z" },
  { id: "s-3", reason: PATROL, cron: "0 9 * * *", next_at: daysOn(1, 9) },
  { id: "s-4", reason: "半時間ごとに確かめる", cron: "*/30 * * * *", next_at: daysOn(1, 10, 30) },
];

function start(backend = new FakeBackend()) {
  render(<App fetch={backend.fetch} sleep={sleep} />);
  return backend;
}

/** Found first, then pressed: a find inside act() would hold back the render it waits for. */
async function press(found: HTMLElement | Promise<HTMLElement>) {
  const element = await found;
  await act(async () => fireEvent.click(element));
}

const page = () => screen.findByRole("region", { name: words.schedules });
const rowOf = async (lead: string) => (await within(await page()).findByText(lead)).closest("li") as HTMLElement;
const leads = async () => within(await page()).getAllByRole("listitem").map((row) => within(row).getAllByRole("button")[0]!.querySelector(".schedule-lead")?.textContent);
const removeOf = async (lead: string) => within(await rowOf(lead)).getByRole("button", { name: words.scheduleRemoveOf(lead) });

afterEach(() => cleanup());

describe("the schedules in the Web UI", () => {
  async function open(backend: FakeBackend) {
    start(backend);
    await backend.connected();
    await press(screen.findByRole("button", { name: words.places.events }));
  }

  it("are in the place of the events and the schedules", async () => {
    assert.equal(words.places.events, "出来事と予約");
    const backend = new FakeBackend();
    await open(backend);
    assert.ok(await page());
  });

  it("lists them by when they come next, a day at a time", async () => {
    const backend = new FakeBackend();
    backend.schedules = four();
    await open(backend);
    await within(await page()).findByText("PR を見直す");
    assert.deepEqual(await leads(), ["朝のクラスタの見回り", "半時間ごとに確かめる", "週ごとの片付け", "PR を見直す"]);
    const days = within(await page()).getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent ?? "");
    assert.equal(days.length, 3);
    assert.match(days[0]!, /^明日 ・ \d+月\d+日\(.\)$/);
    assert.match(days[1]!, /^(\d+年)?\d+月\d+日\(.\)$/);
    assert.equal(days[2], "2030年1月2日(水)");
    const [tomorrow] = within(await page()).getAllByRole("list");
    assert.equal(within(tomorrow!).getAllByRole("listitem").length, 2);
  });

  it("says how many there are and which comes next by the heading", async () => {
    const backend = new FakeBackend();
    backend.schedules = four();
    await open(backend);
    assert.ok(await within(await page()).findByText(`4 件 ・ ${words.scheduleNext} 明日 9:00`));
  });

  it("shows the time, the lead and the rest, and how it comes again", async () => {
    const backend = new FakeBackend();
    backend.schedules = four();
    await open(backend);
    const patrol = await rowOf("朝のクラスタの見回り");
    assert.ok(within(patrol).getByText("9:00"));
    assert.ok(within(patrol).getByText("ノードと Pod の様子を確かめて、気になることがあれば知らせる。"));
    assert.ok(within(patrol).getByText("毎日 9:00"));
    assert.ok(within(patrol).getByText("0 9 * * *"));
    assert.doesNotMatch(patrol.textContent ?? "", new RegExp(words.scheduleNext));

    const tidy = await rowOf("週ごとの片付け");
    assert.ok(within(tidy).getByText("毎週 日曜 18:00"));
  });

  it("shows only the cron of one it cannot say in words", async () => {
    const backend = new FakeBackend();
    backend.schedules = four();
    await open(backend);
    const row = await rowOf("半時間ごとに確かめる");
    assert.ok(within(row).getByText("*/30 * * * *"));
    assert.doesNotMatch(row.textContent ?? "", /毎/);
    assert.equal(row.querySelector(".schedule-rest"), null);
  });

  it("says a one-time one comes once, with no cron", async () => {
    const backend = new FakeBackend();
    backend.schedules = four();
    await open(backend);
    const row = await rowOf("PR を見直す");
    assert.ok(within(row).getByText(words.scheduleOnce));
    assert.equal(row.querySelector("code"), null);
    assert.equal(row.querySelector("svg"), null);
  });

  it("opens one row at a time", async () => {
    const backend = new FakeBackend();
    backend.schedules = four();
    await open(backend);
    const toggleOf = async (lead: string) => within(await rowOf(lead)).getAllByRole("button")[0]!;
    assert.equal((await toggleOf("朝のクラスタの見回り")).getAttribute("aria-expanded"), "false");
    await press(toggleOf("朝のクラスタの見回り"));
    assert.equal((await toggleOf("朝のクラスタの見回り")).getAttribute("aria-expanded"), "true");
    await press(toggleOf("週ごとの片付け"));
    assert.equal((await toggleOf("週ごとの片付け")).getAttribute("aria-expanded"), "true");
    assert.equal((await toggleOf("朝のクラスタの見回り")).getAttribute("aria-expanded"), "false");
    await press(toggleOf("週ごとの片付け"));
    assert.equal((await toggleOf("週ごとの片付け")).getAttribute("aria-expanded"), "false");
  });

  it("says when there are none", async () => {
    const backend = new FakeBackend();
    await open(backend);
    assert.ok(await screen.findByText(words.schedulesNone));
  });

  it("removes one only once the owner confirms it, saying how it comes", async () => {
    const backend = new FakeBackend();
    backend.schedules = four();
    await open(backend);
    await press(removeOf("PR を見直す"));
    const dialog = await screen.findByRole("alertdialog");
    assert.match(dialog.textContent ?? "", /PR を見直す/);
    assert.match(dialog.textContent ?? "", new RegExp(words.scheduleOnce));
    assert.match(dialog.textContent ?? "", /エージェントには知らせません/);
    await press(within(dialog).getByRole("button", { name: words.scheduleKeep }));
    await waitFor(() => assert.equal(screen.queryByRole("alertdialog"), null));
    assert.deepEqual(backend.scheduleRemovals, []);

    await press(removeOf("PR を見直す"));
    await press(within(await screen.findByRole("alertdialog")).getByRole("button", { name: words.scheduleRemove }));
    await waitFor(() => assert.equal(screen.queryByRole("alertdialog"), null));
    assert.deepEqual(backend.scheduleRemovals, ["s-2"]);
    await waitFor(() => assert.equal(screen.queryByText("PR を見直す"), null));
    assert.equal(within(await page()).getAllByRole("listitem").length, 3);
    assert.ok(await within(await page()).findByText(`3 件 ・ ${words.scheduleNext} 明日 9:00`));
  });

  it("names the lead and the words of a repeating one in the confirmation", async () => {
    const backend = new FakeBackend();
    backend.schedules = four();
    await open(backend);
    await press(removeOf("朝のクラスタの見回り"));
    const dialog = await screen.findByRole("alertdialog");
    assert.match(dialog.textContent ?? "", /朝のクラスタの見回り/);
    assert.match(dialog.textContent ?? "", /毎日 9:00/);
    await press(within(dialog).getByRole("button", { name: words.scheduleKeep }));

    await press(removeOf("半時間ごとに確かめる"));
    assert.match((await screen.findByRole("alertdialog")).textContent ?? "", /\*\/30 \* \* \* \*/);
  });

  it("reads the list again when the one to remove was already gone", async () => {
    const backend = new FakeBackend();
    backend.schedules = four();
    await open(backend);
    await within(await page()).findByText("PR を見直す");
    // She removed it herself, or it came due, while the owner looked.
    backend.schedules = backend.schedules.filter((schedule) => schedule.id !== "s-2");
    await press(removeOf("PR を見直す"));
    await press(within(await screen.findByRole("alertdialog")).getByRole("button", { name: words.scheduleRemove }));
    await waitFor(() => assert.equal(screen.queryByText("PR を見直す"), null));
    assert.equal(screen.queryByRole("alertdialog"), null);
  });

  it("keeps the one it could not remove, and says so", async () => {
    const backend = new FakeBackend();
    backend.schedules = four();
    backend.failRemovals = true;
    await open(backend);
    await press(removeOf("PR を見直す"));
    await press(within(await screen.findByRole("alertdialog")).getByRole("button", { name: words.scheduleRemove }));
    assert.ok(await screen.findByText(words.scheduleRemoveFailed));
    assert.ok(within(await page()).getByText("PR を見直す"));
  });
});

// What docs/design/README.md, 12 asks of an implementation.
describe("the schedules, as the design asks of them", () => {
  async function open(backend: FakeBackend) {
    start(backend);
    await backend.connected();
    await press(screen.findByRole("button", { name: words.places.events }));
  }
  let style: HTMLStyleElement | undefined;
  afterEach(() => style?.remove());
  const css = (el: Element) => getComputedStyle(el);

  it("cuts a long lead at two lines while closed, and shows it whole once open", async () => {
    style = document.createElement("style");
    style.textContent = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/^@import .*$/gm, "");
    document.head.append(style);
    const backend = new FakeBackend();
    const long = "とても長い最初の文".repeat(20);
    backend.schedules = [{ id: "s-1", reason: `${long}。残り`, cron: "0 6 * * *", next_at: daysOn(1, 6) }];
    await open(backend);
    const row = await rowOf(long);
    const lead = row.querySelector(".schedule-lead")!;
    assert.equal(lead.textContent, long);
    assert.equal(css(lead).overflow, "hidden");
    // Happy-dom computes no clamp and keeps only the unprefixed one: it is read from the rules that match the lead.
    const clampOf = (el: Element) =>
      [...style!.sheet!.cssRules]
        .filter((r): r is CSSStyleRule => "selectorText" in r && el.matches((r as CSSStyleRule).selectorText))
        .map((r) => r.style.getPropertyValue("line-clamp"))
        .filter((v) => v !== "")
        .at(-1);
    assert.equal(clampOf(lead), "2");
    await press(within(row).getAllByRole("button")[0]!);
    assert.equal(clampOf(row.querySelector(".schedule-lead")!), "none");
  });

  it("splits the reason at its first 。 only, and keeps every word of the lead", async () => {
    const backend = new FakeBackend();
    backend.schedules = [{ id: "s-1", reason: "朝の予定確認（毎朝6:00 JST）. /memory/always.md を読む。残り", cron: "0 6 * * *", next_at: daysOn(1, 6) }];
    await open(backend);
    const row = await rowOf("朝の予定確認（毎朝6:00 JST）. /memory/always.md を読む");
    assert.ok(within(row).getByText("毎日 6:00"));
    assert.ok(within(row).getByText("0 6 * * *"));
  });

  it("puts the button that removes one beside the one that opens it, not in it, and names the lead", async () => {
    const backend = new FakeBackend();
    backend.schedules = four();
    await open(backend);
    const row = await rowOf("朝のクラスタの見回り");
    const [toggle, remove] = within(row).getAllByRole("button") as [HTMLElement, HTMLElement];
    assert.equal(toggle.contains(remove), false);
    assert.equal(remove.contains(toggle), false);
    assert.equal(remove.getAttribute("aria-label") ?? remove.textContent, words.scheduleRemoveOf("朝のクラスタの見回り"));
    await press(remove);
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
  });

  it("drops the day with its last one, and keeps open the row that was open", async () => {
    const backend = new FakeBackend();
    backend.schedules = four();
    await open(backend);
    const toggleOf = async (lead: string) => within(await rowOf(lead)).getAllByRole("button")[0]!;
    await press(toggleOf("週ごとの片付け"));
    const days = () => within(screen.getByRole("region", { name: words.schedules })).getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    assert.ok(days().includes("2030年1月2日(水)"));
    await press(removeOf("PR を見直す"));
    await press(within(await screen.findByRole("alertdialog")).getByRole("button", { name: words.scheduleRemove }));
    await waitFor(() => assert.equal(screen.queryByText("PR を見直す"), null));
    assert.equal(days().includes("2030年1月2日(水)"), false);
    assert.equal(days().length, 2);
    assert.equal((await toggleOf("週ごとの片付け")).getAttribute("aria-expanded"), "true");

    await press(removeOf("朝のクラスタの見回り"));
    await press(within(await screen.findByRole("alertdialog")).getByRole("button", { name: words.scheduleRemove }));
    await waitFor(() => assert.equal(screen.queryByText("朝のクラスタの見回り"), null));
    assert.ok(await within(await page()).findByText(`2 件 ・ ${words.scheduleNext} 明日 10:30`));
  });
});

describe("the schedules on a phone", () => {
  afterEach(() => (window as unknown as HappyWindow).happyDOM.setViewport({ width: 1024 }));

  it("are listed and removed from the place of the events and the schedules in the menu", async () => {
    (window as unknown as HappyWindow).happyDOM.setViewport({ width: 390, height: 844 });
    const backend = new FakeBackend();
    backend.schedules = four();
    start(backend);
    await backend.connected();
    await press(screen.findByRole("button", { name: words.menu }));
    await press(screen.findByRole("button", { name: words.places.events }));
    await press(removeOf("朝のクラスタの見回り"));
    await press(within(await screen.findByRole("alertdialog")).getByRole("button", { name: words.scheduleRemove }));
    await waitFor(() => assert.equal(screen.queryByText("朝のクラスタの見回り"), null));
    assert.deepEqual(backend.scheduleRemovals, ["s-3"]);
  });
});
