// The backend's API for the UI (docs/ui-api.md), over a fetch that the tests
// replace.
import type {
  AgentResponse,
  HistoryResponse,
  PostMessageResponse,
  PushResponse,
  PushSubscriptionRequest,
  PushUnsubscribeRequest,
  RecordDayResponse,
  RecordKind,
  RecordNightResponse,
  RecordResultResponse,
  RecordSeenResponse,
  RecordSubAgentResponse,
  RecordTurnResponse,
  RecordUnseenResponse,
  SchedulesResponse,
  SubAgentsResponse,
} from "@penelope/contract";

/** Where the bytes of a copy the backend keeps are read: an image of a reply (ADR-0032). They never change. */
export function assetUrl(id: string): string {
  return `/api/assets/${encodeURIComponent(id)}`;
}

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The session is gone or never was: the owner has to log in. */
export class Unauthorized extends Error {}
/** The backend could not be reached. */
export class Unreachable extends Error {}
/** The backend answered with a refusal. */
export class Refused extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Api = {
  agent(): Promise<AgentResponse>;
  /** The sub-agents that are not closed. */
  agents(): Promise<SubAgentsResponse>;
  history(before?: string): Promise<HistoryResponse>;
  send(text: string, files: readonly File[]): Promise<PostMessageResponse>;
  logout(): Promise<void>;
  /** The kinds of notice the deployment sends, with the key to subscribe with. */
  push(): Promise<PushResponse>;
  subscribePush(subscription: PushSubscriptionRequest): Promise<void>;
  unsubscribePush(endpoint: string): Promise<void>;
  /** Her schedules, with when each comes due next. */
  schedules(): Promise<SchedulesResponse>;
  /** Removes one of her schedules; Refused with 404 when it is already gone. */
  removeSchedule(id: string): Promise<void>;
  /** One day of the activity record, newest first, narrowed as asked; today when no day is given. */
  record(query: RecordQuery): Promise<RecordDayResponse>;
  recordTurn(id: string): Promise<RecordTurnResponse>;
  /** The whole output of one tool's result in a turn; Refused with 404 when it is gone. */
  recordResult(turn: string, call: string): Promise<RecordResultResponse>;
  recordNight(id: string): Promise<RecordNightResponse>;
  recordSubAgent(name: string, before?: string): Promise<RecordSubAgentResponse>;
  /** How many failures the owner has not seen. */
  recordUnseen(): Promise<RecordUnseenResponse>;
  /** The owner opened the record now: what was unseen until now, and when she opened it before. */
  recordSeen(): Promise<RecordSeenResponse>;
};

/** The narrowing of `GET /api/record` (docs/ui-api.md, "活動の記録"). */
export type RecordQuery = { day?: string; tz: string; failed?: boolean; agent?: string; kind?: RecordKind };

export function createApi(fetch: Fetch): Api {
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    let response: Response;
    try {
      response = await fetch(path, { credentials: "same-origin", ...init });
    } catch (error) {
      throw new Unreachable(error instanceof Error ? error.message : String(error));
    }
    if (response.status === 401) throw new Unauthorized();
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Refused(response.status, body.error ?? response.statusText);
    }
    return response;
  };

  return {
    agent: async () => (await call("/api/agent")).json() as Promise<AgentResponse>,
    agents: async () => (await call("/api/agents")).json() as Promise<SubAgentsResponse>,
    history: async (before) =>
      (await call(before === undefined ? "/api/history" : `/api/history?before=${encodeURIComponent(before)}`)).json() as Promise<HistoryResponse>,
    send: async (text, files) => {
      let init: RequestInit;
      if (files.length === 0) {
        init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) };
      } else {
        const form = new FormData();
        form.append("text", text);
        for (const file of files) form.append("file", file, file.name);
        init = { method: "POST", body: form };
      }
      return (await call("/api/messages", init)).json() as Promise<PostMessageResponse>;
    },
    logout: async () => {
      await call("/auth/logout", { method: "POST" });
    },
    push: async () => (await call("/api/push")).json() as Promise<PushResponse>,
    subscribePush: async (subscription) => {
      await call("/api/push/subscriptions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(subscription) });
    },
    unsubscribePush: async (endpoint) => {
      const body: PushUnsubscribeRequest = { endpoint };
      await call("/api/push/subscriptions/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    },
    schedules: async () => (await call("/api/schedules")).json() as Promise<SchedulesResponse>,
    removeSchedule: async (id) => {
      await call(`/api/schedules/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
    record: async ({ day, tz, failed, agent, kind }) => {
      const query = new URLSearchParams({ tz });
      if (day !== undefined) query.set("day", day);
      if (failed) query.set("failed", "1");
      if (agent !== undefined) query.set("agent", agent);
      if (kind !== undefined) query.set("kind", kind);
      return (await call(`/api/record?${query}`)).json() as Promise<RecordDayResponse>;
    },
    recordTurn: async (id) => (await call(`/api/record/turns/${encodeURIComponent(id)}`)).json() as Promise<RecordTurnResponse>,
    recordResult: async (turn, callId) =>
      (await call(`/api/record/turns/${encodeURIComponent(turn)}/results/${encodeURIComponent(callId)}`)).json() as Promise<RecordResultResponse>,
    recordNight: async (id) => (await call(`/api/record/nights/${encodeURIComponent(id)}`)).json() as Promise<RecordNightResponse>,
    recordSubAgent: async (name, before) =>
      (
        await call(`/api/record/sub-agents/${encodeURIComponent(name)}${before === undefined ? "" : `?before=${encodeURIComponent(before)}`}`)
      ).json() as Promise<RecordSubAgentResponse>,
    recordUnseen: async () => (await call("/api/record/unseen")).json() as Promise<RecordUnseenResponse>,
    recordSeen: async () => (await call("/api/record/seen", { method: "POST" })).json() as Promise<RecordSeenResponse>,
  };
}
