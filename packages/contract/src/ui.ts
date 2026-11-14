// The backend's API for the Web UI (docs/ui-api.md). It is reworked once the
// screens are agreed with the owner.

import type { Source } from "./events.ts";
import type { Activity, AgentId } from "./sandbox.ts";

/** `POST /api/messages` (JSON, or multipart with files). */
export type PostMessageRequest = { text: string };
/** The id of the `ui` event the message became. */
export type PostMessageResponse = { id: string };

/** The event a reply answers: where it came from and its one line. Never its payload. */
export type Trigger = { source: Source; summary: string };

/** One line of the conversation. */
export type HistoryEntry =
  | { kind: "owner"; id: string; at: string; text: string; agent?: never }
  | { kind: "agent"; id: string; at: string; text: string; agent: AgentId; expression?: string; trigger?: Trigger };

/** `GET /api/history?before=`: newest first. `before` is the cursor of the next, older page. */
export type HistoryResponse = { entries: HistoryEntry[]; before?: string };

/** Whether an agent is in a turn or waiting for events. */
export type AgentState = "thinking" | "waiting";

/** One server-sent event of `GET /api/stream`: `event` is its name, `data` its JSON. */
export type StreamEvent =
  | { event: "reply"; data: Extract<HistoryEntry, { kind: "agent" }> }
  | { event: "activity"; data: { agent: AgentId; activity: Activity } }
  | { event: "state"; data: { agent: AgentId; state: AgentState } };

/** `GET /api/agent`, read without a login: what the UI shows of the agent. */
export type AgentResponse = {
  /** The agent's name, from the backend's settings. */
  name: string;
  /** Where its icon is served, when one is set. */
  icon?: string;
};
