import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { App } from "../src/ui/App.tsx";
import { FakeBackend } from "./fake-backend.ts";

const sleep = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

function start(backend = new FakeBackend()) {
  render(<App fetch={backend.fetch} sleep={sleep} />);
  return backend;
}

/** Writes in the field and sends it, as the owner would with the keyboard. */
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

afterEach(() => cleanup());

describe("the Web UI", () => {
  // ADR-0001: the name is the deployment's; nothing in the code names her.
  it("names the agent as the settings do", async () => {
    const backend = new FakeBackend();
    backend.agent = { name: "Kestrel" };
    start(backend);
    await backend.connected();
    await waitFor(() => assert.ok(screen.getAllByText("Kestrel").length > 0));
    assert.equal(document.title, "Kestrel");
  });

  it("asks for a login when there is no session, naming her there too", async () => {
    const backend = new FakeBackend();
    backend.signedIn = false;
    start(backend);
    await waitFor(() => assert.ok(screen.getByText("Iris")));
    const links = screen.getAllByRole("link");
    assert.ok(links.some((link) => link.getAttribute("href") === "/auth/github/start"));
    assert.equal(screen.queryByRole("textbox"), null);
  });

  it("shows the history oldest first", async () => {
    const backend = new FakeBackend();
    backend.history = [
      { kind: "owner", id: "m-1", at: "2026-11-14T09:00:00Z", text: "first words" },
      { kind: "agent", id: "r-1", at: "2026-11-14T09:01:00Z", text: "an answer", agent: "main" },
    ];
    start(backend);
    await backend.connected();
    const log = timeline();
    await waitFor(() => within(log).getByText("an answer"));
    const text = log.textContent ?? "";
    assert.ok(text.indexOf("first words") < text.indexOf("an answer"));
  });

  it("sends what the owner writes and puts it in the timeline at once", async () => {
    const backend = start();
    await backend.connected();
    await write("check the pods");
    await waitFor(() => assert.deepEqual(backend.posted, [{ text: "check the pods", files: [] }]));
    assert.ok(within(timeline()).getByText("check the pods"));
  });

  it("shows a reply as it comes down the stream", async () => {
    const backend = start();
    await backend.connected();
    await act(async () => backend.send({ event: "reply", data: { kind: "agent", id: "r-1", at: new Date().toISOString(), text: "all pods are running", agent: "main" } }));
    await waitFor(() => within(timeline()).getByText("all pods are running"));
  });

  // The words of the states are the design's (docs/design/README.md, 5).
  it("follows what she does: thinking, using a tool, and waiting again", async () => {
    const backend = start();
    await backend.connected();
    await waitFor(() => within(panel()).getByText("待っている"));
    const at = new Date().toISOString();
    await act(async () => {
      backend.send({ event: "state", data: { agent: "main", state: "thinking" } });
      backend.send({ event: "activity", data: { agent: "main", activity: { kind: "turn_start", at, turn_id: "t-1" } } });
    });
    await waitFor(() => within(panel()).getByText("考えている"));
    await act(async () =>
      backend.send({
        event: "activity",
        data: { agent: "main", activity: { kind: "tool_call", at, turn_id: "t-1", call_id: "c-1", name: "bash", arguments: { command: "kubectl get pods -A" } } },
      }),
    );
    await waitFor(() => within(panel()).getByText("ツールを使っている"));
    assert.match(panel().textContent ?? "", /kubectl get pods -A/);
    await act(async () => {
      backend.send({ event: "activity", data: { agent: "main", activity: { kind: "turn_end", at, turn_id: "t-1" } } });
      backend.send({ event: "state", data: { agent: "main", state: "waiting" } });
    });
    await waitFor(() => within(panel()).getByText("待っている"));
    assert.doesNotMatch(panel().textContent ?? "", /kubectl get pods -A/);
  });

  it("marks a message sent while she thinks, and shows it in the turn as an interruption", async () => {
    const backend = start();
    await backend.connected();
    const at = new Date().toISOString();
    await act(async () => {
      backend.send({ event: "state", data: { agent: "main", state: "thinking" } });
      backend.send({ event: "activity", data: { agent: "main", activity: { kind: "turn_start", at, turn_id: "t-1" } } });
    });
    await waitFor(() => within(panel()).getByText("考えている"));
    await write("and make it a PR");
    await waitFor(() => within(panel()).getByText("and make it a PR"));
    assert.match(timeline().textContent ?? "", /考えている最中に届きました/);
  });

  // A reply she made on her own carries what started it; one to the owner does not.
  it("shows what made her speak beside a reply, but not for a reply to the owner", async () => {
    const backend = new FakeBackend();
    backend.history = [
      { kind: "agent", id: "r-1", at: "2026-11-14T09:00:00Z", text: "morning report", agent: "main", trigger: { source: "cron", summary: "every morning at 9:00" } },
      { kind: "agent", id: "r-2", at: "2026-11-14T09:05:00Z", text: "as you asked", agent: "main", trigger: { source: "ui", summary: "check the pods" } },
    ];
    start(backend);
    await backend.connected();
    await waitFor(() => within(timeline()).getByText("as you asked"));
    assert.match(timeline().textContent ?? "", /every morning at 9:00/);
    assert.doesNotMatch(timeline().textContent ?? "", /check the pods/);
  });

  // The notice promises that what is written goes once the line is back.
  it("says when the line drops, holds what is written, and sends it once it is back", async () => {
    const backend = start();
    await backend.connected();
    await act(async () => backend.drop());
    await waitFor(() => screen.getByText(/接続が切れました/));
    assert.ok(within(panel()).getByText("接続なし"));
    await write("written offline");
    assert.deepEqual(backend.posted, []);
    assert.ok(within(timeline()).getByText("written offline"));
    await act(async () => backend.up());
    await backend.connected(2);
    await waitFor(() => assert.deepEqual(backend.posted, [{ text: "written offline", files: [] }]));
    await waitFor(() => assert.equal(screen.queryByText(/接続が切れました/), null));
    // Every connection asks for all the backend kept (docs/ui-api.md).
    assert.deepEqual(backend.streamHeaders.map((headers) => headers.get("last-event-id")), ["0", "0"]);
  });

  it("sends the files put on a message along with it", async () => {
    const backend = start();
    await backend.connected();
    const picker = (await screen.findAllByLabelText("画像やファイルを添付")).find((element) => element instanceof HTMLInputElement)!;
    const file = new File(["a: 1\n"], "values.yaml", { type: "application/yaml" });
    await act(async () => fireEvent.change(picker, { target: { files: [file] } }));
    await write("see the file");
    await waitFor(() => assert.deepEqual(backend.posted, [{ text: "see the file", files: ["values.yaml"] }]));
  });

  it("goes back to the login when the owner logs out", async () => {
    const backend = start();
    await backend.connected();
    const [logout] = await screen.findAllByRole("button", { name: "ログアウト" });
    await act(async () => fireEvent.click(logout!));
    await waitFor(() => assert.ok(screen.getAllByRole("link").some((link) => link.getAttribute("href") === "/auth/github/start")));
  });
});

describe("the Web UI on a phone", () => {
  afterEach(() => (window as unknown as { happyDOM: { setViewport: (v: { width: number }) => void } }).happyDOM.setViewport({ width: 1024 }));

  // On a phone the agent now is a sheet that the avatar opens (docs/design/README.md, 4).
  it("opens what she is doing in a sheet from her avatar", async () => {
    (window as unknown as { happyDOM: { setViewport: (v: { width: number; height: number }) => void } }).happyDOM.setViewport({ width: 390, height: 844 });
    const backend = start();
    await backend.connected();
    assert.equal(screen.queryByRole("complementary"), null);
    const [opener] = await screen.findAllByRole("button", { name: /いまのエージェントを開く（Iris）/ });
    await act(async () => fireEvent.click(opener!));
    const sheet = await screen.findByRole("dialog", { name: "いまのエージェント" });
    assert.ok(within(sheet).getByText("待っている"));
  });
});
