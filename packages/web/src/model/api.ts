// The backend's API for the UI (docs/ui-api.md), over a fetch that the tests
// replace.
import type { AgentResponse, HistoryResponse, PostMessageResponse } from "@penelope/contract";

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
  history(before?: string): Promise<HistoryResponse>;
  send(text: string, files: readonly File[]): Promise<PostMessageResponse>;
  logout(): Promise<void>;
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
  };
}
