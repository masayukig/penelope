// What the screen shows, kept as one state that actions change: the
// conversation's timeline, what the agent is doing now, and whether the
// stream is up. Plain functions, so that the tests drive it without a DOM.
import type { Activity, AgentState, HistoryEntry, StreamEvent } from "@penelope/contract";

export type Connection = "connecting" | "online" | "offline";

/** A file sent with a message, as this browser still has it. */
export type LocalFile = { name: string; type: string; size: number; url?: string };

export type OwnerItem = {
  kind: "owner";
  /** The backend's id once it has taken the message; until then, the local key. */
  id: string;
  key: string;
  at: string;
  text: string;
  files: LocalFile[];
  delivery: "sent" | "queued" | "sending" | "failed";
  /** Sent while she was in a turn: it steers that turn. */
  duringTurn: boolean;
};
export type AgentItem = Extract<HistoryEntry, { kind: "agent" }> & { key: string };
export type TimelineItem = OwnerItem | AgentItem;

export type Interrupt = { key: string; at: string; text: string };

/** One line of the turn's flow: a block of the turn, or the owner's message that came into it. */
export type FlowItem = Activity | { kind: "interrupt"; at: string; text: string; key: string };

export type State = {
  items: TimelineItem[];
  /** The cursor of the next, older page of the history. */
  before: string | undefined;
  historyRead: boolean;
  agentState: AgentState;
  /** The blocks of the turn under way, from its turn_start. */
  turn: Activity[];
  interrupts: Interrupt[];
  connection: Connection;
  signedIn: boolean | undefined;
};

export const initialState: State = {
  items: [],
  before: undefined,
  historyRead: false,
  agentState: "waiting",
  turn: [],
  interrupts: [],
  connection: "connecting",
  signedIn: undefined,
};

export type Action =
  | { type: "history"; entries: HistoryEntry[]; before?: string; older?: boolean }
  | { type: "stream-open" }
  | { type: "stream"; event: StreamEvent }
  | { type: "connection"; state: Connection }
  | { type: "signed-in" }
  | { type: "unauthorized" }
  | { type: "queued"; key: string; at: string; text: string; files: LocalFile[]; duringTurn: boolean }
  | { type: "queued-again"; key: string }
  | { type: "sending"; key: string }
  | { type: "sent"; key: string; id: string }
  | { type: "failed"; key: string };

export function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "history": {
      // A page comes newest first; taken oldest first, lines of the same time keep their order.
      const items = merge(state.items, [...action.entries].reverse().map(fromHistory));
      // The first page sets where the older pages start; reading it again
      // (after the stream comes back) leaves the paging where it is.
      const before = action.older || !state.historyRead ? action.before : state.before;
      return { ...state, items, before, historyRead: true, signedIn: true };
    }
    case "stream-open":
      // The backend replays all it kept: what was known is rebuilt from it.
      return { ...state, agentState: "waiting", turn: [], connection: "online", signedIn: true };
    case "stream":
      return onStream(state, action.event);
    case "connection":
      return { ...state, connection: action.state };
    case "signed-in":
      return { ...state, signedIn: true };
    case "unauthorized":
      return { ...state, signedIn: false };
    case "queued": {
      const item: OwnerItem = {
        kind: "owner",
        id: action.key,
        key: action.key,
        at: action.at,
        text: action.text,
        files: action.files,
        delivery: "queued",
        duringTurn: action.duringTurn,
      };
      const interrupts = action.duringTurn ? [...state.interrupts, { key: action.key, at: action.at, text: action.text }] : state.interrupts;
      return { ...state, items: [...state.items, item], interrupts };
    }
    case "queued-again":
      return withOwner(state, action.key, { delivery: "queued" });
    case "sending":
      return withOwner(state, action.key, { delivery: "sending" });
    case "sent": {
      // The history read again may already hold it under its id.
      const items = state.items.filter((item) => item.id !== action.id || item.key === action.key);
      return withOwner({ ...state, items }, action.key, { delivery: "sent", id: action.id });
    }
    case "failed":
      return withOwner(state, action.key, { delivery: "failed" });
  }
}

