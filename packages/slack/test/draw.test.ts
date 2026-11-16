import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import { drawChanges, drawChannel, drawThread } from "../src/draw.ts";
import { ALICE, BOB, CAROL, DEV, DM, deletion, edit, line, message, reaction, reset, SELF, ts } from "./lines.ts";

const UTC = { timeZone: "UTC" };

beforeEach(reset);

describe("a channel as it stands", () => {
  test("messages in order, each with its replies, reactions and files", () => {
    const parent = ts("09:00");
    const lines = [
      line(message(parent, "Shall we start the release?")),
      line(message(ts("09:05"), "Yes.\nAfter lunch.", { user: BOB, thread: parent })),
      line(
        message(ts("09:10"), "the report", {
          user: CAROL,
          files: [
            { id: "F0A", name: "report.pdf", mimetype: "application/pdf", size: 1200, attached: true },
            { id: "F0B", name: "clip.mov", mimetype: "video/quicktime", size: 300_000_000, attached: false },
          ],
        }),
        { attachments: ["/sources/slack/files/3-report.pdf"] },
      ),
      line(reaction(parent, "+1", BOB)),
      line(reaction(parent, "+1", CAROL)),
      line(reaction(parent, "eyes", BOB)),
      line(reaction(parent, "eyes", BOB, true)),
      line(message(ts("09:20"), "Starting <@U0ALICE>.", { user: SELF, names: { U0ALICE: "alice" } })),
    ];
    assert.equal(
      drawChannel(lines, UTC),
      [
        "work #dev (channel C0DEV, stream work.dev)",
        `- 11-16 09:00 alice [${parent}]: Shall we start the release?`,
        "  reactions: :+1: bob, carol",
        `  - 11-16 09:05 bob [${ts("09:05")}]: Yes.`,
        "    After lunch.",
        `- 11-16 09:10 carol [${ts("09:10")}]: the report`,
        "  file report.pdf: /sources/slack/files/3-report.pdf",
        "  file clip.mov (video/quicktime, 286.1 MiB): not fetched",
        `- 11-16 09:20 Penelope (you) [${ts("09:20")}]: Starting @alice.`,
        "",
      ].join("\n"),
    );
  });

  test("an edit shows the text now, and a deletion leaves only that it was there", () => {
    const lines = [
      line(message(ts("09:00"), "teh plan")),
      line(message(ts("09:01"), "oops")),
      line(edit(ts("09:00"), "the plan")),
      line(deletion(ts("09:01"))),
    ];
    assert.equal(
      drawChannel(lines, UTC),
      [
        "work #dev (channel C0DEV, stream work.dev)",
        `- 11-16 09:00 alice [${ts("09:00")}] (edited): the plan`,
        `- 11-16 09:01 alice [${ts("09:01")}] (deleted)`,
        "",
      ].join("\n"),
    );
  });

  test("a message fetched again carries its reactions, and later ones are added to them once", () => {
    const at = ts("09:00");
    const lines = [line(message(at, "hello", { reactions: [{ name: "wave", users: [BOB], count: 2 }] })), line(reaction(at, "wave", BOB)), line(reaction(at, "wave", CAROL))];
    assert.match(drawChannel(lines, UTC), /\n {2}reactions: :wave: bob, carol\n/);
  });

  test("the same message received twice is drawn once", () => {
    const at = ts("09:00");
    const lines = [line(message(at, "hello")), line(message(at, "hello"))];
    assert.equal(drawChannel(lines, UTC).match(/hello/g)?.length, 1);
  });

  test("the limit keeps the latest messages", () => {
    const lines = [line(message(ts("09:00"), "one")), line(message(ts("09:01"), "two")), line(message(ts("09:02"), "three"))];
    const drawn = drawChannel(lines, { ...UTC, limit: 2 });
    assert.doesNotMatch(drawn, /one/);
    assert.match(drawn, /two[\s\S]*three/);
  });

  test("a DM is named by the person it is with", () => {
    assert.match(drawChannel([line(message(ts("09:00"), "hi", { channel: DM }))], UTC), /^work DM with alice \(channel D0ALICE, stream work\.dm\.alice\)\n/);
  });

  test("replies whose parent was not read stand under a mark of it", () => {
    const parent = ts("08:00");
    const drawn = drawChannel([line(message(ts("09:00"), "late reply", { user: BOB, thread: parent }))], UTC);
    assert.match(drawn, new RegExp(`\\n- thread of \\[${parent.replace(".", "\\.")}\\] \\(not read\\)\\n  - 11-16 09:00 bob`));
  });
});

