// The words of a schedule (docs/ui-api.md, "Web UI の予約"): its reason split
// into a lead and the rest, its cron in words, and the day it comes on.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { rhythmOf, scheduleDayOf, splitReason } from "../src/ui/words.ts";

describe("a cron in words", () => {
  it("says every day, every week, every month and every year", () => {
    assert.equal(rhythmOf("0 6 * * *"), "毎日 6:00");
    assert.equal(rhythmOf("30 21 * * *"), "毎日 21:30");
    assert.equal(rhythmOf("5 0 * * *"), "毎日 0:05");
    assert.equal(rhythmOf("0 18 * * 0"), "毎週 日曜 18:00");
    assert.equal(rhythmOf("0 18 * * 7"), "毎週 日曜 18:00");
    assert.equal(rhythmOf("0 9 * * 3"), "毎週 水曜 9:00");
    assert.equal(rhythmOf("0 9 1 * *"), "毎月 1日 9:00");
    assert.equal(rhythmOf("0 9 5 1 *"), "毎年 1月5日 9:00");
    assert.equal(rhythmOf("  0  6 * * *  "), "毎日 6:00");
  });

  it("says nothing of the rest", () => {
    for (const cron of [
      "*/30 * * * *",
      "0 * * * *",
      "0 9-17 * * *",
      "0,30 9 * * *",
      "0 9 * * 1-5",
      "0 9 * * 1,3",
      "0 9 1 * 1",
      "0 9 * 1 *",
      "0 9 * 1 1",
      "0 9 1 1 1",
      "0 9 * * MON",
      "0 9 * * * *",
      "0 9 * *",
      "60 9 * * *",
      "0 24 * * *",
      "0 9 32 * *",
      "0 9 0 * *",
      "0 9 1 13 *",
      "0 9 * * 8",
      "",
    ]) {
      assert.equal(rhythmOf(cron), undefined, cron);
    }
  });
});

describe("a reason split", () => {
  it("leads with what comes before the first 。, without it", () => {
    assert.deepEqual(splitReason("朝の予定を確かめる。カレンダー係に聞いて、まとめて知らせる。"), {
      lead: "朝の予定を確かめる",
      rest: "カレンダー係に聞いて、まとめて知らせる。",
    });
  });

  it("is all lead when there is no 。, or nothing after it", () => {
    assert.deepEqual(splitReason("PR を見直す"), { lead: "PR を見直す" });
    assert.deepEqual(splitReason("見回る。"), { lead: "見回る" });
    assert.deepEqual(splitReason("見回る。  "), { lead: "見回る" });
  });
});

describe("the day a schedule comes on", () => {
  const now = new Date(2026, 10, 17, 12, 0).getTime();
  const at = (year: number, month: number, day: number, hour = 9) => new Date(year, month - 1, day, hour).toISOString();

  it("says today and tomorrow before the date", () => {
    assert.equal(scheduleDayOf(at(2026, 11, 17, 23), now), "今日 ・ 11月17日(火)");
    assert.equal(scheduleDayOf(at(2026, 11, 18, 6), now), "明日 ・ 11月18日(水)");
  });

  it("says the date of the others, and the year when it is not this one", () => {
    assert.equal(scheduleDayOf(at(2026, 11, 19), now), "11月19日(木)");
    assert.equal(scheduleDayOf(at(2027, 1, 5), now), "2027年1月5日(火)");
  });
});
