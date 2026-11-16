import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";

import type { SourcesLine } from "@penelope/contract";

import { run } from "../src/cli.ts";
import { readContext } from "../src/sources.ts";
import { BOB, DEV, DM, line, message, reaction, reset, ts } from "./lines.ts";

beforeEach(reset);

/** A /sources of its own, with the lines written under their streams and days. */
function sources(days: Record<string, Record<string, (SourcesLine | string)[]>>, source = "slack"): string {
  const root = mkdtempSync(join(tmpdir(), "sources-"));
  for (const [stream, files] of Object.entries(days)) {
    mkdirSync(join(root, source, stream), { recursive: true });
    for (const [day, lines] of Object.entries(files)) {
      writeFileSync(join(root, source, stream, `${day}.jsonl`), lines.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join("\n") + "\n");
    }
  }
  mkdirSync(join(root, source, "files"), { recursive: true });
  return root;
}

const cli = (root: string, ...args: string[]) => run(["--sources", root, "--time-zone", "UTC", ...args], {});

describe("slackctl", () => {
  test("channels lists each stream with its workspace and channel", () => {
    const root = sources({
      "work.dev": { "2026-11-15": [line(message(ts("09:00"), "hi"))], "2026-11-16": [line(message(ts("09:01"), "hi again"))] },
      "work.dm.alice": { "2026-11-14": [line(message(ts("09:02"), "psst", { channel: DM }))] },
    });
    const result = cli(root, "channels");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, ["work.dev\twork #dev (channel C0DEV)\tlast 2026-11-16", "work.dm.alice\twork DM with alice (channel D0ALICE)\tlast 2026-11-14", ""].join("\n"));
  });

  test("workspaces lists the workspaces seen", () => {
    const root = sources({
      "work.dev": { "2026-11-16": [line(message(ts("09:00"), "hi"))] },
      "home.general": { "2026-11-16": [line({ ...message(ts("09:00"), "hi"), workspace: "home", channel: { id: "C0GEN", name: "general", type: "channel" } })] },
    });
    assert.equal(cli(root, "workspaces").stdout, "home\t1 channel\nwork\t1 channel\n");
  });

  test("history draws the latest messages of a channel as they stand, across the days read", () => {
    const at = ts("09:00");
    const root = sources({
      "work.dev": {
        "2026-11-14": [line(message(ts("08:00"), "too old"))],
        "2026-11-15": [line(message(at, "hello"))],
        "2026-11-16": [line(reaction(at, "wave", BOB)), "not json", line(message(ts("09:05"), "and more"))],
      },
    });
    const result = cli(root, "history", "work.dev", "--days", "2");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      result.stdout,
      ["work #dev (channel C0DEV, stream work.dev)", `- 11-16 09:00 alice [${at}]: hello`, "  reactions: :wave: bob", `- 11-16 09:05 alice [${ts("09:05")}]: and more`, ""].join("\n"),
    );
    assert.match(cli(root, "history", "work.dev", "--limit", "1").stdout, /and more/);
    assert.doesNotMatch(cli(root, "history", "work.dev", "--limit", "1").stdout, /hello/);
  });

  test("thread draws one thread, from the day of its parent on", () => {
    const parent = ts("09:00");
    const root = sources({
      "work.dev": {
        "2026-11-16": [line(message(parent, "Shall we?")), line(message(ts("09:01"), "other"))],
        "2026-11-17": [line(message(ts("09:30"), "Yes.", { user: BOB, thread: parent }))],
      },
    });
    const result = cli(root, "thread", "work.dev", parent);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, ["work #dev (channel C0DEV, stream work.dev)", `- 11-16 09:00 alice [${parent}]: Shall we?`, `  - 11-16 09:30 bob [${ts("09:30")}]: Yes.`, ""].join("\n"));
    assert.equal(cli(root, "thread", "work.dev", ts("10:00")).code, 1);
  });

  test("another source is read with --source", () => {
    const root = sources({ "work.dev": { "2026-11-16": [line(message(ts("09:00"), "hello"), { source: "slack-home" })] } }, "slack-home");
    assert.match(cli(root, "--source", "slack-home", "history", "work.dev").stdout, /hello/);
  });

  test("a stream that is not there, or a name that is not a stream, is an error", () => {
    const root = sources({ "work.dev": { "2026-11-16": [line(message(ts("09:00"), "hello"))] } });
    const missing = cli(root, "history", "work.ops");
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /no stream work\.ops/);
    assert.equal(cli(root, "history", "../etc").code, 2);
  });

  test("no command, or one it does not know, prints how to use it", () => {
    const result = run([], {});
    assert.equal(result.code, 2);
    assert.match(result.stderr, /usage: slackctl/);
    assert.equal(run(["--help"], {}).code, 0);
    assert.equal(run(["what"], {}).code, 2);
  });
});

describe("the context of changes", () => {
  test("the lines of the changes' streams from the day before the first of them", () => {
    const old = line(message(ts("09:00"), "two days back"), { received_at: "2026-11-14T09:00:00.000Z" });
    const before = line(message(ts("09:00"), "the day before"), { received_at: "2026-11-15T09:00:00.000Z" });
    const change = line(message(ts("09:01"), "now"), { received_at: "2026-11-16T09:01:00.000Z" });
    const other = line(message(ts("09:00"), "another channel", { channel: { ...DEV, id: "C0OPS", name: "ops" } }));
    const root = sources({
      "work.dev": { "2026-11-14": [old], "2026-11-15": [before], "2026-11-16": [change] },
      "work.ops": { "2026-11-16": [other] },
    });
    assert.deepEqual(
      readContext(root, [change]).map((item) => item.seq),
      [before.seq, change.seq],
    );
  });
});
