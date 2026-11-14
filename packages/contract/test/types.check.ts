// Type tests for the contract. They have no runtime part: `npm run typecheck`
// is the test. Each `satisfies` is a value the contract must accept, and each
// `@ts-expect-error` is one it must reject (tsc fails if the error goes away).

import type {
  AckRequest,
  Activity,
  ActivityRequest,
  ControlPayload,
  CronPayload,
  DeliveredEvent,
  ErrorBody,
  Event,
  HistoryEntry,
  HistoryResponse,
  PollResponse,
  PostMessageRequest,
  PostMessageResponse,
  ReplyRequest,
  ReplyResponse,
  Schedule,
  ScheduleListResponse,
  ScheduleRequest,
  SelfEventRequest,
  SessionRotatedRequest,
  SourcesLine,
  StreamEvent,
  TurnEndRequest,
} from "../src/index.ts";

// --- The envelope (docs/events.md) ---

export const minimal = {
  source: "alertmanager",
  id: "a-1",
  occurred_at: "2026-11-14T09:00:00Z",
  summary: "1 alert firing",
  payload: { anything: ["goes", 1, null] },
} satisfies Event;

export const slack = {
  source: "slack",
  id: "C0123:1731574800.000100",
  occurred_at: "2026-11-14T09:00:00Z",
  summary: "#ops: a mention",
  stream: "ops",
  delivery: "now",
  payload: { type: "message", ts: "1731574800.000100" },
} satisfies Event;

// @ts-expect-error delivery is "now" or "batch"
export const badDelivery = { ...minimal, delivery: "later" } satisfies Event;

// @ts-expect-error summary is required
export const noSummary = { source: "x", id: "1", occurred_at: "t", payload: 1 } satisfies Event;

export const nightly = { kind: "nightly" } satisfies ControlPayload;
// @ts-expect-error the only control event so far is nightly
export const badControl = { kind: "reboot" } satisfies ControlPayload;

export const line = {
  seq: 12,
  received_at: "2026-11-14T09:00:01Z",
  occurred_at: "2026-11-14T09:00:00Z",
  source: "slack",
  stream: "ops",
  id: "C0123:1731574800.000100",
  summary: "#ops: a mention",
  attachments: ["/sources/slack/files/12-diagram.png"],
  payload: { type: "message", ts: "1731574800.000100" },
} satisfies SourcesLine;
// @ts-expect-error a line carries the backend's seq
export const lineWithoutSeq = { ...minimal, received_at: "t" } satisfies SourcesLine;

export const fired = { schedule_id: "s-1", reason: "look at the CI again" } satisfies CronPayload;

// --- The sandbox's API (docs/sandbox-api.md) ---

export const notice = {
  seq: 12,
  source: "slack",
  id: "C0123:1731574800.000100",
  stream: "ops",
  occurred_at: "2026-11-14T09:00:00Z",
  received_at: "2026-11-14T09:00:01Z",
  summary: "#ops: a mention",
  delivery: "now",
  inline: false,
  appended: { path: "/sources/slack/ops/2026-11-14.jsonl", lines: [3, 3] },
} satisfies DeliveredEvent;

export const inlineUi = {
  seq: 13,
  source: "ui",
  id: "m-1",
  occurred_at: "2026-11-14T09:01:00Z",
  received_at: "2026-11-14T09:01:00Z",
  summary: "hello",
  delivery: "now",
  inline: true,
  payload: { text: "hello" },
  appended: { path: "/sources/ui/2026-11-14.jsonl", lines: [1, 1] },
  attachments: ["/sources/ui/files/13-screenshot.png"],
} satisfies DeliveredEvent;

// @ts-expect-error an inline event carries its payload
export const inlineWithoutPayload = { ...notice, inline: true } satisfies DeliveredEvent;

// @ts-expect-error an event that is not inline does not carry its payload
export const noticeWithPayload = { ...notice, payload: {} } satisfies DeliveredEvent;

export const poll = { events: [notice, inlineUi] } satisfies PollResponse;
export const emptyPoll = { events: [] } satisfies PollResponse;

