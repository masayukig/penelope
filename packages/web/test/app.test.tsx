import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { Activity, StreamEvent, SubAgent } from "@penelope/contract";

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

  // ADR-0016: the avatar changes its face with the expression; a word it has no face for shows neutral.
  it("draws each reply with its own face, and the panel with the latest one", async () => {
    const backend = new FakeBackend();
    backend.agent = { name: "Iris", icons: { neutral: "/faces/neutral", happy: "/faces/happy", worried: "/faces/worried" } };
    backend.history = [
      { kind: "agent", id: "r-1", at: new Date(Date.now() - 60_000).toISOString(), text: "hmm", agent: "main", expression: "worried" },
      { kind: "agent", id: "r-2", at: new Date().toISOString(), text: "done", agent: "main", expression: "happy" },
      { kind: "agent", id: "r-3", at: new Date().toISOString(), text: "odd", agent: "main", expression: "no-such-face" },
    ];
    start(backend);
    await backend.connected();
    await waitFor(() => within(timeline()).getByText("odd"));
    const faces = [...timeline().querySelectorAll("img")].map((img) => img.getAttribute("src"));
    assert.deepEqual(faces, ["/faces/worried", "/faces/happy", "/faces/neutral"]);
    // The latest reply with a face it knows of is "no-such-face": the panel shows neutral for it.
    assert.deepEqual([...panel().querySelectorAll("img")].map((img) => img.getAttribute("src")), ["/faces/neutral"]);
  });

  it("shows her thinking face in the panel while she is in a turn, and her reply's face again after it", async () => {
    const backend = new FakeBackend();
    backend.agent = { name: "Iris", icons: { neutral: "/faces/neutral", happy: "/faces/happy", thinking: "/faces/thinking" } };
    backend.history = [{ kind: "agent", id: "r-1", at: new Date().toISOString(), text: "done", agent: "main", expression: "happy" }];
    start(backend);
    await backend.connected();
    const panelFaces = () => [...panel().querySelectorAll("img")].map((img) => img.getAttribute("src"));
    await waitFor(() => assert.deepEqual(panelFaces(), ["/faces/happy"]));
    await act(async () => backend.send({ event: "state", data: { agent: "main", state: "thinking" } }));
    await waitFor(() => assert.deepEqual(panelFaces(), ["/faces/thinking"]));
    // The reply's own face does not change with her state.
    assert.deepEqual([...timeline().querySelectorAll("img")].map((img) => img.getAttribute("src")), ["/faces/happy"]);
    await act(async () => backend.send({ event: "state", data: { agent: "main", state: "waiting" } }));
    await waitFor(() => assert.deepEqual(panelFaces(), ["/faces/happy"]));
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
        data: { agent: "main", activity: { kind: "tool_call", at, turn_id: "t-1", call_id: "c-1", name: "bash", arguments: { command: "kubectl get pods -A", timeout: 60 } } },
      }),
    );
    await waitFor(() => within(panel()).getByText("ツールを使っている"));
    // The command, not the JSON of the arguments.
    assert.match(panel().textContent ?? "", /bash: kubectl get pods -A/);
    assert.doesNotMatch(panel().textContent ?? "", /"command"|timeout/);
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

