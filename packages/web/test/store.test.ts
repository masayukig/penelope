import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Activity, HistoryEntry, StreamEvent, SubAgent } from "@penelope/contract";

import { type Action, callText, currentFlow, faceOf, FACE_RESET_MS, initialState, reduce, type State, statusOf, subAgentsOf } from "../src/model/store.ts";

const T = "turn-1";
const run = (actions: Action[], state: State = initialState) => actions.reduce(reduce, state);
const reply = (id: string, at: string, extra: Partial<Extract<HistoryEntry, { kind: "agent" }>> = {}): StreamEvent => ({
  event: "reply",
  data: { kind: "agent", id, at, text: `reply ${id}`, agent: "main", ...extra },
});
const activity = (a: Activity): StreamEvent => ({ event: "activity", data: { agent: "main", activity: a } });
const state = (s: "thinking" | "waiting"): StreamEvent => ({ event: "state", data: { agent: "main", state: s } });
const stream = (event: StreamEvent): Action => ({ type: "stream", event });
const ids = (s: State) => s.items.map((item) => item.id);

describe("the conversation's timeline", () => {
  // The history comes newest first; the screen reads oldest first.
  it("puts the history and the replies that arrive in time order, oldest first", () => {
    const s = run([
      {
        type: "history",
        entries: [
          { kind: "agent", id: "r-1", at: "2026-11-14T09:01:00Z", text: "hi", agent: "main" },
          { kind: "owner", id: "m-1", at: "2026-11-14T09:00:00Z", text: "hello" },
        ],
      },
      stream(reply("r-2", "2026-11-14T09:05:00Z")),
    ]);
    assert.deepEqual(ids(s), ["m-1", "r-1", "r-2"]);
  });

  it("keeps lines of the same time in the order the history gave them", () => {
    const at = "2026-11-14T09:00:00Z";
    const s = run([
      {
        type: "history",
        entries: [
          { kind: "agent", id: "r-2", at, text: "second", agent: "main" },
          { kind: "agent", id: "r-1", at, text: "first", agent: "main" },
        ],
      },
    ]);
    assert.deepEqual(ids(s), ["r-1", "r-2"]);
  });

  // Every connection replays what the backend kept (Last-Event-ID: 0), and
  // the history is read again after it: a reply must still show once.
  it("shows a reply once, whether it came by the history, the stream, or both again", () => {
    const entry = reply("r-1", "2026-11-14T09:01:00Z");
    const s = run([
      stream(entry),
      { type: "stream-open" },
      stream(entry),
      { type: "history", entries: [entry.data as HistoryEntry] },
    ]);
    assert.deepEqual(ids(s), ["r-1"]);
  });

  it("adds an older page before what is shown and keeps the cursor for the next", () => {
    const s = run([
      { type: "history", entries: [{ kind: "owner", id: "m-2", at: "2026-11-14T09:00:00Z", text: "b" }], before: "c-1" },
      { type: "history", entries: [{ kind: "owner", id: "m-1", at: "2026-11-13T09:00:00Z", text: "a" }], older: true },
    ]);
    assert.deepEqual(ids(s), ["m-1", "m-2"]);
    assert.equal(s.before, undefined);
  });

  // The avatar shows the face of her latest reply for a while, then goes
  // back to neutral, as natsumi's does (ADR-0016).
  it("shows the face of her latest reply, and neutral again once it has been shown a while", () => {
    const s = run([
      stream(reply("r-1", "2026-11-14T09:00:00Z", { expression: "worried" })),
      stream(reply("r-2", "2026-11-14T09:01:00Z", { expression: "happy" })),
      stream(reply("r-3", "2026-11-14T09:01:30Z")),
    ]);
    const since = Date.parse("2026-11-14T09:01:00Z");
    assert.equal(faceOf(s, since + 1_000), "happy");
    assert.equal(faceOf(s, since + FACE_RESET_MS + 1_000), undefined);
    assert.equal(faceOf(initialState, since), undefined);
  });

  // While she is in a turn the avatar thinks, as natsumi's does; back to
  // waiting, it shows the face of her latest reply again.
  it("thinks while she is in a turn, using a tool or not, and shows her latest face again once she waits", () => {
    const now = Date.parse("2026-11-14T09:01:10Z");
    let s = run([stream(reply("r-1", "2026-11-14T09:01:00Z", { expression: "happy" })), stream(state("thinking"))]);
    assert.equal(faceOf(s, now), "thinking");
    s = run([stream(activity({ kind: "tool_call", at: "2026-11-14T09:01:05Z", turn_id: T, call_id: "c-1", name: "bash", arguments: {} }))], s);
    assert.equal(faceOf(s, now), "thinking");
    s = run([stream(state("waiting"))], s);
    assert.equal(faceOf(s, now), "happy");
  });
});

