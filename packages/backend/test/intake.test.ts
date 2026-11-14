import assert from "node:assert/strict";
import { chmodSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.ts";
import { listenUnix } from "../src/http.ts";
import { intakeHandler } from "../src/intake.ts";
import { Queue } from "../src/queue.ts";
import { Sources } from "../src/sources.ts";
import { AwakeHours } from "../src/time.ts";
import { ask, multipart, tempDir } from "./support.ts";

async function setup(t: { after: (fn: () => void | Promise<void>) => void }, maxBytes?: number) {
  const dir = tempDir(t);
  const db = openDatabase(path.join(dir, "backend.sqlite"));
  const sourcesDir = path.join(dir, "sources");
  const queue = new Queue(db, new Sources(sourcesDir, "UTC"), {
    now: Date.now,
    inline: new Set(["ui", "control"]),
    builtinDelivery: {},
    batch: { quietMs: 300_000, maxMs: 1_800_000 },
    awake: new AwakeHours("00:00-00:00", "UTC"),
    redeliverMs: 300_000,
  });
  const socketPath = path.join(dir, "intake.sock");
  const server = await listenUnix(intakeHandler(queue, { log: () => {}, ...(maxBytes === undefined ? {} : { maxBytes }) }), socketPath);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });
  return { queue, sourcesDir, target: { socketPath }, socketPath };
}

const envelope = {
  source: "alertmanager",
  id: "a-1",
  occurred_at: "2026-11-14T09:00:00Z",
  summary: "1 alert firing",
  delivery: "now",
  payload: { alerts: 1 },
};

describe("the intake", () => {
  it("listens on a Unix socket that the containers sharing its volume can write to", async (t) => {
    const { socketPath } = await setup(t);
    assert.equal(statSync(socketPath).isSocket(), true);
    assert.equal(statSync(socketPath).mode & 0o666, 0o666);
  });

  it("answers 202 with no body and queues the event", async (t) => {
    const { queue, target } = await setup(t);
    const answer = await ask(target, "/v1/events", { json: envelope });
    assert.equal(answer.status, 202);
    assert.equal(answer.text, "");
    const [taken] = queue.take({ after: 0 });
    assert.equal(taken?.source, "alertmanager");
    assert.equal(taken?.summary, "1 alert firing");
  });

  it("answers 202 to a duplicate and keeps only the first", async (t) => {
    const { queue, target } = await setup(t);
    await ask(target, "/v1/events", { json: envelope });
    assert.equal((await ask(target, "/v1/events", { json: { ...envelope, summary: "again" } })).status, 202);
    assert.deepEqual(
      queue.take({ after: 0 }).map((e) => e.summary),
      ["1 alert firing"],
    );
  });

  it("answers 400 with the reason to an envelope of the wrong shape", async (t) => {
    const { target } = await setup(t);
    const answer = await ask(target, "/v1/events", { json: { ...envelope, source: "../x" } });
    assert.equal(answer.status, 400);
    assert.match(answer.json().error, /source/);
  });

  it("answers 400 to a body that is not JSON", async (t) => {
    const { target } = await setup(t);
    const answer = await ask(target, "/v1/events", { body: "{", headers: { "content-type": "application/json" } });
    assert.equal(answer.status, 400);
    assert.equal(typeof answer.json().error, "string");
  });

  it("answers 400 to an event from one of the backend's own sources", async (t) => {
    const { target } = await setup(t);
    for (const source of ["ui", "cron", "a2a", "self", "control"]) {
      const answer = await ask(target, "/v1/events", { json: { ...envelope, source } });
      assert.equal(answer.status, 400, source);
      assert.match(answer.json().error, /backend's own/);
    }
  });

  it("takes a multipart body with the envelope in `event` and files in `file`", async (t) => {
    const { queue, target, sourcesDir } = await setup(t);
    const { body, contentType } = await multipart([
      ["event", JSON.stringify(envelope)],
      ["file", new Blob(["graph"]), "graph.png"],
      ["file", new Blob(["log"]), "alert.log"],
    ]);
    const answer = await ask(target, "/v1/events", { body, headers: { "content-type": contentType } });
    assert.equal(answer.status, 202);
    const [taken] = queue.take({ after: 0 });
    assert.deepEqual(taken?.attachments, [
      path.join(sourcesDir, "alertmanager/files/1-graph.png"),
      path.join(sourcesDir, "alertmanager/files/1-alert.log"),
    ]);
    assert.equal(readFileSync(taken!.attachments![1]!, "utf8"), "log");
  });

  it("takes the envelope of a multipart body as a JSON file part too", async (t) => {
    const { queue, target } = await setup(t);
    const { body, contentType } = await multipart([
      ["event", new Blob([JSON.stringify(envelope)], { type: "application/json" }), "event.json"],
    ]);
    assert.equal((await ask(target, "/v1/events", { body, headers: { "content-type": contentType } })).status, 202);
    assert.equal(queue.take({ after: 0 }).length, 1);
  });

  it("answers 400 to a multipart body without the envelope", async (t) => {
    const { target } = await setup(t);
    const { body, contentType } = await multipart([["file", new Blob(["x"]), "x.txt"]]);
    const answer = await ask(target, "/v1/events", { body, headers: { "content-type": contentType } });
    assert.equal(answer.status, 400);
    assert.match(answer.json().error, /event/);
  });

  it("answers 413 to a body over the limit", async (t) => {
    const { target } = await setup(t, 1024);
    const answer = await ask(target, "/v1/events", { json: { ...envelope, payload: "x".repeat(2048) } });
    assert.equal(answer.status, 413);
  });

  it("answers 503 when it cannot write /sources, so that the source sends it again", async (t) => {
    const { target, sourcesDir } = await setup(t);
    await ask(target, "/v1/events", { json: envelope });
    const file = path.join(sourcesDir, `alertmanager/${new Date().toISOString().slice(0, 10)}.jsonl`);
    chmodSync(file, 0o400);
    const answer = await ask(target, "/v1/events", { json: { ...envelope, id: "a-2" } });
    assert.equal(answer.status, 503);
    assert.equal(typeof answer.json().error, "string");
  });

  it("answers 404 to another path and 405 to another method", async (t) => {
    const { target } = await setup(t);
    assert.equal((await ask(target, "/v1/other", { json: envelope })).status, 404);
    assert.equal((await ask(target, "/v1/events")).status, 405);
  });
});
