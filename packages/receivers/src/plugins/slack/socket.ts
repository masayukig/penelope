// A Socket Mode connection (https://docs.slack.dev/apis/events-api/using-socket-mode),
// kept open until stopped. Each connection's URL comes from
// apps.connections.open; Slack greets it with `hello`, sends envelopes, and
// asks for a new connection with `disconnect` every few hours. An envelope is
// acknowledged with its `envelope_id` only once it is handled, so that Slack
// sends again what the intake did not take (ADR-0028).
//
// A connection is pinged; one that does not answer is closed. A connection
// that is lost, or cannot be opened, is opened again after a wait that grows
// with each failure in a row.
import WebSocket from "ws";

import { describeFailure, type Raw } from "./api.ts";

export type SocketModeOptions = {
  /** The URL of a new connection (apps.connections.open). */
  open: () => Promise<string>;
  /** An envelope Slack sent, one at a time in order; true acknowledges it. */
  handle: (envelope: Raw) => Promise<boolean>;
  /** Each connection Slack greeted, the first included. */
  hello: () => void;
  log: (line: string) => void;
  /** How often a connection is pinged; it is closed when a ping is not answered before the next. */
  pingMs?: number;
  /** The wait before the `attempt`-th try in a row that failed. */
  backoffMs?: (attempt: number) => number;
  connect?: (url: string) => WebSocket;
};

/** 1 s, doubled with each failure in a row, 5 minutes at most. */
export const backoff = (attempt: number) => Math.min(1000 * 2 ** (attempt - 1), 5 * 60 * 1000);

export function socketMode(options: SocketModeOptions): { stop: () => Promise<void> } {
  const pingMs = options.pingMs ?? 30_000;
  const backoffMs = options.backoffMs ?? backoff;
  const connect = options.connect ?? ((url: string) => new WebSocket(url));
  let stopped = false;
  let current: WebSocket | undefined;
  let wake: (() => void) | undefined;
  /** The envelopes in hand, one after another. */
  let chain: Promise<void> = Promise.resolve();

  /** One connection, until it closes. Resolves whether Slack greeted it. */
  const session = (url: string) =>
    new Promise<boolean>((resolve) => {
      const socket = connect(url);
      current = socket;
      let greeted = false;
      let alive = true;
      const pinger = setInterval(() => {
        if (!alive) {
          options.log("no answer to a ping; closing the connection");
          socket.terminate();
          return;
        }
        alive = false;
        if (socket.readyState === WebSocket.OPEN) socket.ping();
      }, pingMs);
      socket.on("pong", () => (alive = true));
      socket.on("error", (error) => options.log(`connection error (${describeFailure(error)})`));
      socket.on("close", () => {
        clearInterval(pinger);
        if (current === socket) current = undefined;
        resolve(greeted);
      });
      socket.on("message", (data) => {
        alive = true;
        if (stopped) return;
        let envelope: Raw;
        try {
          envelope = JSON.parse(data.toString()) as Raw;
        } catch {
          options.log("an envelope that is not JSON was passed over");
          return;
        }
        if (envelope.type === "hello") {
          greeted = true;
          options.log("connected");
          options.hello();
          return;
        }
        if (envelope.type === "disconnect") {
          options.log(`Slack asked for a new connection (${typeof envelope.reason === "string" ? envelope.reason.replace(/[^a-z_]/g, "") : "no reason"})`);
          socket.close();
          return;
        }
        const id = envelope.envelope_id;
        if (typeof id !== "string") return;
        chain = chain.then(async () => {
          let taken = false;
          try {
            taken = await options.handle(envelope);
          } catch (error) {
            options.log(`an envelope could not be handled (${describeFailure(error)})`);
          }
          if (taken && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ envelope_id: id }));
        });
      });
    });

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      }
      wake = done;
    });

  const running = (async () => {
    let failures = 0;
    while (!stopped) {
      let greeted = false;
      try {
        const url = await options.open();
        if (stopped) break;
        greeted = await session(url);
      } catch (error) {
        options.log(`cannot connect (${describeFailure(error)})`);
      }
      if (stopped) break;
      failures = greeted ? 0 : failures + 1;
      if (failures > 0) {
        const ms = backoffMs(failures);
        options.log(`connecting again in ${Math.round(ms / 100) / 10}s`);
        await sleep(ms);
      }
    }
  })();

  return {
    async stop() {
      stopped = true;
      wake?.();
      // What is in hand is finished, and acknowledged, before the connection closes.
      await chain;
      current?.close();
      await running;
    },
  };
}
