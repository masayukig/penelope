// The backend's API for the Web UI (docs/ui-api.md). It is reworked once the
// screens are agreed with the owner.

import type { Source } from "./events.ts";
import type { Activity, AgentId, SubAgentStatus } from "./sandbox.ts";

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

/** `GET /api/agent`, read without a login: what the UI shows of the agent. */
export type AgentResponse = {
  /** The agent's name, from the backend's settings. */
  name: string;
  /** Where each face of her avatar is served, by expression, when an avatar is chosen. */
  icons?: Record<string, string>;
};
