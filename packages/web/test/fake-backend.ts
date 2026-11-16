// A stand-in for the backend's API for the UI (docs/ui-api.md), answered
// through the fetch the App is given. The test writes to the stream as the
// backend would, and drops the line when it wants.
import type { AgentResponse, HistoryEntry, PushSubscriptionRequest, StreamEvent, SubAgent } from "@penelope/contract";

type Line = { write: (text: string) => void; end: () => void };

export class FakeBackend {
  agent: AgentResponse = { name: "Iris" };
  history: HistoryEntry[] = [];
  /** The sub-agents that are not closed, as GET /api/agents lists them. */
  agents: SubAgent[] = [];
  /** How many times GET /api/agents was read. */
  agentsRead = 0;
  signedIn = true;
  /** While down, nothing can be reached. */
  down = false;
  readonly posted: Array<{ text: string; files: string[] }> = [];
  /** The deployment's VAPID public key; without one, there is no Web Push. */
  pushKey: string | undefined = undefined;
  /** The subscriptions registered, by endpoint, as the backend keeps them. */
  readonly subscriptions = new Map<string, PushSubscriptionRequest>();
  readonly streamHeaders: Headers[] = [];
  private lines: Line[] = [];
  private nextId = 1;
  private waiters: Array<() => void> = [];

  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input), "http://ui.example.com");
    const method = init.method ?? "GET";
    if (this.down) throw new TypeError("network down");
    if (url.pathname === "/api/agent") return json(200, this.agent);
    if (url.pathname === "/auth/logout") {
      this.signedIn = false;
      return new Response(null, { status: 204 });
    }
    if (!this.signedIn) return json(401, { error: "not signed in" });
    if (method === "GET" && url.pathname === "/api/history") return json(200, { entries: [...this.history].reverse() });
    if (method === "GET" && url.pathname === "/api/agents") {
      this.agentsRead++;
      return json(200, { agents: this.agents });
    }
    if (method === "GET" && url.pathname === "/api/push") return json(200, this.pushKey === undefined ? {} : { web_push: { public_key: this.pushKey } });
    if (method === "POST" && url.pathname === "/api/push/subscriptions") {
      if (this.pushKey === undefined) return json(503, { error: "web-push-not-configured" });
      const subscription = JSON.parse(String(init.body)) as PushSubscriptionRequest;
      this.subscriptions.set(subscription.endpoint, subscription);
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && url.pathname === "/api/push/subscriptions/delete") {
      this.subscriptions.delete((JSON.parse(String(init.body)) as { endpoint: string }).endpoint);
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && url.pathname === "/api/messages") {
      let text = "";
      let files: string[] = [];
      if (init.body instanceof FormData) {
        text = String(init.body.get("text") ?? "");
        files = init.body.getAll("file").map((file) => (file as File).name);
      } else {
        text = (JSON.parse(String(init.body)) as { text: string }).text;
      }
      this.posted.push({ text, files });
      const id = `m-${this.posted.length}`;
      this.history.push({ kind: "owner", id, at: new Date().toISOString(), text });
      return json(202, { id });
    }
    if (url.pathname === "/api/stream") {
      this.streamHeaders.push(new Headers(init.headers));
      let line!: Line;
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          line = {
            write: (text) => controller.enqueue(encoder.encode(text)),
            end: () => controller.close(),
          };
        },
      });
      this.lines.push(line);
      line.write(": stream\n\n");
      for (const waiter of this.waiters.splice(0)) waiter();
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return json(404, { error: "no such path" });
  };

  /** Waits until the UI has the stream open, `count` times in all. */
  async connected(count = 1): Promise<void> {
    while (this.lines.length < count) await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  send(event: StreamEvent): void {
    this.lines.at(-1)!.write(`id: ${this.nextId++}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
  }

  /** The line drops, and stays down until `up()`. */
  drop(): void {
    this.down = true;
    this.lines.at(-1)?.end();
  }

  up(): void {
    this.down = false;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
