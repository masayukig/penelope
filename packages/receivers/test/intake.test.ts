// Sending to the intake, against a fake on a real Unix socket.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import type { Event } from "@penelope/contract";

import { sendEvent } from "../src/intake.ts";

const dir = mkdtempSync(join(tmpdir(), "receivers-intake-"));
const socket = join(dir, "backend.sock");
const received: { type: string; body: Buffer }[] = [];
let server: http.Server;

before(async () => {
  server = http.createServer((request, response) => {
    const parts: Buffer[] = [];
    request.on("data", (part: Buffer) => parts.push(part));
    request.on("end", () => {
      received.push({ type: request.headers["content-type"] ?? "", body: Buffer.concat(parts) });
      response.writeHead(202);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

const EVENT: Event = { source: "slack", id: "work/C0DEV/1794819600.000100", occurred_at: "2026-11-16T09:00:00.000Z", summary: "a summary", payload: { text: "hi" } };

test("an event without files is sent as JSON", async () => {
  received.length = 0;
  assert.deepEqual(await sendEvent(socket, EVENT, 1000), { taken: true });
  assert.equal(received[0]!.type, "application/json");
  assert.deepEqual(JSON.parse(received[0]!.body.toString("utf8")), EVENT);
});

test("an event with files is sent as multipart/form-data, the envelope in `event` and each file in a `file` part", async () => {
  received.length = 0;
  const pdf = new Uint8Array(Buffer.from("%PDF-1.7 made up"));
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255]);
  const answer = await sendEvent(socket, EVENT, 1000, [
    { name: "report.pdf", type: "application/pdf", data: pdf },
    { name: 'a "quoted"\nname.png', type: "image/png", data: png },
  ]);
  assert.deepEqual(answer, { taken: true });
  const { type, body } = received[0]!;
  assert.match(type, /^multipart\/form-data; boundary=/);
  const form = await new Response(new Uint8Array(body), { headers: { "content-type": type } }).formData();
  assert.deepEqual(JSON.parse(form.get("event") as string), EVENT);
  const files = form.getAll("file") as File[];
  assert.deepEqual(
    files.map((file) => [file.name, file.type]),
    [
      ["report.pdf", "application/pdf"],
      ["a _quoted__name.png", "image/png"],
    ],
  );
  assert.deepEqual(new Uint8Array(await files[0]!.arrayBuffer()), pdf);
  assert.deepEqual(new Uint8Array(await files[1]!.arrayBuffer()), png);
});
