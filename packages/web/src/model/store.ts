// What the screen shows, kept as one state that actions change: the
// conversation's timeline, what the agent is doing now, and whether the
// stream is up. Plain functions, so that the tests drive it without a DOM.
import type { Activity, AgentState, HistoryEntry, OwnerFiles, StreamEvent, SubAgent } from "@penelope/contract";

import { assetUrl } from "./api.ts";

export type Connection = "connecting" | "online" | "offline";

/**
 * A file sent with a message: as this browser still has it until the backend
 * takes the message, then as the backend keeps it (ADR-0034), an image by the
 * URL of its copy.
 */
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
  /** The sub-agents that are not closed, in the order they were started. */
  subAgents: SubAgentEntry[];
  /** The blocks of each sub-agent's turn under way, by its name. */
  subTurns: Record<string, Activity[]>;
};

/** A sub-agent as the screen keeps it: times are RFC 3339. */
export type SubAgentEntry = { agent: string; purpose: string; state: AgentState; startedAt: string; stateSince: string };

export const initialState: State = {
  items: [],
  before: undefined,
  historyRead: false,
  agentState: "waiting",
  turn: [],
  interrupts: [],
  connection: "connecting",
  signedIn: undefined,
  subAgents: [],
  subTurns: {},
};

export type Action =
  | { type: "history"; entries: HistoryEntry[]; before?: string; older?: boolean }
  | { type: "stream-open" }
  | { type: "stream"; event: StreamEvent }
  /** GET /api/agents, read on each connection. */
  | { type: "agents"; agents: SubAgent[] }
  | { type: "connection"; state: Connection }
  | { type: "signed-in" }
  | { type: "unauthorized" }
  | { type: "queued"; key: string; at: string; text: string; files: LocalFile[]; duringTurn: boolean }
  | { type: "queued-again"; key: string }
  | { type: "sending"; key: string }
  /** The backend took it, keeping its files as it says. */
  | ({ type: "sent"; key: string; id: string } & OwnerFiles)
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
      // The sub-agents themselves are read again (GET /api/agents): they
      // outlive what the replay holds.
      return { ...state, agentState: "waiting", turn: [], subTurns: {}, connection: "online", signedIn: true };
    case "stream":
      return onStream(state, action.event);
    case "agents":
      return {
        ...state,
        subAgents: action.agents.map((a) => ({ agent: a.agent, purpose: a.purpose, state: a.state, startedAt: a.started_at, stateSince: a.state_since })),
      };
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
      const kept = filesOf(action);
      return withOwner({ ...state, items }, action.key, { delivery: "sent", id: action.id, ...(kept.length === 0 ? {} : { files: kept }) });
    }
    case "failed":
      return withOwner(state, action.key, { delivery: "failed" });
  }
}

function onStream(state: State, event: StreamEvent): State {
  switch (event.event) {
    case "reply":
      return { ...state, items: merge(state.items, [fromHistory(event.data)]) };
    case "state": {
      const { agent, state: next } = event.data;
      if (agent === "main") return { ...state, agentState: next };
      // The stream's state has no time: it changed when it came.
      return withSubAgent(state, agent, (a) => (a.state === next ? a : { ...a, state: next, stateSince: new Date().toISOString() }));
    }
    case "activity": {
      const { agent, activity } = event.data;
      if (agent === "main") {
        if (activity.kind === "turn_start") return { ...state, turn: [activity] };
        return { ...state, turn: [...state.turn, activity] };
      }
      const known = state.subTurns[agent] ?? [];
      const subTurns = { ...state.subTurns, [agent]: activity.kind === "turn_start" ? [activity] : [...known, activity] };
      // A turn's start and end tell the time of the state, as the backend takes it.
      if (activity.kind === "turn_start") return withSubAgent({ ...state, subTurns }, agent, (a) => ({ ...a, state: "thinking", stateSince: activity.at }));
      if (activity.kind === "turn_end") return withSubAgent({ ...state, subTurns }, agent, (a) => ({ ...a, state: "waiting", stateSince: activity.at }));
      return { ...state, subTurns };
    }
    case "agent": {
      const { agent, purpose, closed } = event.data;
      if (closed) {
        const { [agent]: _, ...subTurns } = state.subTurns;
        return { ...state, subAgents: state.subAgents.filter((a) => a.agent !== agent), subTurns };
      }
      if (state.subAgents.some((a) => a.agent === agent)) return state;
      const now = new Date().toISOString();
      return { ...state, subAgents: [...state.subAgents, { agent, purpose, state: "waiting", startedAt: now, stateSince: now }] };
    }
    // The activity record's unseen failures are not shown yet.
    case "record":
      return state;
  }
}

function withSubAgent(state: State, agent: string, change: (a: SubAgentEntry) => SubAgentEntry): State {
  return { ...state, subAgents: state.subAgents.map((a) => (a.agent === agent ? change(a) : a)) };
}

