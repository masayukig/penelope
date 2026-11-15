// The receivers' HTTP server against a fake intake on a real Unix socket.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";

import type { Event } from "@penelope/contract";

import { loadConfig } from "../src/config.ts";
import { type Receivers, startReceivers } from "../src/server.ts";

const TOKEN = "example-token-0002";

/** The intake: it keeps what it was sent and answers as `answer` says. */
class FakeIntake {
  readonly received: { method: string; path: string; type: string; event: Event }[] = [];
  answer: (event: Event) => number | "hang" | { afterMs: number; status: number } = () => 202;
  private server: http.Server | undefined;

  readonly socket: string;

  constructor(socket: string) {
    this.socket = socket;
  }

  async start(): Promise<void> {
    this.server = http.createServer((request, response) => {
      const parts: Buffer[] = [];
      request.on("data", (part: Buffer) => parts.push(part));
      request.on("end", () => {
        const event = JSON.parse(Buffer.concat(parts).toString("utf8")) as Event;
        this.received.push({ method: request.method ?? "", path: request.url ?? "", type: request.headers["content-type"] ?? "", event });
        const answer = this.answer(event);
        if (answer === "hang") return;
        const send = (status: number) => {
          response.writeHead(status, status === 202 ? {} : { "content-type": "application/json" });
          response.end(status === 202 ? "" : JSON.stringify({ error: "refused by the fake" }));
        };
        if (typeof answer === "number") send(answer);
        else setTimeout(() => send(answer.status), answer.afterMs);
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(this.socket, resolve));
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }
}

const dir = mkdtempSync(join(tmpdir(), "receivers-"));
const intake = new FakeIntake(join(dir, "backend.sock"));
let receivers: Receivers;
let lines: string[] = [];
let timeoutSeconds = 10;

async function start(socket = intake.socket): Promise<Receivers> {
  const config = loadConfig({ PENELOPE_RECEIVERS_CONFIG: "/config.json" }, (path) => {
    if (path === "/token") return `${TOKEN}\n`;
    return JSON.stringify({
      listen: "127.0.0.1:0",
      intake: socket,
      intake_timeout_seconds: timeoutSeconds,
      plugins: [{ name: "fraction", plugin: "alertmanager", settings: { token_file: "/token" } }],
    });
  });
  return startReceivers(config, { log: (line) => lines.push(line) });
}

function call(
  path: string,
  { method = "POST", body = "", headers = {}, target = receivers }: { method?: string; body?: string | Buffer; headers?: Record<string, string>; target?: Receivers } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: target.port, path, method, headers }, (response) => {
      const parts: Buffer[] = [];
      response.on("data", (part: Buffer) => parts.push(part));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(parts).toString("utf8") }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

const alert = (fingerprint: string, labels: Record<string, string> = {}) => ({
  status: "firing",
  labels: { alertname: "KubePodCrashLooping", severity: "critical", ...labels },
  annotations: { summary: "SECRET-LOOKING body text" },
  startsAt: "2026-11-15T10:00:00Z",
  endsAt: "0001-01-01T00:00:00Z",
  fingerprint,
});

const post = (alerts: unknown[], extra: Record<string, unknown> = {}, token = TOKEN) =>
  call("/v1/webhooks/fraction", {
    body: JSON.stringify({ version: "4", externalURL: "https://alertmanager.example.com", alerts, ...extra }),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });

before(async () => {
  await intake.start();
  receivers = await start();
});

after(async () => {
  await receivers.close();
  await intake.stop();
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  intake.received.length = 0;
  intake.answer = () => 202;
  lines = [];
});

describe("the receivers' HTTP server", () => {
  test("answers /healthz with ok", async () => {
    assert.deepEqual([(await call("/healthz", { method: "GET" })).status, (await call("/healthz", { method: "GET" })).body], [200, "ok"]);
  });

  test("answers 404 to a path it does not know and to a webhook it has not", async () => {
    assert.equal((await call("/v1/webhooks/lab")).status, 404);
    assert.equal((await call("/v1/events")).status, 404);
    assert.equal((await call("/v1/webhooks/fraction/more")).status, 404);
  });

  test("answers 405 with Allow: POST to a webhook called otherwise", async () => {
    const answer = await call("/v1/webhooks/fraction", { method: "GET" });
    assert.equal(answer.status, 405);
    assert.equal(answer.headers.allow, "POST");
  });

  test("answers 413 to a body over 1 MiB, and sends nothing", async () => {
    const answer = await call("/v1/webhooks/fraction", { body: Buffer.alloc(1024 * 1024 + 1, 0x20), headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(answer.status, 413);
    assert.equal(intake.received.length, 0);
  });

  test("answers 401 to a wrong token and 400 to a body of the wrong shape, and sends nothing", async () => {
    assert.equal((await post([alert("a1")], {}, "wrong")).status, 401);
    assert.equal((await call("/v1/webhooks/fraction", { body: "{", headers: { authorization: `Bearer ${TOKEN}` } })).status, 400);
    assert.equal(intake.received.length, 0);
  });

  test("sends each event to the intake with the activation's source, and answers 200 once all were taken", async () => {
    const answer = await post([alert("a1"), alert("a2")]);
    assert.deepEqual([answer.status, answer.body], [200, ""]);
    assert.deepEqual(
      intake.received.map(({ method, path, type, event }) => [method, path, type, event.source, event.id, event.delivery]),
      [
        ["POST", "/v1/events", "application/json", "alertmanager", "a1/firing/2026-11-15T10:00:00Z", "now"],
        ["POST", "/v1/events", "application/json", "alertmanager", "a2/firing/2026-11-15T10:00:00Z", "now"],
      ],
    );
    assert.equal(intake.received[0]!.event.stream, "kubepodcrashlooping");
  });

  test("answers 200 to a request whose alerts were all dropped, without calling the intake", async () => {
    assert.equal((await post([alert("a1", { sender: "penelope" })])).status, 200);
    assert.equal(intake.received.length, 0);
    assert.match(lines.join("\n"), /webhook=fraction status=200 events=0 dropped=1/);
  });

  test("stops at the first event the intake does not take, and answers 503", async () => {
    intake.answer = (event) => (event.id.startsWith("a2/") ? 503 : 202);
    assert.equal((await post([alert("a1"), alert("a2"), alert("a3")])).status, 503);
    assert.deepEqual(intake.received.map(({ event }) => event.id.split("/")[0]), ["a1", "a2"]);
  });

  test("answers 503 when the intake refuses the envelope, and says which event and why", async () => {
    intake.answer = () => 400;
    assert.equal((await post([alert("a1")])).status, 503);
    const log = lines.join("\n");
    assert.match(log, /alertmanager\/a1\/firing\/2026-11-15T10:00:00Z/);
    assert.match(log, /400/);
    assert.match(log, /refused by the fake/);
  });

  test("answers 503 when the intake is not there", async () => {
    const other = await start(join(dir, "nobody.sock"));
    try {
      const answer = await call("/v1/webhooks/fraction", { target: other, body: JSON.stringify({ alerts: [alert("a1")] }), headers: { authorization: `Bearer ${TOKEN}` } });
      assert.equal(answer.status, 503);
    } finally {
      await other.close();
    }
  });

  test("answers 503 when the intake does not answer in intake_timeout_seconds", async () => {
    timeoutSeconds = 1;
    const other = await start();
    timeoutSeconds = 10;
    intake.answer = () => "hang";
    try {
      const started = Date.now();
      const answer = await call("/v1/webhooks/fraction", { target: other, body: JSON.stringify({ alerts: [alert("a1")] }), headers: { authorization: `Bearer ${TOKEN}` } });
      assert.equal(answer.status, 503);
      assert.ok(Date.now() - started < 5000);
    } finally {
      await other.close();
    }
  });

  test("writes one line for each request, without the body or the key", async () => {
    await post([alert("a1"), alert("a2", { sender: "penelope" })]);
    await post([alert("a1")], {}, "wrong");
    await call("/v1/webhooks/lab");
    assert.deepEqual(lines, [
      "receivers: webhook=fraction status=200 events=1 dropped=1",
      "receivers: webhook=fraction status=401 events=0 dropped=0",
      "receivers: webhook=- status=404 events=0 dropped=0",
    ]);
    assert.equal(lines.join("\n").includes(TOKEN), false);
    assert.equal(lines.join("\n").includes("SECRET-LOOKING"), false);
  });

  test("writes how many alerts Alertmanager left out", async () => {
    await post([alert("a1")], { truncatedAlerts: 7 });
    assert.ok(lines.includes("receivers: webhook=fraction truncated_alerts=7"), lines.join("\n"));
  });

  test("finishes the requests it is sending when closed, and takes no new ones", async () => {
    const other = await start();
    intake.answer = () => ({ afterMs: 300, status: 202 });
    const pending = call("/v1/webhooks/fraction", { target: other, body: JSON.stringify({ alerts: [alert("a1")] }), headers: { authorization: `Bearer ${TOKEN}` } });
    while (intake.received.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    const closing = other.close();
    await assert.rejects(call("/healthz", { method: "GET", target: other }));
    assert.equal((await pending).status, 200);
    await closing;
  });
});