describe("the sub-agents in the Web UI", () => {
  const since = new Date(Date.now() - 60_000).toISOString();
  const three = (): SubAgent[] => [
    { agent: "cluster-test", purpose: "try the update on the test cluster", state: "thinking", started_at: since, state_since: since },
    { agent: "renovate-review", purpose: "look over the Renovate PRs", state: "thinking", started_at: since, state_since: since },
    { agent: "fleet-fix", purpose: "fix the failing Kustomization", state: "waiting", started_at: since, state_since: since },
  ];
  const column = () => within(panel()).queryByRole("region", { name: "サブエージェント" });
  const opener = (name: string) => within(column()!).getByRole("button", { name: new RegExp(name) });
  const subActivity = (agent: string, activity: Activity): StreamEvent => ({ event: "activity", data: { agent, activity } });

  // docs/design/README.md 11-5: no empty frame, no heading.
  it("shows no column of sub-agents when there are none", async () => {
    const backend = start();
    await backend.connected();
    await waitFor(() => assert.ok(backend.agentsRead > 0));
    await waitFor(() => within(panel()).getByText("待っている"));
    assert.equal(column(), null);
    assert.equal(screen.queryByText(/サブエージェント/), null);
  });

  it("lists them in the order they were started, with how many run and wait", async () => {
    const backend = new FakeBackend();
    backend.agents = three();
    start(backend);
    await backend.connected();
    await waitFor(() => assert.ok(column()));
    const text = column()!.textContent ?? "";
    assert.ok(text.indexOf("cluster-test") < text.indexOf("renovate-review"));
    assert.ok(text.indexOf("renovate-review") < text.indexOf("fleet-fix"));
    assert.match(text, /走っている 2 ・ 待っている 1/);
    assert.match(text, /止まって待っている/);
    assert.match(text, /look over the Renovate PRs/);
  });

  it("opens one at a time", async () => {
    const backend = new FakeBackend();
    backend.agents = three();
    start(backend);
    await backend.connected();
    await waitFor(() => assert.ok(column()));
    await act(async () => fireEvent.click(opener("cluster-test")));
    await waitFor(() => assert.equal(opener("cluster-test").getAttribute("aria-expanded"), "true"));
    await act(async () => fireEvent.click(opener("fleet-fix")));
    await waitFor(() => assert.equal(opener("fleet-fix").getAttribute("aria-expanded"), "true"));
    assert.equal(opener("cluster-test").getAttribute("aria-expanded"), "false");
    assert.equal(opener("renovate-review").getAttribute("aria-expanded"), "false");
  });

  // The purpose is told once: in full in its frame once it is opened, not again at the head of the flow.
  it("tells the purpose once when a frame is opened", async () => {
    const backend = new FakeBackend();
    backend.agents = three();
    start(backend);
    await backend.connected();
    await waitFor(() => assert.ok(column()));
    await act(async () => fireEvent.click(opener("cluster-test")));
    await waitFor(() => assert.equal(opener("cluster-test").getAttribute("aria-expanded"), "true"));
    assert.equal(within(column()!).getAllByText("try the update on the test cluster").length, 1);
  });

  it("follows the stream: a state that changes, one started, one closed", async () => {
    const backend = new FakeBackend();
    backend.agents = three();
    start(backend);
    await backend.connected();
    await waitFor(() => assert.ok(column()));
    const at = new Date().toISOString();
    await act(async () => {
      backend.send({ event: "state", data: { agent: "fleet-fix", state: "thinking" } });
      backend.send(subActivity("fleet-fix", { kind: "turn_start", at, turn_id: "f-1" }));
      backend.send(subActivity("fleet-fix", { kind: "tool_call", at, turn_id: "f-1", call_id: "c-1", name: "bash", arguments: { command: "flux get kustomizations", timeout: 60 } }));
    });
    await waitFor(() => assert.match(within(column()!).getByRole("heading").parentElement!.textContent ?? "", /走っている 3$/));
    assert.match(column()!.textContent ?? "", /bash: flux get kustomizations/);
    assert.doesNotMatch(column()!.textContent ?? "", /"command"|timeout/);
    await act(async () => {
      backend.send({ event: "agent", data: { agent: "cluster-test", purpose: "try the update on the test cluster", closed: true } });
      backend.send({ event: "agent", data: { agent: "cert-audit", purpose: "list the certificates", closed: false } });
    });
    await waitFor(() => assert.match(column()!.textContent ?? "", /cert-audit/));
    const text = column()!.textContent ?? "";
    assert.doesNotMatch(text, /cluster-test/);
    assert.ok(text.indexOf("fleet-fix") < text.indexOf("cert-audit"));
    await act(async () => {
      for (const agent of ["renovate-review", "fleet-fix", "cert-audit"]) backend.send({ event: "agent", data: { agent, purpose: "", closed: true } });
    });
    await waitFor(() => assert.equal(column(), null));
  });

  it("reads the list again when the stream comes back", async () => {
    const backend = new FakeBackend();
    backend.agents = three();
    start(backend);
    await backend.connected();
    await waitFor(() => assert.ok(column()));
    await act(async () => backend.drop());
    await waitFor(() => screen.getByText(/接続が切れました/));
    backend.agents = [three()[1]!];
    await act(async () => backend.up());
    await backend.connected(2);
    await waitFor(() => assert.doesNotMatch(column()!.textContent ?? "", /cluster-test/));
    assert.match(column()!.textContent ?? "", /renovate-review/);
    assert.ok(backend.agentsRead >= 2);
  });

  // While the panel is closed, the count stands by her name in the header (11-6).
  it("counts them by her name when the panel is closed", async () => {
    const backend = new FakeBackend();
    backend.agents = three();
    start(backend);
    await backend.connected();
    await waitFor(() => assert.ok(column()));
    const toggle = screen.getByRole("button", { name: "いまのエージェントを開く・閉じる" });
    assert.equal(within(toggle).queryByText("サブ 3"), null);
    await act(async () => fireEvent.click(toggle));
    await waitFor(() => assert.equal(screen.queryByRole("complementary"), null));
    assert.ok(within(toggle).getByText("サブ 3"));
  });

  it("keeps the sub-agents' turns out of the main agent's now and out of the timeline", async () => {
    const backend = new FakeBackend();
    backend.agents = three();
    backend.history = [{ kind: "owner", id: "m-1", at: new Date().toISOString(), text: "check the cluster" }];
    start(backend);
    await backend.connected();
    await waitFor(() => assert.ok(column()));
    const at = new Date().toISOString();
    await act(async () => {
      backend.send(subActivity("cluster-test", { kind: "turn_start", at, turn_id: "c-1" }));
      backend.send(subActivity("cluster-test", { kind: "thinking", at, turn_id: "c-1", text: "drain the workers one by one" }));
      backend.send(subActivity("cluster-test", { kind: "tool_call", at, turn_id: "c-1", call_id: "c-1", name: "bash", arguments: { command: "kubectl get nodes", timeout: 60 } }));
    });
    await waitFor(() => assert.match(column()!.textContent ?? "", /kubectl get nodes/));
    const now = within(panel()).getByRole("region", { name: "Iris（本体）" });
    assert.ok(within(now).getByText("待っている"));
    assert.doesNotMatch(now.textContent ?? "", /kubectl get nodes|drain the workers/);
    assert.doesNotMatch(timeline().textContent ?? "", /kubectl get nodes|drain the workers/);
  });
});

describe("the sub-agents on a phone", () => {
  afterEach(() => (window as unknown as { happyDOM: { setViewport: (v: { width: number }) => void } }).happyDOM.setViewport({ width: 1024 }));

  it("counts them on the strip, and lists them in the sheet", async () => {
    (window as unknown as { happyDOM: { setViewport: (v: { width: number; height: number }) => void } }).happyDOM.setViewport({ width: 390, height: 844 });
    const backend = new FakeBackend();
    const since = new Date().toISOString();
    backend.agents = [
      { agent: "cluster-test", purpose: "try the update", state: "thinking", started_at: since, state_since: since },
      { agent: "fleet-fix", purpose: "fix the Kustomization", state: "waiting", started_at: since, state_since: since },
    ];
    start(backend);
    await backend.connected();
    const strip = await screen.findByRole("button", { name: /^いまのエージェントを開く$/ });
    await waitFor(() => assert.ok(within(strip).getByText("サブ 2")));
    await act(async () => fireEvent.click(strip));
    const sheet = await screen.findByRole("dialog", { name: "いまのエージェント" });
    const list = within(sheet).getByRole("region", { name: "サブエージェント" });
    assert.match(list.textContent ?? "", /走っている 1 ・ 待っている 1/);
  });
});