describe("what the agent is doing", () => {
  it("is thinking from a turn's start and waiting again at its end", () => {
    let s = run([stream(state("thinking")), stream(activity({ kind: "turn_start", at: "2026-11-14T09:00:00Z", turn_id: T }))]);
    assert.equal(statusOf(s).kind, "thinking");
    s = run([stream(activity({ kind: "turn_end", at: "2026-11-14T09:02:00Z", turn_id: T })), stream(state("waiting"))], s);
    assert.equal(statusOf(s).kind, "waiting");
    assert.deepEqual(currentFlow(s), []);
  });

  // The phone's strip shows the tool in use, from its call until its result.
  it("is using a tool from its call until its result, and names it", () => {
    let s = run([
      stream(state("thinking")),
      stream(activity({ kind: "turn_start", at: "2026-11-14T09:00:00Z", turn_id: T })),
      stream(activity({ kind: "tool_call", at: "2026-11-14T09:00:01Z", turn_id: T, call_id: "c-1", name: "bash", arguments: { command: "kubectl get pods", timeout: 60 } })),
    ]);
    const status = statusOf(s);
    assert.equal(status.kind, "tool");
    assert.equal(status.kind === "tool" && status.tool.name, "bash");
    assert.equal(status.kind === "tool" ? status.tool.detail : "", "kubectl get pods");
    s = run([stream(activity({ kind: "tool_result", at: "2026-11-14T09:00:02Z", turn_id: T, call_id: "c-1", is_error: false, output: "ok" }))], s);
    assert.equal(statusOf(s).kind, "thinking");
  });

  it("flows the blocks of the turn under way, in the order they closed", () => {
    const s = run([
      stream(activity({ kind: "turn_start", at: "2026-11-14T08:00:00Z", turn_id: "old" })),
      stream(activity({ kind: "thinking", at: "2026-11-14T08:00:01Z", turn_id: "old", text: "an old thought" })),
      stream(activity({ kind: "turn_end", at: "2026-11-14T08:00:02Z", turn_id: "old" })),
      stream(state("thinking")),
      stream(activity({ kind: "turn_start", at: "2026-11-14T09:00:00Z", turn_id: T })),
      stream(activity({ kind: "thinking", at: "2026-11-14T09:00:01Z", turn_id: T, text: "a thought" })),
      stream(activity({ kind: "tool_call", at: "2026-11-14T09:00:02Z", turn_id: T, call_id: "c-1", name: "read", arguments: { path: "/memory/INDEX.md" } })),
    ]);
    assert.deepEqual(
      currentFlow(s).map((item) => item.kind),
      ["turn_start", "thinking", "tool_call"],
    );
  });

  // Each connection replays what the backend kept, so what was known before
  // it is thrown away rather than doubled.
  it("starts again from the replay when the stream opens again", () => {
    const before = run([
      stream(state("thinking")),
      stream(activity({ kind: "turn_start", at: "2026-11-14T09:00:00Z", turn_id: T })),
    ]);
    const s = run([{ type: "stream-open" }, stream(state("thinking")), stream(activity({ kind: "turn_start", at: "2026-11-14T09:00:00Z", turn_id: T }))], before);
    assert.equal(currentFlow(s).length, 1);
    assert.equal(statusOf(run([{ type: "stream-open" }], before)).kind, "waiting");
  });

  it("is out of reach while the stream is down", () => {
    const s = run([stream(state("thinking")), { type: "connection", state: "offline" }]);
    assert.equal(statusOf(s).kind, "offline");
  });
});

