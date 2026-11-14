import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import type { SourcesLine } from "@penelope/contract";

import { Sources } from "../src/sources.ts";
import { tempDir } from "./support.ts";

function line(seq: number, overrides: Partial<SourcesLine> = {}): SourcesLine {
  return {
    seq,
    received_at: "2026-11-14T09:00:01.000Z",
    occurred_at: "2026-11-14T09:00:00Z",
    source: "slack",
    stream: "ops",
    id: `m-${seq}`,
    summary: `message ${seq}`,
    payload: { n: seq },
    ...overrides,
  };
}

describe("/sources", () => {
  it("appends a line to the day's file of the source's stream and says which line it was", (t) => {
    const dir = tempDir(t);
    const sources = new Sources(dir, "UTC");
    assert.deepEqual(sources.append(line(1)), { path: path.join(dir, "slack/ops/2026-11-14.jsonl"), lines: [1, 1] });
    assert.deepEqual(sources.append(line(2)), { path: path.join(dir, "slack/ops/2026-11-14.jsonl"), lines: [2, 2] });
    const written = readFileSync(path.join(dir, "slack/ops/2026-11-14.jsonl"), "utf8").trimEnd().split("\n");
    assert.deepEqual(written.map((text) => JSON.parse(text)), [line(1), line(2)]);
  });

  it("writes the fields in the order of the spec, the payload last", (t) => {
    const dir = tempDir(t);
    new Sources(dir, "UTC").append(line(1, { attachments: ["/x"] }));
    const text = readFileSync(path.join(dir, "slack/ops/2026-11-14.jsonl"), "utf8");
    assert.deepEqual(Object.keys(JSON.parse(text)), [
      "seq",
      "received_at",
      "occurred_at",
      "source",
      "stream",
      "id",
      "summary",
      "attachments",
      "payload",
    ]);
  });

  it("puts a line without a stream straight under the source", (t) => {
    const dir = tempDir(t);
    const { stream: _none, ...noStream } = line(1);
    assert.equal(new Sources(dir, "UTC").append(noStream).path, path.join(dir, "slack/2026-11-14.jsonl"));
  });

  it("dates the file by when the backend received it, in the backend's time zone", (t) => {
    const dir = tempDir(t);
    const sources = new Sources(dir, "Asia/Tokyo");
    const appended = sources.append(line(1, { received_at: "2026-11-14T15:30:00.000Z", occurred_at: "2026-11-13T00:00:00Z" }));
    assert.equal(appended.path, path.join(dir, "slack/ops/2026-11-15.jsonl"));
  });

  it("counts the lines already in a file it did not write in this run", (t) => {
    const dir = tempDir(t);
    new Sources(dir, "UTC").append(line(1));
    new Sources(dir, "UTC").append(line(2));
    assert.deepEqual(new Sources(dir, "UTC").append(line(3)).lines, [3, 3]);
  });

  it("keeps attachments under files/ with the seq in front of a name that stays in that place", (t) => {
    const dir = tempDir(t);
    const sources = new Sources(dir, "UTC");
    const saved = sources.saveAttachments("ui", 13, [
      { name: "screenshot.png", data: new Uint8Array([1, 2, 3]) },
      { name: "../../etc/passwd", data: new Uint8Array([4]) },
      { name: "screenshot.png", data: new Uint8Array([5]) },
      { name: "メモ 1.txt", data: new Uint8Array([6]) },
      { name: "", data: new Uint8Array([7]) },
    ]);
    assert.deepEqual(saved, [
      path.join(dir, "ui/files/13-screenshot.png"),
      path.join(dir, "ui/files/13-passwd"),
      path.join(dir, "ui/files/13-screenshot-2.png"),
      path.join(dir, "ui/files/13-___1.txt"),
      path.join(dir, "ui/files/13-file"),
    ]);
    assert.deepEqual([...readFileSync(saved[0]!)], [1, 2, 3]);
    assert.deepEqual([...readFileSync(saved[2]!)], [5]);
  });
});
