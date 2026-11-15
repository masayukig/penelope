// Sending an event to the backend's intake: `POST /v1/events` on its Unix
// socket (docs/events.md, "取り込み口"). Only a 202 is taken; anything else,
// no connection, or no answer in time is not.
import http from "node:http";

import type { Event } from "@penelope/contract";

export type IntakeAnswer = { taken: true } | { taken: false; why: string };

/** How much of a refusal's body is kept for the log. */
const KEPT_BYTES = 1024;

export function sendEvent(socketPath: string, event: Event, timeoutMs: number): Promise<IntakeAnswer> {
  const body = Buffer.from(JSON.stringify(event), "utf8");
  return new Promise((resolve) => {
    let settled = false;
    const settle = (answer: IntakeAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(answer);
    };
    const request = http.request(
      { socketPath, path: "/v1/events", method: "POST", headers: { "content-type": "application/json", "content-length": body.length } },
      (response) => {
        const parts: Buffer[] = [];
        let kept = 0;
        response.on("data", (part: Buffer) => {
          if (kept < KEPT_BYTES) parts.push(part);
          kept += part.length;
        });
        response.on("end", () => {
          if (response.statusCode === 202) return settle({ taken: true });
          const text = Buffer.concat(parts).toString("utf8").slice(0, KEPT_BYTES).replace(/\s+/g, " ").trim();
          settle({ taken: false, why: `answered ${response.statusCode}${text ? ` ${text}` : ""}` });
        });
        response.on("error", (error) => settle({ taken: false, why: error.message }));
      },
    );
    const timer = setTimeout(() => {
      settle({ taken: false, why: `no answer in ${timeoutMs / 1000}s` });
      request.destroy();
    }, timeoutMs);
    request.on("error", (error) => settle({ taken: false, why: error.message }));
    request.end(body);
  });
}
