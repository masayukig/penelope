// The stream of replies, activity, state and sub-agents (GET /api/stream), kept open:
// when the line drops it connects again, and each connection asks for all
// the backend kept (Last-Event-ID: 0), so that the state and the turn under
// way are rebuilt from it (docs/ui-api.md).
import type { StreamEvent } from "@penelope/contract";

import type { Fetch } from "./api.ts";
import { SseParser } from "./sse.ts";

export type StreamOptions = {
  fetch: Fetch;
  /** Waits between tries. The tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Connected: what follows is the replay of all the backend kept. */
  onOpen: () => void;
  onEvent: (event: StreamEvent) => void;
  /** The line dropped or could not be made. It is tried again. */
  onDown: () => void;
  /** The session is gone. It is not tried again. */
  onUnauthorized: () => void;
};

/** How long to wait before each try, the last one repeated. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000];
/** The backend sends a comment every 25 seconds; a line quiet for longer is taken as dropped. */
const QUIET_MS = 60_000;

const EVENTS = new Set(["reply", "activity", "state", "agent"]);

export function openStream(options: StreamOptions): { close: () => void } {
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let closed = false;
  let controller: AbortController | undefined;
  let reading: ReadableStreamDefaultReader<string> | undefined;

  const connect = async (): Promise<"opened" | "failed" | "unauthorized"> => {
    controller = new AbortController();
    const current = controller;
    let response: Response;
    try {
      response = await options.fetch("/api/stream", {
        credentials: "same-origin",
        headers: { accept: "text/event-stream", "last-event-id": "0" },
        signal: current.signal,
      });
    } catch {
      return "failed";
    }
    if (response.status === 401) return "unauthorized";
    if (!response.ok || response.body === null) return "failed";
    options.onOpen();
    const parser = new SseParser((event) => {
      if (!EVENTS.has(event.event)) return;
      try {
        options.onEvent({ event: event.event, data: JSON.parse(event.data) } as StreamEvent);
      } catch {
        // A line that is not JSON is not one of the backend's events.
      }
    });
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    reading = reader;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const watch = () => {
      clearTimeout(quiet);
      quiet = setTimeout(() => {
        current.abort();
        void reader.cancel();
      }, QUIET_MS);
    };
    try {
      for (;;) {
        watch();
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(value);
      }
    } catch {
      // Dropped or aborted: the same as an end.
    } finally {
      clearTimeout(quiet);
    }
    return "opened";
  };

  void (async () => {
    let failures = 0;
    while (!closed) {
      const result = await connect();
      if (closed) return;
      if (result === "unauthorized") {
        options.onUnauthorized();
        return;
      }
      failures = result === "opened" ? 0 : failures + 1;
      options.onDown();
      await sleep(BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]!);
    }
  })();

  return {
    close: () => {
      closed = true;
      controller?.abort();
      void reading?.cancel().catch(() => {});
    },
  };
}
