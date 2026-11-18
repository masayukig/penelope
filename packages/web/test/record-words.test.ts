// How the activity record writes its rows (docs/design/README.md, 15): the
// heading of a turn from what started it, the hours of folded turns, and the
// words the backend leaves to the UI.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RecordJob, RecordRow, RecordTurn } from "@penelope/contract";

import { durationOf, foldDay, headlineOf, jobNote, mixOf, recordDayOf } from "../src/ui/record.ts";

/** A local time on 2026-11-17, as the browser's time zone reads it. */
const at = (hour: number, minute: number) => new Date(2026, 10, 17, hour, minute).toISOString();

const turn = (id: string, hour: number, minute: number, extra: Partial<RecordTurn> = {}): RecordTurn => ({
  id,
  kind: "turn",
  at: at(hour, minute),
  agent: "main",
  result: "done",
  triggers: [{ seq: 1, source: "cron", summary: "毎時の見回り" }],
  trigger_count: 1,
  tools: 1,
  replies: 0,
  ...extra,
});

describe("the heading of a turn", () => {
  it("is the kind of what started it, and its words on one line without Markdown", () => {
    assert.deepEqual(headlineOf(turn("t", 9, 0, { triggers: [{ seq: 1, source: "alertmanager", summary: "**[FIRING]** High\nMemory" }] })), {
      kind: "alertmanager",
      text: "[FIRING] High Memory",
    });
  });

  it("counts several events of one kind together", () => {
    const triggers = [
      { seq: 1, source: "ui", summary: "おはよう" },
      { seq: 2, source: "ui", summary: "今日は？" },
    ];
    assert.deepEqual(headlineOf(turn("t", 9, 0, { triggers, trigger_count: 2 })), { kind: "オーナー", text: "発言 2 件をまとめて" });
  });

  // Decided for the design's open question: the first event, then how many more.
  it("names the first of events of several kinds, then how many more, counting those the row does not list", () => {
    const triggers = [
      { seq: 1, source: "slack", summary: "メンション" },
      { seq: 2, source: "ui", summary: "見てて" },
    ];
    assert.deepEqual(headlineOf(turn("t", 9, 0, { triggers, trigger_count: 25 })), { kind: "slack", text: "メンション", more: "ほか 24 件" });
  });

  it("of a sub-agent is its name and that it came from the main agent", () => {
    assert.deepEqual(headlineOf(turn("t", 9, 0, { agent: "renovate-review", triggers: [], trigger_count: 0 })), { kind: "本体から", text: "", who: "renovate-review" });
  });
});

describe("the rows of a day", () => {
  it("fold the turns that did not fail an hour at a time, the folded hour standing at its start", () => {
    const rows: RecordRow[] = [
      turn("a", 14, 41),
      turn("stopped", 14, 30, { result: "stopped" }),
      turn("failed", 14, 12, { result: "failed", failed_at: at(14, 13) }),
      turn("lone", 13, 20),
      { id: "j", kind: "job", at: at(11, 5), command: "make test", started_at: at(11, 0), ended_at: at(11, 5), seconds: 300, end: "exited", exit_code: 0 },
    ];
    const entries = foldDay("2026-11-17", rows).map((e) => (e.type === "row" ? e.row.id : `${e.group.hour}: ${e.group.turns.map((t) => t.id).join(",")}`));
    assert.deepEqual(entries, ["failed", "14: a,stopped", "lone", "j"]);
  });

  it("say what a folded hour holds: the three kinds with most turns, then the rest", () => {
    const of = (source: string) => turn(source, 9, 0, { triggers: [{ seq: 1, source, summary: "" }] });
    assert.equal(mixOf([of("ui"), of("ui"), of("slack"), of("cron"), of("self"), of("github")]), "オーナー 2 ・ slack 1 ・ 予約 1 ・ ほか 2");
  });
});

describe("the words of the record", () => {
  it("write a length in seconds, minutes and hours", () => {
    assert.deepEqual([48, 130, 120, 3720].map(durationOf), ["48 秒", "2 分 10 秒", "2 分", "1 時間 2 分"]);
  });

  it("say why a job failed: its exit code, its time limit or its signal", () => {
    const job = (extra: Partial<RecordJob>): RecordJob => ({
      id: "j",
      kind: "job",
      at: at(9, 0),
      command: "make",
      started_at: at(8, 0),
      ended_at: at(9, 0),
      seconds: 3600,
      end: "exited",
      failed_at: at(9, 0),
      ...extra,
    });
    assert.equal(jobNote(job({ exit_code: 2 })), "失敗した ・ exit 2");
    assert.equal(jobNote(job({ end: "timed-out" })), "失敗した ・ 時間切れ");
    assert.equal(jobNote(job({ end: "signaled", signal: "SIGKILL" })), "失敗した ・ シグナル SIGKILL");
  });

  it("head a day with today or yesterday before its date, and the year when it is another", () => {
    const now = new Date(2026, 10, 17, 12, 0).getTime();
    assert.equal(recordDayOf("2026-11-17", now), "今日 ・ 11月17日(火)");
    assert.equal(recordDayOf("2026-11-16", now), "昨日 ・ 11月16日(月)");
    assert.equal(recordDayOf("2026-11-10", now), "11月10日(火)");
    assert.equal(recordDayOf("2025-12-31", now), "2025年12月31日(水)");
  });
});
