import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  curatorInput,
  curatorSystemPrompt,
  FOLDING,
  foldAskInput,
  readPromptFiles,
  reflectionInput,
  systemPrompt,
  type Places,
} from "../src/prompts.ts";

const identity = { name: "Example", role: "the operator of a Kubernetes cluster", owner: "Owner" };

async function memory(files: Record<string, string>): Promise<Places> {
  const dir = await mkdtemp(join(tmpdir(), "memory-"));
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return { memory: dir, sources: "/sources", home: "/home/agent" };
}

// What the prompts say is looked at by the facts in them (ADR-0008), not by their wording.

test("the system prompt says who she is and where", async () => {
  // Guards against: a system prompt that loses her name, role or owner, or one of the places she works in.
  const places = await memory({});
  const prompt = systemPrompt(identity, places, await readPromptFiles(places.memory, 1000));
  assert.ok(prompt.includes(identity.name));
  assert.ok(prompt.includes(identity.role));
  assert.ok(prompt.includes(identity.owner));
  assert.ok(prompt.includes(places.memory));
  assert.ok(prompt.includes("/sources"));
  assert.ok(prompt.includes("/home/agent"));
  assert.match(prompt, /Sentinel/);
  assert.match(prompt, /reply/);
});

test("personality, always and handoff follow as they are, in that order", async () => {
  const places = await memory({
    "personality.md": "やさしく話す。",
    "always.md": "毎朝 CI を見る。",
    "handoff.md": "明日は版上げ。",
  });
  const prompt = systemPrompt(identity, places, await readPromptFiles(places.memory, 1000));
  const personality = prompt.indexOf("やさしく話す。");
  const always = prompt.indexOf("毎朝 CI を見る。");
  const handoff = prompt.indexOf("明日は版上げ。");
  assert.ok(personality > 0 && always > personality && handoff > always);
  assert.ok(prompt.includes(`${join(places.memory, "personality.md")}`));
});

test("a file that is not there is left out", async () => {
  const places = await memory({ "always.md": "a" });
  const files = await readPromptFiles(places.memory, 1000);
  assert.deepEqual(
    files.map((file) => file.name),
    ["always.md"],
  );
});

test("a file over the limit is not added, and the prompt says so", async () => {
  const places = await memory({ "always.md": "x".repeat(2000), "handoff.md": "short" });
  const files = await readPromptFiles(places.memory, 1000);
  const prompt = systemPrompt(identity, places, files);
  // Guards against: a long file filling the prompt, or left out without a word (ADR-0006).
  assert.ok(!prompt.includes("x".repeat(1001)));
  assert.ok(prompt.includes(join(places.memory, "always.md")), "the file left out is named");
  assert.match(prompt, /\b2000\b/, "with its size");
  assert.ok(prompt.includes("short"));
});

test("the curator has no personality and is told whose memory it is", async () => {
  const places = await memory({ "personality.md": "やさしく話す。" });
  const prompt = curatorSystemPrompt(identity, places);
  assert.ok(!prompt.includes("やさしく話す。"));
  assert.match(prompt, /Example/);
  assert.ok(prompt.includes(places.memory));
});

test("the reflection and the curator's input name the places", async () => {
  const places = await memory({});
  assert.ok(reflectionInput(places).includes(join(places.memory, "handoff.md")));
  assert.ok(curatorInput(places, "2026-11-14").includes("2026-11-14"));
});

test("with folding on, the system prompt says what folding leaves", async () => {
  const places = await memory({});
  const files = await readPromptFiles(places.memory, 1000);
  const folding = systemPrompt(identity, places, files, { folding: true });
  assert.ok(folding.includes(FOLDING));
  assert.ok(!systemPrompt(identity, places, files, { folding: false }).includes(FOLDING));
});

test("the request before folding names no way to answer it", () => {
  // Guards against: a request that tells her how or what to keep, or points her at a tool (ADR-0015).
  const ask = foldAskInput();
  assert.match(ask, /fold/i, "it says the turn is about to be folded");
  for (const tool of ["reply", "bash", "write", "schedule_add", "self_event"]) assert.ok(!ask.includes(tool), tool);
  assert.ok(!ask.includes("\n"), "one short request");
});

test("the system prompt says what the fields of <events> are", async () => {
  // Guards against: an input of JSON lines whose fields she has to guess, such as which number `reply` answers to.
  const places = await memory({});
  const prompt = systemPrompt(identity, places, await readPromptFiles(places.memory, 1000));
  assert.match(prompt, /<events>/);
  for (const field of ["seq", "source", "stream", "delivery", "occurred_at", "summary", "text", "attachments", "appended", "kind", "count", "seqs", "in_reply_to"]) {
    assert.ok(prompt.includes(`\`${field}\``), field);
  }
});
