import assert from "node:assert/strict";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { mock } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

import { readConfig } from "../packages/runner/src/config.ts";
import { Runner } from "../packages/runner/src/runner.ts";
import { fakeRuntime, MODEL, PROVIDER, type Script } from "../packages/runner/test/fake-model.ts";
import { answer, score } from "./answer.ts";
import { ReplayBackend } from "./replay-backend.ts";
import { days } from "./scenario.ts";

const [, , mode, label, revision] = process.argv;
const started = performance.now();
const root = resolve("replay");
const home = join(root, "home");
const memoryDir = join(root, "memory");
const sourcesDir = join(root, "sources");
const receiptFile = join(home, "terminal-receipt.txt");
const fake = { provider: PROVIDER, id: MODEL };
const requireEnv = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required in live mode`);
  return value;
};
const live = mode === "live" ? {
  ref: { provider: process.env.EVAL_PROVIDER || "eval-live", id: requireEnv("EVAL_MODEL") },
  baseUrl: requireEnv("EVAL_BASE_URL"),
  apiKey: requireEnv("EVAL_API_KEY"),
} : undefined;
delete process.env.EVAL_API_KEY;
if (live?.ref.provider === PROVIDER) throw new Error("EVAL_PROVIDER is reserved by the scripted model");

let daytime: { inputs: string[]; output: string; file: string; note: string; step: number } | undefined;
let answering = false;
let smokeAnswerRead = false;
// Daytime is a fixed transcript of real Pi tool calls in both modes. The
// built-in read result, not the request or note, contains the terminal seal.
const script: Script = (call) => {
  if (daytime) {
    const path = daytime.inputs[daytime.step++];
    if (path) return { calls: [{ tool: "read", args: { path } }] };
    if (call.lastText.includes(daytime.output)) {
      return { calls: [{ tool: "write", args: { path: join(memoryDir, daytime.file), content: daytime.note } }] };
    }
    return { text: "Pickup notes updated." };
  }
  if (answering) {
    if (call.lastRole === "user") return { calls: [{ tool: "read_memory", args: { path: "pickup-manifest.md" } }] };
    smokeAnswerRead = call.lastText.includes("MANIFEST-63");
    return { text: '{"routing":{"lark":null,"sedge":null,"cutoff":null,"evidence":[]},"seal":{"crate":null,"seal":null,"evidence":[]}}' };
  }
  return { text: "Scripted night response; no memory changes." };
};

for (const dir of [home, memoryDir, sourcesDir]) await mkdir(dir, { recursive: true });
await writeFile(join(memoryDir, "personality.md"), "You keep the records of a fictional sample-crate depot.\n");
const runtime = await fakeRuntime(root, script);
if (live) {
  runtime.registerProvider(live.ref.provider, {
    name: live.ref.provider,
    api: "openai-completions",
    baseUrl: live.baseUrl,
    models: [{ id: live.ref.id, name: live.ref.id, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 4096 }],
  });
  await runtime.setRuntimeApiKey(live.ref.provider, live.apiKey);
}
const ref = live?.ref ?? fake;
const config = readConfig({
  HOME: home, PENELOPE_MEMORY: memoryDir, PENELOPE_SOURCES: sourcesDir,
  PENELOPE_BACKEND_URL: "http://unused.invalid", PENELOPE_BACKEND_TOKEN: "unused",
  PENELOPE_NAME: "Marlo", PENELOPE_ROLE: "a sample-crate depot clerk", PENELOPE_OWNER: "the depot lead",
  PENELOPE_IMAGE_SKILLS: "", PENELOPE_MODEL: `${ref.provider}/${ref.id}`, PENELOPE_THINKING: "off",
});
const backend = new ReplayBackend(memoryDir, sourcesDir);
await backend.seed();
const runner = new Runner({
  config, backend, modelRuntime: runtime,
  settings: () => SettingsManager.inMemory({ retry: { enabled: false } }),
});
const controller = new AbortController();
const timeout = setTimeout(() => {
  console.error(`${label}: replay exceeded 20 minutes`);
  process.exit(1);
}, 20 * 60_000);
const nights: { date: string; elapsedSeconds: number; stages: unknown }[] = [];
const running = runner.run(controller.signal);
// An early runner exit must fail the replay, not leave it waiting for an ack.
async function ack(delivery: Promise<void>) {
  await Promise.race([delivery, running.then(() => { throw new Error("Runner stopped before acknowledging the event"); })]);
}
try {
  mock.timers.enable({ apis: ["Date"], now: Date.parse(`${days[0].date}T09:00:00Z`) });
  for (const day of days) {
    mock.timers.setTime(Date.parse(`${day.date}T09:00:00Z`));
    const receipt = "receipt" in day ? day.receipt : undefined;
    if (receipt) await writeFile(receiptFile, receipt);
    daytime = {
      inputs: [join(sourcesDir, "bulletin", `${day.date}.jsonl`), ...(receipt ? [receiptFile] : [])],
      output: receipt ?? day.text,
      file: day.file,
      note: day.note,
      step: 0,
    };
    backend.selection = { model: `${fake.provider}/${fake.id}`, thinking: "off" };
    backend.toolResults = [];
    await ack(backend.deliver("bulletin", day.id, day.summary, { text: day.text }));
    assert.equal(backend.ends.at(-1)?.result, "done", `Daytime turn on ${day.date}`);
    assert.ok(backend.toolResults.some((r) => !r.is_error && r.output.includes(daytime!.output)), `Original tool result on ${day.date}`);
    assert.equal(await readFile(join(memoryDir, day.file), "utf8"), day.note);
    if (receipt) await unlink(receiptFile);
    daytime = undefined;

    mock.timers.setTime(Date.parse(`${day.date}T23:00:00Z`));
    backend.selection = { model: `${ref.provider}/${ref.id}`, thinking: "off" };
    const nightStart = performance.now();
    const previous = backend.rotations.length;
    await ack(backend.deliver("control", `nightly@${Date.now()}`, "the nightly switch", { kind: "nightly" }));
    assert.equal(backend.rotations.length, previous + 1, `Missing rotation on ${day.date}`);
    const { stages } = backend.rotations.at(-1)!;
    assert.ok(stages, `Missing stage results on ${day.date}`);
    for (const [name, stage] of Object.entries(stages)) {
      assert.equal(stage.result, "done", `Night ${day.date}: ${name}: ${stage.reason ?? ""}`);
    }
    nights.push({ date: day.date, elapsedSeconds: (performance.now() - nightStart) / 1000, stages });
  }
} catch (error) {
  clearTimeout(timeout);
  throw error;
} finally {
  mock.timers.reset();
  controller.abort();
  await running.catch((error: unknown) => {
    clearTimeout(timeout);
    throw error;
  });
}
try {
  answering = true;
  const raw = await answer(runtime, ref, memoryDir, home, config.agentDir);
  if (!live) assert.ok(smokeAnswerRead, "The fresh answer session must be able to read the last daytime note from memory");
  console.log(JSON.stringify({ label, revision, mode, model: `${ref.provider}/${ref.id}`, elapsedSeconds: (performance.now() - started) / 1000,
    nights, answer: raw, score: score(raw) }));
} finally {
  clearTimeout(timeout);
}
