// Her schedules in the Web UI (docs/ui-api.md, "予約"): listed in the place
// of the events, and removed by the owner after a confirmation. Nothing adds
// one from here.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { ScheduleEntry } from "@penelope/contract";

import { App } from "../src/ui/App.tsx";
import { words } from "../src/ui/words.ts";
import { FakeBackend } from "./fake-backend.ts";

const sleep = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

type HappyWindow = { happyDOM: { setViewport: (viewport: { width: number; height?: number }) => void } };

const tomorrowAt9 = () => {
  const day = new Date();
  day.setDate(day.getDate() + 1);
  day.setHours(9, 0, 0, 0);
  return day.toISOString();
};

const two = (): ScheduleEntry[] => [
  { id: "s-1", reason: "朝のクラスタの見回り", cron: "0 9 * * *", next_at: tomorrowAt9() },
  { id: "s-2", reason: "PR を見直す", at: "2030-01-02T12:00:00Z", next_at: "2030-01-02T12:00:00.000Z" },
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

const list = () => screen.findByRole("list", { name: words.schedules });
const rowOf = async (reason: string) => (await within(await list()).findByText(reason)).closest("li") as HTMLElement;

afterEach(() => cleanup());

describe("the schedules in the Web UI", () => {
  async function open(backend: FakeBackend) {
    start(backend);
    await backend.connected();
    await press(screen.findByRole("button", { name: words.places.events }));
  }

  it("lists them in the place of the events, with how they come and when next", async () => {
    const backend = new FakeBackend();
    backend.schedules = two();
    await open(backend);
    const [first, second] = within(await list()).getAllByRole("listitem");
    assert.match(first!.textContent ?? "", /朝のクラスタの見回り/);
    assert.match(first!.textContent ?? "", /0 9 \* \* \*/);
    assert.match(first!.textContent ?? "", /明日 9:00/);
    assert.match(second!.textContent ?? "", /PR を見直す/);
    assert.match(second!.textContent ?? "", new RegExp(words.scheduleOnce));
    assert.match(second!.textContent ?? "", /2030年1月2日/);
  });

  it("says when there are none", async () => {
    const backend = new FakeBackend();
    await open(backend);
    assert.ok(await screen.findByText(words.schedulesNone));
  });

  it("removes one only once the owner confirms it", async () => {
    const backend = new FakeBackend();
    backend.schedules = two();
    await open(backend);
    await press(within(await rowOf("PR を見直す")).getByRole("button", { name: words.scheduleRemove }));
    const dialog = await screen.findByRole("alertdialog");
    assert.match(dialog.textContent ?? "", /PR を見直す/);
    await press(within(dialog).getByRole("button", { name: words.scheduleKeep }));
    await waitFor(() => assert.equal(screen.queryByRole("alertdialog"), null));
    assert.deepEqual(backend.scheduleRemovals, []);

    await press(within(await rowOf("PR を見直す")).getByRole("button", { name: words.scheduleRemove }));
    await press(within(await screen.findByRole("alertdialog")).getByRole("button", { name: words.scheduleRemove }));
    await waitFor(() => assert.equal(screen.queryByRole("alertdialog"), null));
    assert.deepEqual(backend.scheduleRemovals, ["s-2"]);
    await waitFor(() => assert.deepEqual(within(screen.getByRole("list", { name: words.schedules })).getAllByRole("listitem").length, 1));
    assert.ok(screen.getByText("朝のクラスタの見回り"));
  });

  it("reads the list again when the one to remove was already gone", async () => {
    const backend = new FakeBackend();
    backend.schedules = two();
    await open(backend);
    await within(await list()).findByText("PR を見直す");
    // She removed it herself, or it came due, while the owner looked.
    backend.schedules = backend.schedules.filter((schedule) => schedule.id !== "s-2");
    await press(within(await rowOf("PR を見直す")).getByRole("button", { name: words.scheduleRemove }));
    await press(within(await screen.findByRole("alertdialog")).getByRole("button", { name: words.scheduleRemove }));
    await waitFor(() => assert.equal(screen.queryByText("PR を見直す"), null));
    assert.equal(screen.queryByRole("alertdialog"), null);
  });

  it("keeps the one it could not remove, and says so", async () => {
    const backend = new FakeBackend();
    backend.schedules = two();
    backend.failRemovals = true;
    await open(backend);
    await press(within(await rowOf("PR を見直す")).getByRole("button", { name: words.scheduleRemove }));
    await press(within(await screen.findByRole("alertdialog")).getByRole("button", { name: words.scheduleRemove }));
    assert.ok(await screen.findByText(words.scheduleRemoveFailed));
    assert.ok(within(await list()).getByText("PR を見直す"));
  });
});

describe("the schedules on a phone", () => {
  afterEach(() => (window as unknown as HappyWindow).happyDOM.setViewport({ width: 1024 }));

  it("are listed and removed from the place of the events in the menu", async () => {
    (window as unknown as HappyWindow).happyDOM.setViewport({ width: 390, height: 844 });
    const backend = new FakeBackend();
    backend.schedules = two();
    start(backend);
    await backend.connected();
    await press(screen.findByRole("button", { name: words.menu }));
    await press(screen.findByRole("button", { name: words.places.events }));
    await press(within(await rowOf("朝のクラスタの見回り")).getByRole("button", { name: words.scheduleRemove }));
    await press(within(await screen.findByRole("alertdialog")).getByRole("button", { name: words.scheduleRemove }));
    await waitFor(() => assert.equal(screen.queryByText("朝のクラスタの見回り"), null));
    assert.deepEqual(backend.scheduleRemovals, ["s-1"]);
  });
});