export const ack = { agent: "main", seqs: [12, 13] } satisfies AckRequest;
// @ts-expect-error every request names its agent
export const ackWithoutAgent = { seqs: [12] } satisfies AckRequest;

export const self = {
  agent: "main",
  id: "child-7-done",
  summary: "the child finished the review",
  payload: { result: "ok" },
} satisfies SelfEventRequest;

export const reply = {
  agent: "main",
  text: "done",
  expression: "smile",
  in_reply_to: 13,
} satisfies ReplyRequest;
export const replyCreated = { id: "r-1" } satisfies ReplyResponse;

const at = "2026-11-14T09:01:02Z";
export const activities = [
  { kind: "turn_start", at, turn_id: "t-1" },
  { kind: "thinking", at, turn_id: "t-1", text: "..." },
  { kind: "tool_call", at, turn_id: "t-1", call_id: "c-1", name: "bash", arguments: { command: "ls" } },
  { kind: "tool_result", at, turn_id: "t-1", call_id: "c-1", is_error: false, output: "a\nb\n" },
  { kind: "message", at, turn_id: "t-1", text: "done" },
  { kind: "turn_end", at, turn_id: "t-1" },
] satisfies Activity[];

// @ts-expect-error a tool call names its tool
export const toolCallWithoutName = { kind: "tool_call", at, turn_id: "t-1", call_id: "c-1", arguments: {} } satisfies Activity;
// @ts-expect-error tokens are not sent one by one
export const token = { kind: "token", at, turn_id: "t-1", text: "a" } satisfies Activity;

export const activityRequest = { agent: "main", activities } satisfies ActivityRequest;
export const turnEnd = { agent: "main", turn_id: "t-1" } satisfies TurnEndRequest;

export const byCron = { agent: "main", reason: "every morning", cron: "0 9 * * *" } satisfies ScheduleRequest;
export const byTime = { agent: "main", reason: "once", at: "2026-11-15T09:00:00Z" } satisfies ScheduleRequest;
// @ts-expect-error a schedule is a cron expression or a time, not both
export const both = { agent: "main", reason: "x", cron: "0 9 * * *", at } satisfies ScheduleRequest;
// @ts-expect-error a schedule needs one of them
export const neither = { agent: "main", reason: "x" } satisfies ScheduleRequest;

export const schedule = { id: "s-1", agent: "main", reason: "every morning", cron: "0 9 * * *" } satisfies Schedule;
export const schedules = { schedules: [schedule] } satisfies ScheduleListResponse;

export const rotated = { agent: "main" } satisfies SessionRotatedRequest;

export const error = { error: "seqs must be a list of integers" } satisfies ErrorBody;

// --- The UI's API (docs/ui-api.md) ---

export const post = { text: "hello" } satisfies PostMessageRequest;
export const posted = { id: "m-1" } satisfies PostMessageResponse;

export const ownerEntry = { kind: "owner", id: "m-1", at, text: "hello" } satisfies HistoryEntry;
export const agentEntry = {
  kind: "agent",
  id: "r-1",
  at,
  text: "done",
  agent: "main",
  expression: "smile",
} satisfies HistoryEntry;
// @ts-expect-error the owner's message has no agent
export const ownerWithAgent = { ...ownerEntry, agent: "main" } satisfies HistoryEntry;

export const history = { entries: [agentEntry, ownerEntry], before: "opaque" } satisfies HistoryResponse;
export const lastPage = { entries: [] } satisfies HistoryResponse;

export const streamed = [
  { event: "reply", data: agentEntry },
  { event: "activity", data: { agent: "main", activity: { kind: "turn_start", at, turn_id: "t-1" } } },
  { event: "state", data: { agent: "main", state: "thinking" } },
  { event: "state", data: { agent: "main", state: "waiting" } },
] satisfies StreamEvent[];

// @ts-expect-error the states are thinking and waiting
export const sleeping = { event: "state", data: { agent: "main", state: "sleeping" } } satisfies StreamEvent;
