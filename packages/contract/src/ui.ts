// The backend's API for the Web UI (docs/ui-api.md). It is reworked once the
// screens are agreed with the owner.

import type { Source } from "./events.ts";
import type { Activity, AgentId, ScheduleWhen, SubAgentStatus } from "./sandbox.ts";

/** `POST /api/messages` (JSON, or multipart with files). */
export type PostMessageRequest = { text: string };
/** The id of the `ui` event the message became. */
export type PostMessageResponse = { id: string };

/** The event a reply answers: where it came from and its one line. Never its payload. */
export type Trigger = { source: Source; summary: string };

/**
 * An image the backend copied when a reply carried it (ADR-0032). Its bytes are
 * `GET /api/assets/<id>`, and never change.
 */
export type ReplyImage = {
  id: string;
  /** PNG, JPEG, GIF or WebP, from its first bytes. */
  mime_type: string;
  /** Bytes. */
  size: number;
  /** The name of the file it was copied from, without its directory. */
  name: string;
};

/** One line of the conversation. */
export type HistoryEntry =
  | { kind: "owner"; id: string; at: string; text: string; agent?: never }
  | {
      kind: "agent";
      id: string;
      at: string;
      text: string;
      agent: AgentId;
      expression?: string;
      trigger?: Trigger;
      /** The images it carries, in the order sent. Missing when there are none. */
      images?: ReplyImage[];
    };

/** `GET /api/history?before=`: newest first. `before` is the cursor of the next, older page. */
export type HistoryResponse = { entries: HistoryEntry[]; before?: string };

/** Whether an agent is in a turn or waiting for events. */
export type AgentState = "thinking" | "waiting";

/** One server-sent event of `GET /api/stream`: `event` is its name, `data` its JSON. */
export type StreamEvent =
  | { event: "reply"; data: Extract<HistoryEntry, { kind: "agent" }> }
  | { event: "activity"; data: { agent: AgentId; activity: Activity } }
  | { event: "state"; data: { agent: AgentId; state: AgentState } }
  /** A sub-agent was started or closed. */
  | { event: "agent"; data: SubAgentStatus };

/** One sub-agent that is not closed, as `GET /api/agents` lists it. */
export type SubAgent = {
  agent: AgentId;
  purpose: string;
  state: AgentState;
  /** RFC 3339: when the runner first said it was started. */
  started_at: string;
  /** RFC 3339: since when it is in `state`; when it was started if it has had no turn. */
  state_since: string;
};

/** `GET /api/agents`: the sub-agents that are not closed. */
export type SubAgentsResponse = { agents: SubAgent[] };

/**
 * One of her schedules, as `GET /api/schedules` lists it: what her
 * `schedule_list` lists, and when it comes due next (RFC 3339).
 */
export type ScheduleEntry = { id: string; reason: string; next_at: string } & ScheduleWhen;

/** `GET /api/schedules`: her schedules, in the order she made them. */
export type SchedulesResponse = { schedules: ScheduleEntry[] };

/** `GET /api/agent`, read without a login: what the UI shows of the agent. */
export type AgentResponse = {
  /** The agent's name, from the backend's settings. */
  name: string;
  /** Where each face of her avatar is served, by expression, when an avatar is chosen. */
  icons?: Record<string, string>;
  /** Where the PNG of each face that has one is served, by expression: for Slack's icon_url. */
  png_icons?: Record<string, string>;
};

/**
 * `GET /api/push`: the kinds of notice the backend can send, with what a
 * browser needs to subscribe. A kind is missing when the deployment does not
 * set it up (ADR-0027).
 */
export type PushResponse = {
  /** Web Push: the VAPID public key, uncompressed P-256 in base64url. */
  web_push?: { public_key: string };
};

/**
 * `POST /api/push/subscriptions`: one place to send the notices to. The first
 * kind is Web Push, the browser's `PushSubscription.toJSON()`; the same
 * endpoint again replaces the keys it had.
 */
export type PushSubscriptionRequest = {
  kind: "web-push";
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

/** `POST /api/push/subscriptions/delete`: stop sending to this endpoint. */
export type PushUnsubscribeRequest = { endpoint: string };

/**
 * What one notice of a reply carries, whatever the kind it is sent by: what
 * the Web Push is, as JSON, after it is decrypted.
 */
export type Notice = {
  /** The id of the reply, as in the history. */
  id: string;
  /** The agent's name, from the backend's settings. */
  agent: string;
  /** The head of the reply, cut short (docs/ui-api.md, "知らせ"). */
  text: string;
  expression?: string;
  /** How many images the reply has, when it has any (ADR-0032). */
  images?: number;
};