describe("a thread", () => {
  test("its parent and every reply", () => {
    const parent = ts("09:00");
    const lines = [line(message(parent, "Shall we?")), line(message(ts("09:01"), "elsewhere")), line(message(ts("09:05"), "Yes.", { user: BOB, thread: parent }))];
    assert.equal(
      drawThread(lines, parent, UTC),
      ["work #dev (channel C0DEV, stream work.dev)", `- 11-16 09:00 alice [${parent}]: Shall we?`, `  - 11-16 09:05 bob [${ts("09:05")}]: Yes.`, ""].join("\n"),
    );
  });

  test("nothing when there is no such thread", () => {
    assert.equal(drawThread([line(message(ts("09:00"), "hi"))], ts("10:00"), UTC), undefined);
  });
});

describe("the changes since the last turn", () => {
  test("only what changed, with the parent of a reply and the message of a reaction drawn short", () => {
    const parent = ts("09:00");
    const context = [
      line(message(parent, "Shall we start the release this afternoon, after everyone is back from lunch?")),
      line(message(ts("09:01"), "unrelated")),
      line(message(ts("09:02"), "nice weather", { user: BOB })),
    ];
    const changes = [
      line(message(ts("09:10"), "Starting now.", { user: SELF, thread: parent })),
      line(reaction(ts("09:02"), "sunny", CAROL)),
      line(reaction(ts("09:02"), "+1", ALICE, true)),
      line(message(ts("09:11"), "New topic <@U0SELF>", { user: BOB, mention: true, names: { U0SELF: "Penelope" } })),
    ];
    const drawn = drawChanges(changes, [...context, ...changes], UTC);
    assert.deepEqual(drawn.undrawn, []);
    assert.deepEqual(drawn.omitted, []);
    assert.equal(
      drawn.text,
      [
        "work #dev (channel C0DEV, stream work.dev)",
        `- 11-16 09:00 alice [${parent}] (earlier): "Shall we start the release this afternoon, after everyone is…"`,
        `  - 11-16 09:10 Penelope (you) [${ts("09:10")}]: Starting now.`,
        `- 11-16 09:02 bob [${ts("09:02")}] (earlier): "nice weather"`,
        "  + :sunny: carol",
        "  - :+1: alice",
        `- 11-16 09:11 bob [${ts("09:11")}]: New topic @Penelope`,
        "",
      ].join("\n"),
    );
  });

  test("each channel is drawn on its own, in the order of its first change", () => {
    const changes = [line(message(ts("09:00"), "in a DM", { channel: DM })), line(message(ts("09:01"), "in dev"))];
    const drawn = drawChanges(changes, changes, UTC);
    assert.match(drawn.text, /^work DM with alice [^\n]*\n- [^\n]*in a DM\n\nwork #dev [^\n]*\n- [^\n]*in dev\n$/);
  });

  test("an edit and a deletion of a message not read are drawn from what they carry", () => {
    const changes = [line(edit(ts("08:00"), "fixed text")), line(deletion(ts("08:01"))), line(reaction(ts("08:02"), "eyes", BOB))];
    const drawn = drawChanges(changes, changes, UTC);
    assert.equal(
      drawn.text,
      [
        "work #dev (channel C0DEV, stream work.dev)",
        `- 11-16 08:00 alice [${ts("08:00")}] (edited): fixed text`,
        `- message [${ts("08:01")}] (not read) (deleted)`,
        `- message [${ts("08:02")}] (not read)`,
        "  + :eyes: bob",
        "",
      ].join("\n"),
    );
  });

  test("an edited message shows its new text, and its earlier text is not repeated", () => {
    const context = [line(message(ts("09:00"), "teh plan"))];
    const changes = [line(edit(ts("09:00"), "the plan"))];
    assert.equal(drawChanges(changes, [...context, ...changes], UTC).text, `work #dev (channel C0DEV, stream work.dev)\n- 11-16 09:00 alice [${ts("09:00")}] (edited): the plan\n`);
  });

  test("lines after the last change are not counted", () => {
    const changes = [line(message(ts("09:00"), "hello"))];
    const later = line(edit(ts("09:00"), "hello, edited later"));
    assert.doesNotMatch(drawChanges(changes, [...changes, later], UTC).text, /edited later/);
  });

  test("`before` adds the messages just before the first change, short", () => {
    const context = [line(message(ts("09:00"), "one")), line(message(ts("09:01"), "two")), line(message(ts("09:02"), "three"))];
    const changes = [line(message(ts("09:03"), "<@U0SELF> what now?", { mention: true }))];
    const drawn = drawChanges(changes, [...context, ...changes], { ...UTC, before: 2 });
    assert.equal(
      drawn.text,
      [
        "work #dev (channel C0DEV, stream work.dev)",
        `- 11-16 09:01 alice [${ts("09:01")}] (earlier): "two"`,
        `- 11-16 09:02 alice [${ts("09:02")}] (earlier): "three"`,
        `- 11-16 09:03 alice [${ts("09:03")}]: @U0SELF what now?`,
        "",
      ].join("\n"),
    );
  });

  test("over the limit, the oldest changes are left out with where to read them", () => {
    const changes = Array.from({ length: 30 }, (_, index) => line(message(ts(`09:${String(index).padStart(2, "0")}`), `message number ${index} ${"x".repeat(40)}`)));
    const drawn = drawChanges(changes, changes, { ...UTC, maxChars: 800 });
    assert.ok(drawn.text.length <= 800, `${drawn.text.length} characters`);
    assert.match(drawn.text, /message number 29/);
    assert.doesNotMatch(drawn.text, /message number 0 /);
    assert.ok(drawn.omitted.length > 0);
    assert.deepEqual(drawn.omitted, changes.slice(0, drawn.omitted.length).map((item) => item.seq));
    assert.match(drawn.text, new RegExp(`\\(${drawn.omitted.length} earlier changes left out; slackctl history work\\.dev\\)`));
  });

  test("the hint names the source when it is not the default one", () => {
    const changes = Array.from({ length: 30 }, (_, index) => line(message(ts(`09:${String(index).padStart(2, "0")}`), "y".repeat(60)), { source: "slack-home" }));
    assert.match(drawChanges(changes, changes, { ...UTC, maxChars: 500 }).text, /slackctl --source slack-home history work\.dev\)/);
  });

  test("a payload of another shape is not drawn, and is handed back", () => {
    const foreign = line(message(ts("09:00"), "hello"));
    foreign.payload = { type: "message", text: "no channel" };
    const good = line(message(ts("09:01"), "fine"));
    const drawn = drawChanges([foreign, good], [foreign, good], UTC);
    assert.deepEqual(drawn.undrawn, [foreign]);
    assert.match(drawn.text, /fine/);
    assert.doesNotMatch(drawn.text, /no channel/);
  });

  test("nothing to draw is an empty text", () => {
    assert.equal(drawChanges([], [], UTC).text, "");
  });
});

test("the CLI's channel drawing and the turn's agree on a new message", () => {
  const lines = [line(message(ts("09:00"), "same words", { channel: DEV }))];
  const channel = drawChannel(lines, UTC).split("\n")[1];
  const change = drawChanges(lines, lines, UTC).text.split("\n")[1];
  assert.equal(channel, change);
});
