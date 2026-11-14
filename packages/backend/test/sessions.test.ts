import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.ts";
import { LoginSessions } from "../src/login/sessions.ts";
import { FakeClock } from "./support.ts";

const OWNER = 4242;
const DAY = 24 * 60;

function setup(t: { after: (fn: () => void) => void }) {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const clock = new FakeClock("2026-11-14T09:00:00Z");
  return { db, clock, sessions: new LoginSessions(db, { now: clock.now }) };
}

// The owner's login sessions of docs/backend.md "オーナーのログイン".
describe("a login session", () => {
  it("ends 30 days after it was last used", (t) => {
    const { clock, sessions } = setup(t);
    const { token } = sessions.create(OWNER);
    clock.advance(30 * DAY - 1);
    assert.ok(sessions.use(token, OWNER), "still alive a minute before its end");
    // That use moved its end on by 30 days.
    clock.advance(30 * DAY - 1);
    assert.ok(sessions.use(token, OWNER), "alive again, 30 days after the last use");
    clock.advance(30 * DAY);
    assert.equal(sessions.use(token, OWNER), undefined);
  });

  it("does not let in someone else when the owner of the configuration changes", (t) => {
    const { sessions } = setup(t);
    const { token } = sessions.create(OWNER);
    assert.equal(sessions.use(token, 7), undefined);
    assert.equal(sessions.use(token, undefined), undefined, "no owner, no session");
  });

  it("no longer works once revoked", (t) => {
    const { sessions } = setup(t);
    const { token } = sessions.create(OWNER);
    sessions.revoke(token);
    assert.equal(sessions.use(token, OWNER), undefined);
  });

  it("keeps no token a copy of the database could be used as", (t) => {
    const { db, sessions } = setup(t);
    const { token } = sessions.create(OWNER);
    const rows = JSON.stringify(db.prepare("SELECT * FROM login_sessions").all());
    assert.ok(!rows.includes(token));
  });

  it("is not known from a made-up token", (t) => {
    const { sessions } = setup(t);
    sessions.create(OWNER);
    assert.equal(sessions.use("A".repeat(43), OWNER), undefined);
  });
});