describe("a message from the owner", () => {
  it("shows at once, and keeps its place once the backend has taken it", () => {
    let s = run([{ type: "queued", key: "local-1", at: "2026-11-14T09:00:00Z", text: "hello", files: [], duringTurn: false }]);
    assert.deepEqual(s.items.map((item) => [item.kind, item.text]), [["owner", "hello"]]);
    s = run([{ type: "sending", key: "local-1" }, { type: "sent", key: "local-1", id: "m-1" }], s);
    assert.deepEqual(ids(s), ["m-1"]);
    // The history read again holds it under the same id: still once.
    s = run([{ type: "history", entries: [{ kind: "owner", id: "m-1", at: "2026-11-14T09:00:01Z", text: "hello" }] }], s);
    assert.deepEqual(ids(s), ["m-1"]);
  });

  // Sent while she is thinking, it steers the turn: it is marked so in the
  // timeline and shows in the turn's flow as an interruption.
  it("sent while she is thinking, is marked as arriving mid-turn and shows in the turn's flow", () => {
    const s = run([
      stream(state("thinking")),
      stream(activity({ kind: "turn_start", at: "2026-11-14T09:00:00Z", turn_id: T })),
      { type: "queued", key: "local-1", at: "2026-11-14T09:00:05Z", text: "and make it a PR", files: [], duringTurn: true },
    ]);
    const [item] = s.items;
    assert.equal(item?.kind === "owner" && item.duringTurn, true);
    const flow = currentFlow(s);
    assert.deepEqual(flow.map((entry) => entry.kind), ["turn_start", "interrupt"]);
    assert.equal(flow[1]?.kind === "interrupt" && flow[1].text, "and make it a PR");
  });

  it("stays in the turn's flow when the stream opens again and replays the turn", () => {
    const s = run([
      stream(state("thinking")),
      stream(activity({ kind: "turn_start", at: "2026-11-14T09:00:00Z", turn_id: T })),
      { type: "queued", key: "local-1", at: "2026-11-14T09:00:05Z", text: "one more", files: [], duringTurn: true },
      { type: "stream-open" },
      stream(state("thinking")),
      stream(activity({ kind: "turn_start", at: "2026-11-14T09:00:00Z", turn_id: T })),
    ]);
    assert.deepEqual(currentFlow(s).map((entry) => entry.kind), ["turn_start", "interrupt"]);
  });
});

describe("the sub-agents", () => {
  const started = "2026-11-14T08:00:00Z";
  const sub = (agent: string, extra: Partial<SubAgent> = {}): SubAgent => ({ agent, purpose: `purpose of ${agent}`, state: "waiting", started_at: started, state_since: started, ...extra });
  const subActivity = (agent: string, a: Activity): StreamEvent => ({ event: "activity", data: { agent, activity: a } });
  const subState = (agent: string, s: "thinking" | "waiting"): StreamEvent => ({ event: "state", data: { agent, state: s } });
  const names = (s: State) => subAgentsOf(s).map((a) => a.agent);

  it("lists them in the order the backend gives, and keeps that order as their states change", () => {
    const s = run([
      { type: "agents", agents: [sub("a"), sub("b", { state: "thinking" }), sub("c")] },
      stream(subState("c", "thinking")),
      stream(subState("b", "waiting")),
    ]);
    assert.deepEqual(names(s), ["a", "b", "c"]);
    assert.deepEqual(
      subAgentsOf(s).map((a) => a.status.kind),
      ["waiting", "waiting", "thinking"],
    );
  });

  it("adds one the stream says was started, and drops one it says was closed", () => {
    const s = run([
      { type: "agents", agents: [sub("a")] },
      stream({ event: "agent", data: { agent: "b", purpose: "check the backups", closed: false } }),
      stream({ event: "agent", data: { agent: "a", purpose: "purpose of a", closed: true } }),
    ]);
    assert.deepEqual(names(s), ["b"]);
    assert.equal(subAgentsOf(s)[0]!.purpose, "check the backups");
  });

  it("follows each one's turn apart from the main agent's, with its latest line", () => {
    const at = "2026-11-14T09:00:00Z";
    const s = run([
      { type: "agents", agents: [sub("a"), sub("b")] },
      stream(subState("a", "thinking")),
      stream(subActivity("a", { kind: "turn_start", at, turn_id: "a-1" })),
      stream(subActivity("a", { kind: "thinking", at, turn_id: "a-1", text: "look at the nodes" })),
      stream(subActivity("a", { kind: "tool_call", at, turn_id: "a-1", call_id: "c-1", name: "bash", arguments: { command: "kubectl get nodes", timeout: 60 } })),
    ]);
    const [a, b] = subAgentsOf(s);
    assert.deepEqual(a!.status, { kind: "tool", tool: { name: "bash", detail: "kubectl get nodes" } });
    assert.deepEqual(a!.latest, { kind: "tool_call", text: "bash: kubectl get nodes" });
    assert.deepEqual(
      a!.flow.map((item) => item.kind),
      ["turn_start", "thinking", "tool_call"],
    );
    assert.equal(b!.status.kind, "waiting");
    // The main agent's turn and state are its own.
    assert.equal(statusOf(s).kind, "waiting");
    assert.deepEqual(currentFlow(s), []);
  });

  // The backend tells since when from the turn's blocks; the stream's state has no time.
  it("takes since when it waits from the end of its turn", () => {
    const end = "2026-11-14T10:00:00Z";
    const s = run([
      { type: "agents", agents: [sub("a", { state: "thinking", state_since: "2026-11-14T09:00:00Z" })] },
      stream(subActivity("a", { kind: "turn_end", at: end, turn_id: "a-1" })),
      stream(subState("a", "waiting")),
    ]);
    assert.equal(subAgentsOf(s)[0]!.stateSince, end);
  });

  it("reads the list again as it is when it comes again", () => {
    const s = run([
      { type: "agents", agents: [sub("a"), sub("b")] },
      { type: "stream-open" },
      { type: "agents", agents: [sub("b"), sub("c")] },
    ]);
    assert.deepEqual(names(s), ["b", "c"]);
  });
});

