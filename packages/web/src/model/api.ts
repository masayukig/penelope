// The backend's API for the UI (docs/ui-api.md), over a fetch that the tests
// replace.
import type {
  AgentResponse,
  HistoryResponse,
  PostMessageResponse,
  PushResponse,
  PushSubscriptionRequest,
  PushUnsubscribeRequest,
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
};

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
  };
}