function fromHistory(entry: HistoryEntry): TimelineItem {
  if (entry.kind === "agent") return { ...entry, key: entry.id };
  return { kind: "owner", id: entry.id, key: entry.id, at: entry.at, text: entry.text, files: filesOf(entry), delivery: "sent", duringTurn: false };
}

/** The files the backend keeps of an owner's message: the copied images first, then the others by name. */
function filesOf({ images = [], files = [] }: OwnerFiles): LocalFile[] {
  return [
    ...images.map((image) => ({ name: image.name, type: image.mime_type, size: image.size, url: assetUrl(image.id) })),
    ...files.map((file) => ({ name: file.name, type: "", size: file.size })),
  ];
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
    // What only this browser knows of its own message stays: that it came
    // mid-turn, and its files when the backend kept none of them (a message
    // from before it kept them).
    result[at] =
      known.kind === "owner" && item.kind === "owner"
        ? { ...item, key: known.key, files: item.files.length > 0 ? item.files : known.files, duringTurn: known.duringTurn }
        : { ...item, key: known.key };
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
  return turnStatus(state.agentState, state.turn);
}

function turnStatus(agentState: AgentState, turn: Activity[]): Exclude<Status, { kind: "offline" }> {
  if (agentState === "waiting") return { kind: "waiting" };
  const done = new Set(turn.flatMap((a) => (a.kind === "tool_result" ? [a.call_id] : [])));
  const open = turn.findLast((a) => a.kind === "tool_call" && !done.has(a.call_id));
  if (open?.kind === "tool_call") return { kind: "tool", tool: { name: open.name, detail: argumentsText(open.arguments) } };
  return { kind: "thinking" };
}

/** A sub-agent as its column shows it. */
export type SubAgentView = SubAgentEntry & {
  status: Exclude<Status, { kind: "offline" }>;
  /** The latest block of its turn, in one line; none while it waits. */
  latest: LatestLine | undefined;
  /** The blocks of its turn under way; none while it waits. */
  flow: Activity[];
};

export function subAgentsOf(state: State): SubAgentView[] {
  return state.subAgents.map((a) => {
    const flow = a.state === "waiting" ? [] : (state.subTurns[a.agent] ?? []);
    return { ...a, status: turnStatus(a.state, flow), latest: latestLine(flow), flow };
  });
}

/** How many sub-agents run and how many wait. */
export function subAgentCounts(state: State): { running: number; waiting: number } {
  const waiting = state.subAgents.filter((a) => a.state === "waiting").length;
  return { running: state.subAgents.length - waiting, waiting };
}

export type LatestLine = { kind: "tool_call" | "thinking" | "message"; text: string };

function latestLine(flow: Activity[]): LatestLine | undefined {
  for (let i = flow.length - 1; i >= 0; i--) {
    const block = flow[i]!;
    if (block.kind === "tool_call") return { kind: "tool_call", text: callText(block.name, block.arguments) };
    if (block.kind === "thinking" || block.kind === "message") return { kind: block.kind, text: firstLine(block.text) };
  }
  return undefined;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
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

/** The face of the avatar while she is in a turn, as natsumi's. */
export const THINKING_FACE = "thinking";

/**
 * The face the avatar shows now: thinking while she is in a turn; else that
 * of her latest reply that has one, until it has been shown for
 * FACE_RESET_MS. Undefined is neutral.
 */
export function faceOf(state: State, now: number): string | undefined {
  const status = statusOf(state).kind;
  if (status === "thinking" || status === "tool") return THINKING_FACE;
  for (let i = state.items.length - 1; i >= 0; i--) {
    const item = state.items[i]!;
    if (item.kind !== "agent" || item.expression === undefined) continue;
    return now - Date.parse(item.at) < FACE_RESET_MS ? item.expression : undefined;
  }
  return undefined;
}

/** A tool's call in one line: its name, and what it is about when there is something to show. */
export function callText(name: string, args: unknown): string {
  const what = argumentsText(args);
  return what === "" ? name : `${name}: ${what}`;
}

/**
 * A tool's arguments in one line, as Pi's tools have them: bash's command;
 * what grep and find look for, and where; the path of read, edit, write and
 * ls; else a lone string (a query); else short JSON. Nothing for no arguments.
 */
export function argumentsText(args: unknown): string {
  if (typeof args === "string") return args;
  if (args === null || args === undefined) return "";
  if (typeof args !== "object" || Array.isArray(args)) return JSON.stringify(args) ?? "";
  const record = args as Record<string, unknown>;
  const str = (key: string) => (typeof record[key] === "string" ? (record[key] as string) : undefined);
  const command = str("command");
  if (command !== undefined) return command;
  const pattern = str("pattern");
  const path = str("path");
  if (pattern !== undefined) return path !== undefined ? `${pattern} in ${path}` : pattern;
  if (path !== undefined) return path;
  const values = Object.values(record);
  if (values.length === 0) return "";
  const strings = values.filter((value): value is string => typeof value === "string");
  if (strings.length === 1) return strings[0]!;
  return JSON.stringify(args);
}