// A tool's call in one line, as the now, the strip and a sub-agent's latest
// line show it. The arguments are an object, as Pi's tools have them
// (pi-coding-agent's tool schemas): what the call is about, not its JSON.
describe("a tool's call in one line", () => {
  it("shows the command of bash, without its timeout", () => {
    assert.equal(callText("bash", { command: "kubectl --kubeconfig /home/agent/.kube/config get nodes", timeout: 120 }), "bash: kubectl --kubeconfig /home/agent/.kube/config get nodes");
  });

  it("shows the path of read, edit, write and ls, without the rest", () => {
    assert.equal(callText("read", { path: "/memory/x.md", offset: 10, limit: 50 }), "read: /memory/x.md");
    assert.equal(callText("edit", { path: "/memory/x.md", edits: [{ oldText: "a", newText: "b" }] }), "edit: /memory/x.md");
    assert.equal(callText("write", { path: "/memory/x.md", content: "a long body\nof the file" }), "write: /memory/x.md");
    assert.equal(callText("ls", { path: "/memory", limit: 100 }), "ls: /memory");
  });

  it("shows what grep and find look for, and where when it is told", () => {
    assert.equal(callText("grep", { pattern: "OOMKilled", path: "/var/log", glob: "*.log", ignoreCase: true }), "grep: OOMKilled in /var/log");
    assert.equal(callText("grep", { pattern: "OOMKilled" }), "grep: OOMKilled");
    assert.equal(callText("find", { pattern: "*.yaml", path: "apps", limit: 20 }), "find: *.yaml in apps");
  });

  it("shows the name alone when there is nothing to show", () => {
    assert.equal(callText("ls", {}), "ls");
    assert.equal(callText("ls", undefined), "ls");
  });

  it("shows the lone string of another tool, else its arguments as short JSON", () => {
    assert.equal(callText("search", { query: "cert-manager 1.19", limit: 5 }), "search: cert-manager 1.19");
    assert.equal(callText("check", "plain words"), "check: plain words");
    assert.equal(callText("vote", { a: 1, b: [2] }), 'vote: {"a":1,"b":[2]}');
  });

  it("names a sub-agent's latest tool call in that line", () => {
    const s = run([
      { type: "agents", agents: [{ agent: "a", purpose: "p", state: "thinking", started_at: "2026-11-14T09:00:00Z", state_since: "2026-11-14T09:00:00Z" }] },
      stream({ event: "activity", data: { agent: "a", activity: { kind: "tool_call", at: "2026-11-14T09:00:01Z", turn_id: "a-1", call_id: "c-1", name: "bash", arguments: { command: "kubectl get nodes", timeout: 30 } } } }),
    ]);
    assert.deepEqual(subAgentsOf(s)[0]!.latest, { kind: "tool_call", text: "bash: kubectl get nodes" });
  });
});
