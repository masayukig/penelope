import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AwakeHours, dayIn } from "../src/time.ts";

const at = (iso: string) => Date.parse(iso);

describe("the awake hours", () => {
  it("are awake from the start up to but not at the end, in their time zone", () => {
    const awake = new AwakeHours("07:00-23:00", "Asia/Tokyo");
    assert.equal(awake.isAwake(at("2026-11-14T22:00:00Z")), true); // 07:00 in Tokyo
    assert.equal(awake.isAwake(at("2026-11-14T21:59:00Z")), false);
    assert.equal(awake.isAwake(at("2026-11-14T13:59:00Z")), true); // 22:59
    assert.equal(awake.isAwake(at("2026-11-14T14:00:00Z")), false); // 23:00
  });

  it("can span midnight", () => {
    const awake = new AwakeHours("22:00-02:00", "UTC");
    assert.equal(awake.isAwake(at("2026-11-14T23:00:00Z")), true);
    assert.equal(awake.isAwake(at("2026-11-14T01:00:00Z")), true);
    assert.equal(awake.isAwake(at("2026-11-14T12:00:00Z")), false);
  });

  it("are always awake when they start where they end", () => {
    assert.equal(new AwakeHours("00:00-00:00", "UTC").isAwake(at("2026-11-14T03:00:00Z")), true);
  });

  it("know when the next morning comes", () => {
    const awake = new AwakeHours("07:00-23:00", "Asia/Tokyo");
    assert.equal(awake.nextStart(at("2026-11-14T14:30:00Z")), at("2026-11-14T22:00:00Z"));
  });

  it("refuse what is not HH:MM-HH:MM", () => {
    assert.throws(() => new AwakeHours("7-23", "UTC"), /HH:MM-HH:MM/);
    assert.throws(() => new AwakeHours("07:00-25:00", "UTC"), /HH:MM-HH:MM/);
  });
});

describe("the day of a time", () => {
  it("is the date in the time zone", () => {
    assert.equal(dayIn(at("2026-11-14T15:30:00Z"), "Asia/Tokyo"), "2026-11-15");
    assert.equal(dayIn(at("2026-11-14T15:30:00Z"), "UTC"), "2026-11-14");
  });
});
