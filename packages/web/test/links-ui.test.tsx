// The addresses on the screens open in a new tab: in her replies, in what the
// owner wrote, and in her turn as it goes (the main agent's and a
// sub-agent's). Only http and https become links.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { Activity, StreamEvent } from "@penelope/contract";

import { App } from "../src/ui/App.tsx";
import { FakeBackend } from "./fake-backend.ts";

const sleep = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

function start(backend = new FakeBackend()) {
  render(<App fetch={backend.fetch} sleep={sleep} />);
  return backend;
}

async function write(text: string) {
  const field = await screen.findByRole("textbox");
  await act(async () => {
    field.textContent = text;
    fireEvent.input(field);
  });
  await act(async () => {
    fireEvent.keyDown(field, { key: "Enter", code: "Enter" });
  });
}

const timeline = () => screen.getByRole("log");
const panel = () => screen.getByRole("complementary");
const activity = (agent: string, activity: Activity): StreamEvent => ({ event: "activity", data: { agent, activity } });

/** Each link as its href and words, after checking that it opens in a new tab on its own. */
function linksIn(element: HTMLElement): Array<[string, string]> {
  return [...element.querySelectorAll("a")].map((a) => {
    assert.equal(a.getAttribute("target"), "_blank", a.outerHTML);
    assert.equal(a.getAttribute("rel"), "noopener noreferrer", a.outerHTML);
    return [a.getAttribute("href") ?? "", a.textContent ?? ""];
  });
}

afterEach(() => cleanup());

describe("the addresses on the screens", () => {
  it("makes a bare address in a reply a link, without the 。 after it", async () => {
    const backend = new FakeBackend();
    backend.history = [{ kind: "agent", id: "r-1", at: new Date().toISOString(), text: "PR は https://example.com/pr/1。見てください。", agent: "main" }];
    start(backend);
    await backend.connected();
    await waitFor(() => within(timeline()).getByText(/見てください/));
    assert.deepEqual(linksIn(timeline()), [["https://example.com/pr/1", "https://example.com/pr/1"]]);
  });

  it("opens a written link of a reply in a new tab, and no link inside it", async () => {
    const backend = new FakeBackend();
    backend.history = [{ kind: "agent", id: "r-1", at: new Date().toISOString(), text: "[the docs at https://example.com/docs](https://example.com/docs) です", agent: "main" }];
    start(backend);
    await backend.connected();
    await waitFor(() => within(timeline()).getByText(/です/));
    assert.deepEqual(linksIn(timeline()), [["https://example.com/docs", "the docs at https://example.com/docs"]]);
  });

  it("makes no link of another scheme in a reply, nor of an address in code", async () => {
    const backend = new FakeBackend();
    backend.history = [
      {
        kind: "agent",
        id: "r-1",
        at: new Date().toISOString(),
        text: "[run](javascript:alert(1)) [mail](mailto:someone@example.com) [here](/api/x) someone@example.com `https://example.com/in-code` end",
        agent: "main",
      },
    ];
    start(backend);
    await backend.connected();
    await waitFor(() => within(timeline()).getByText(/end/));
    assert.deepEqual(linksIn(timeline()), []);
    assert.match(timeline().textContent ?? "", /run/);
    assert.match(timeline().textContent ?? "", /mail/);
    assert.match(timeline().textContent ?? "", /https:\/\/example\.com\/in-code/);
  });

  it("makes an address in what the owner wrote a link", async () => {
    const backend = new FakeBackend();
    backend.history = [{ kind: "owner", id: "m-1", at: new Date().toISOString(), text: "これを見て（https://example.com/a）\n次の行" }];
    start(backend);
    await backend.connected();
    await waitFor(() => within(timeline()).getByText(/次の行/));
    assert.deepEqual(linksIn(timeline()), [["https://example.com/a", "https://example.com/a"]]);
    assert.match(timeline().textContent ?? "", /これを見て（https:\/\/example\.com\/a）\n次の行/);
  });

  it("makes no link of what made her speak", async () => {
    const backend = new FakeBackend();
    backend.history = [
      { kind: "agent", id: "r-1", at: new Date().toISOString(), text: "done", agent: "main", trigger: { source: "a2a", summary: "see https://example.com/task" } },
    ];
    start(backend);
    await backend.connected();
    await waitFor(() => within(timeline()).getByText("done"));
    assert.match(timeline().textContent ?? "", /https:\/\/example\.com\/task/);
    assert.deepEqual(linksIn(timeline()), []);
  });

  it("makes the addresses in her turn links: her thoughts, her words, her tools and the owner's interruption", async () => {
    const backend = start();
    await backend.connected();
    const at = new Date().toISOString();
    await act(async () => {
      backend.send({ event: "state", data: { agent: "main", state: "thinking" } });
      backend.send(activity("main", { kind: "turn_start", at, turn_id: "t-1" }));
      backend.send(activity("main", { kind: "thinking", at, turn_id: "t-1", text: "read https://example.com/think first" }));
      backend.send(activity("main", { kind: "message", at, turn_id: "t-1", text: "see https://example.com/say." }));
      backend.send(activity("main", { kind: "tool_call", at, turn_id: "t-1", call_id: "c-1", name: "bash", arguments: { command: "curl https://example.com/tool" } }));
    });
    await waitFor(() => within(panel()).getByText("ツールを使っている"));
    await write("and https://example.com/owner too");
    await waitFor(() => assert.match(panel().textContent ?? "", /owner too/));
    assert.deepEqual(
      linksIn(panel()).map(([href]) => href),
      ["https://example.com/think", "https://example.com/say", "https://example.com/tool", "https://example.com/owner"],
    );
  });

  it("makes the addresses in a sub-agent's turn links once its frame is open", async () => {
    const backend = new FakeBackend();
    const since = new Date().toISOString();
    backend.agents = [{ agent: "cluster-test", purpose: "check https://example.com/purpose", state: "thinking", started_at: since, state_since: since }];
    start(backend);
    await backend.connected();
    const column = () => within(panel()).getByRole("region", { name: "サブエージェント" });
    await waitFor(() => assert.ok(column()));
    await act(async () => {
      backend.send(activity("cluster-test", { kind: "turn_start", at: since, turn_id: "c-1" }));
      backend.send(activity("cluster-test", { kind: "thinking", at: since, turn_id: "c-1", text: "open https://example.com/sub" }));
    });
    const head = within(column()).getByRole("button", { name: /cluster-test/ });
    // Its head is the button that opens it: no link inside a button.
    assert.equal(head.querySelector("a"), null);
    await act(async () => fireEvent.click(head));
    await waitFor(() => assert.equal(head.getAttribute("aria-expanded"), "true"));
    assert.deepEqual(
      linksIn(column()).map(([href]) => href),
      ["https://example.com/sub"],
    );
  });
});