function onStream(state: State, event: StreamEvent): State {
  switch (event.event) {
    case "reply":
      return { ...state, items: merge(state.items, [fromHistory(event.data)]) };
    case "state":
      // Sub-agents get a column of their own later; the screen shows the main agent.
      if (event.data.agent !== "main") return state;
      return { ...state, agentState: event.data.state };
    case "activity": {
      if (event.data.agent !== "main") return state;
      const activity = event.data.activity;
      if (activity.kind === "turn_start") return { ...state, turn: [activity] };
      return { ...state, turn: [...state.turn, activity] };
    }
  }
}

function fromHistory(entry: HistoryEntry): TimelineItem {
  if (entry.kind === "agent") return { ...entry, key: entry.id };
  return { kind: "owner", id: entry.id, key: entry.id, at: entry.at, text: entry.text, files: [], delivery: "sent", duringTurn: false };
}

/** The items with the incoming ones put in, each id once, in time order. */
function merge(items: TimelineItem[], incoming: TimelineItem[]): TimelineItem[] {
  const result = [...items];
  for (const item of incoming) {
    const at = result.findIndex((known) => known.id === item.id);
    if (at < 0) {
      result.push(item);
      continue;
    }
    const known = result[at]!;
    // What only this browser knows of its own message stays: its files and
    // that it came mid-turn.
    result[at] = known.kind === "owner" && item.kind === "owner" ? { ...item, key: known.key, files: known.files, duringTurn: known.duringTurn } : { ...item, key: known.key };
  }
  // Messages not yet taken by the backend stay last, in the order written.
  const taken = result.filter((item) => !(item.kind === "owner" && item.delivery !== "sent"));
  const waiting = result.filter((item) => item.kind === "owner" && item.delivery !== "sent");
  taken.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return [...taken, ...waiting];
}

function withOwner(state: State, key: string, change: Partial<OwnerItem>): State {
  return { ...state, items: state.items.map((item) => (item.kind === "owner" && item.key === key ? { ...item, ...change } : item)) };
}

export type Status =
  | { kind: "offline" }
  | { kind: "waiting" }
  | { kind: "thinking" }
  | { kind: "tool"; tool: { name: string; detail: string } };

export function statusOf(state: State): Status {
  if (state.connection === "offline") return { kind: "offline" };
  if (state.agentState === "waiting") return { kind: "waiting" };
  const done = new Set(state.turn.flatMap((a) => (a.kind === "tool_result" ? [a.call_id] : [])));
  const open = state.turn.findLast((a) => a.kind === "tool_call" && !done.has(a.call_id));
  if (open?.kind === "tool_call") return { kind: "tool", tool: { name: open.name, detail: argumentsText(open.arguments) } };
  return { kind: "thinking" };
}

/** The turn under way, with the owner's messages that came into it. Nothing while she waits. */
export function currentFlow(state: State): FlowItem[] {
  if (state.agentState === "waiting") return [];
  const start = state.turn[0];
  const since = start === undefined ? Number.POSITIVE_INFINITY : Date.parse(start.at);
  const interrupts: FlowItem[] = state.interrupts.filter((i) => Date.parse(i.at) >= since).map((i) => ({ kind: "interrupt", ...i }));
  const flow: FlowItem[] = [...state.turn];
  for (const interrupt of interrupts) {
    const at = flow.findIndex((item) => Date.parse(item.at) > Date.parse(interrupt.at));
    if (at < 0) flow.push(interrupt);
    else flow.splice(at, 0, interrupt);
  }
  return flow;
}

/** How long the face of a reply is shown before the avatar goes back to neutral: natsumi's three minutes. */
export const FACE_RESET_MS = 3 * 60_000;

/**
 * The face the avatar shows now: that of her latest reply that has one,
 * until it has been shown for FACE_RESET_MS. Undefined is neutral.
 */
export function faceOf(state: State, now: number): string | undefined {
  for (let i = state.items.length - 1; i >= 0; i--) {
    const item = state.items[i]!;
    if (item.kind !== "agent" || item.expression === undefined) continue;
    return now - Date.parse(item.at) < FACE_RESET_MS ? item.expression : undefined;
  }
  return undefined;
}

/** A tool's arguments in one line: a lone string as it is (a command, a path), else JSON. */
export function argumentsText(args: unknown): string {
  if (typeof args === "string") return args;
  if (args !== null && typeof args === "object") {
    const values = Object.values(args);
    if (values.length === 1 && typeof values[0] === "string") return values[0];
  }
  return JSON.stringify(args) ?? "";
}
