// Background jobs (ADR-0030): the main agent starts a command with a tool that
// returns at once; the command runs in a process group of its own, writes all
// of its output to a file, and when it ends the runner puts a `job` event to
// the main agent with how it ended and the tail of its output.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { JobEnd } from "@penelope/contract";

import { Backend } from "../src/backend.ts";
import { JobError, Jobs } from "../src/jobs.ts";
import { FakeBackend, TOKEN, until } from "./fake-backend.ts";
import { closers, world } from "./world.ts";

interface Place {
  fake: FakeBackend;
  home: string;
  dir: string;
  logs: string[];
  /** Jobs over the same places, as a runner started again would have them. */
  jobs(limits?: Partial<{ max: number; maxSeconds: number; tailChars: number }>): Promise<Jobs>;
}

async function place(): Promise<Place> {
  const root = await mkdtemp(join(tmpdir(), "jobs-"));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const fake = new FakeBackend();
  closers.push(() => fake.close());
  const backend = new Backend({ url: await fake.url, token: TOKEN, agent: "main" });
  const dir = join(home, "jobs");
  const logs: string[] = [];
  return {
    fake,
    home,
    dir,
    logs,
    async jobs(limits = {}) {
      const jobs = new Jobs({
        home,
        dir,
        limits: { max: 5, maxSeconds: 86400, tailChars: 4000, ...limits },
        backend,
        log: (line) => logs.push(line),
        retryMs: 20,
        graceMs: 200,
      });
      closers.push(() => jobs.stop());
      await jobs.restore();
      return jobs;
    },
  };
}

const ends = (fake: FakeBackend) => fake.jobEvents.map((event) => event.payload);
const endOf = async (fake: FakeBackend, id: string): Promise<JobEnd> => {
  await until(() => fake.jobEvents.some((event) => event.id === id), 10_000);
  return fake.jobEvents.find((event) => event.id === id)!.payload;
};

/** Whether a process is there. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a job starts at once, and its end reaches the main agent with the exit code and the tail of its output", async () => {
  // Guards against: a start that waits for the command, output of one of the two streams lost, or an end without
  // what the main agent needs to go on (ADR-0030 Decision 1 and 2).
  const { fake, home, jobs } = await place();
  const started = Date.now();
  const job = await (await jobs()).start({ command: "echo out; echo err >&2; sleep 0.3; exit 3" });
  assert.ok(Date.now() - started < 250, "start returned before the command ended");
  assert.equal(fake.jobEvents.length, 0);
  assert.equal(job.cwd, home);
  assert.equal(job.output, join(home, "jobs", job.id, "output.log"));

  const end = await endOf(fake, job.id);
  assert.equal(end.job, job.id);
  assert.equal(end.command, "echo out; echo err >&2; sleep 0.3; exit 3");
  assert.equal(end.cwd, home);
  assert.equal(end.end, "exited");
  assert.equal(end.exit_code, 3);
  assert.equal(end.signal, undefined);
  assert.equal(end.output, job.output);
  assert.equal(end.tail, "out\nerr\n");
  assert.equal(end.tail_truncated, false);
  assert.equal(end.output_bytes, 8);
  assert.equal(await readFile(job.output, "utf8"), "out\nerr\n");
  assert.ok(Date.parse(end.ended_at) >= Date.parse(end.started_at));
  assert.equal(typeof end.seconds, "number");

  const [event] = fake.jobEvents;
  assert.equal(event!.agent, "main");
  assert.equal(event!.summary, "[exit 3] echo out; echo err >&2; sleep 0.3; exit 3");
});

test("a background command receives its own job ID", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "job-id-"));
  let finish!: (event: JobEnd) => void;
  const ended = new Promise<JobEnd>((resolve) => (finish = resolve));
  const backend = new Backend({ url: "", token: "", agent: "main" });
  backend.jobEvent = async ({ payload }) => finish(payload);
  const jobs = new Jobs({
    home: dir, dir: join(dir, "jobs"), backend, log: () => {}, retryMs: 20,
    limits: { max: 1, maxSeconds: 3, tailChars: 4000 },
  });
  t.after(async () => {
    await jobs.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const job = await jobs.start({ command: 'printf "%s" "$PENELOPE_JOB_ID"' });
  assert.equal((await ended).tail, job.id);
});

test("the tail is cut to the limit of characters, and the whole output stays in the file", async () => {
  const { fake, jobs } = await place();
  const job = await (await jobs({ tailChars: 10 })).start({ command: "printf 'abcdefghij%.0s' 1 2 3; printf 'あいうえおかきくけこ'" });
  const end = await endOf(fake, job.id);
  assert.equal(end.tail, "あいうえおかきくけこ");
  assert.equal(end.tail_truncated, true);
  assert.equal(end.output_bytes, 30 + 30);
  assert.equal((await readFile(job.output, "utf8")).length, 40);
});

test("the working directory is the one given, relative to home", async () => {
  const { fake, home, jobs } = await place();
  await mkdir(join(home, "repo"));
  const job = await (await jobs()).start({ command: "pwd", cwd: "repo" });
  assert.equal((await endOf(fake, job.id)).tail, `${join(home, "repo")}\n`);
});

test("a start is refused without a working directory, or with a time over the limit", async () => {
  // Guards against: a command started where it cannot run, or one let run past the runner's limit (ADR-0030 項 3).
  const { fake, home, jobs } = await place();
  const all = await jobs({ maxSeconds: 60 });
  await writeFile(join(home, "file"), "");
  await assert.rejects(all.start({ command: "true", cwd: "missing" }), (error: unknown) => error instanceof JobError && /does not exist/.test(error.message));
  await assert.rejects(all.start({ command: "true", cwd: "file" }), (error: unknown) => error instanceof JobError && /not a directory/.test(error.message));
  await assert.rejects(all.start({ command: "true", timeout_seconds: 61 }), (error: unknown) => error instanceof JobError && /60/.test(error.message));
  await assert.rejects(all.start({ command: "true", timeout_seconds: 0 }), JobError);
  assert.deepEqual(all.list(), []);
  assert.equal(fake.jobEvents.length, 0);
});

test("past the limit of jobs at once, a start is refused with the jobs that run", async () => {
  // Guards against: a job kept waiting without a word, or one let run without an end ever coming (ADR-0030 項 3).
  const { fake, jobs } = await place();
  const all = await jobs({ max: 1 });
  const first = await all.start({ command: "sleep 30" });
  await assert.rejects(
    all.start({ command: "echo second" }),
    (error: unknown) => error instanceof JobError && error.message.includes(first.id) && error.message.includes("sleep 30"),
  );
  assert.deepEqual(all.list().map((job) => job.id), [first.id]);
  await all.kill(first.id);
  await endOf(fake, first.id);
  const second = await all.start({ command: "echo second" });
  assert.equal((await endOf(fake, second.id)).tail, "second\n");
});

test("a job past its time is ended with its whole process group, as timed out", async () => {
  // Guards against: a command that never ends filling a place for good, or children of it left running.
  const { fake, home, jobs } = await place();
  const job = await (await jobs()).start({ command: "sleep 30 & echo $! > child.pid; wait", timeout_seconds: 1 });
  await until(() => fake.jobEvents.length > 0, 10_000);
  const end = await endOf(fake, job.id);
  assert.equal(end.end, "timed-out");
  assert.equal(end.signal, "SIGTERM");
  const child = Number(await readFile(join(home, "child.pid"), "utf8"));
  await until(() => !alive(child), 2000);
});

test("a job that does not end on SIGTERM is killed after the grace", async () => {
  const { fake, jobs } = await place();
  const job = await (await jobs()).start({ command: "trap '' TERM; sleep 30", timeout_seconds: 1 });
  const end = await endOf(fake, job.id);
  assert.equal(end.end, "timed-out");
  assert.equal(end.signal, "SIGKILL");
});

test("a job stopped by the main agent ends as stopped, and its end still comes", async () => {
  const { fake, jobs } = await place();
  const all = await jobs();
  const job = await all.start({ command: "sleep 30" });
  const [listed] = all.list();
  assert.deepEqual([listed!.id, listed!.command, listed!.output], [job.id, "sleep 30", job.output]);
  assert.equal(listed!.timeout_seconds, 86400);
  await all.kill(job.id);
  assert.deepEqual(all.list(), [], "a stopped job is no longer listed");
  const end = await endOf(fake, job.id);
  assert.equal(end.end, "stopped");
  assert.equal(end.signal, "SIGTERM");
  await assert.rejects(all.kill(job.id), (error: unknown) => error instanceof JobError && /no running job/.test(error.message));
  await assert.rejects(all.kill("nope"), JobError);
});

test("a job ended by a signal from elsewhere ends as signaled", async () => {
  const { fake, jobs } = await place();
  const job = await (await jobs()).start({ command: "kill -KILL $$" });
  const end = await endOf(fake, job.id);
  assert.equal(end.end, "signaled");
  assert.equal(end.signal, "SIGKILL");
  assert.equal(end.exit_code, undefined);
  assert.equal(fake.jobEvents[0]!.summary, "[SIGKILL] kill -KILL $$");
});

test("an end the backend does not take is sent again with the same id", async () => {
  // Guards against: the end of a job lost while the backend is away (ADR-0030 「失敗したときの倒し方」).
  const { fake, dir, jobs } = await place();
  fake.failJobEvents = 2;
  const job = await (await jobs()).start({ command: "echo once" });
  await until(() => fake.jobEvents.length === 1, 10_000);
  const tries = fake.sent("POST", "/v1/job-events") as { id: string }[];
  assert.equal(tries.length, 3);
  assert.ok(tries.every((t) => t.id === job.id));
  await until(() => (JSON.parse(readFileSync(join(dir, job.id, "job.json"), "utf8")) as { pending?: unknown }).pending === undefined);
});

test("after the runner starts again, a job that was running is told as interrupted and its group is killed", async () => {
  // Guards against: a job whose end nobody tells, or processes the new runner does not know left running
  // (ADR-0030 Decision 4).
  const { fake, home, dir, jobs } = await place();
  // A process group the last runner left: the record says it runs.
  const left = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  left.unref();
  const id = "left-over";
  await mkdir(join(dir, id), { recursive: true });
  await writeFile(join(dir, id, "output.log"), "half done\n");
  await writeFile(
    join(dir, id, "job.json"),
    JSON.stringify({ id, command: "make all", cwd: home, pid: left.pid, started_at: "2026-11-16T09:00:00.000Z", timeout_seconds: 600 }),
  );
  await jobs();
  const end = await endOf(fake, id);
  assert.equal(end.end, "interrupted");
  assert.equal(end.command, "make all");
  assert.equal(end.tail, "half done\n");
  assert.equal(end.started_at, "2026-11-16T09:00:00.000Z");
  await until(() => !alive(left.pid!), 2000);
  assert.equal(fake.jobEvents.length, 1);
});

test("a runner that stops ends its jobs without telling, and the next one tells them as interrupted", async () => {
  const { fake, jobs } = await place();
  const first = await jobs();
  const job = await first.start({ command: "sleep 30" });
  await first.stop();
  assert.equal(fake.jobEvents.length, 0, "the stopping runner sends nothing");
  await jobs();
  assert.equal((await endOf(fake, job.id)).end, "interrupted");
});

test("an end the last runner did not get across is sent by the next", async () => {
  const { fake, jobs } = await place();
  fake.failJobEvents = 1_000;
  const first = await jobs();
  const job = await first.start({ command: "echo kept" });
  await until(() => (fake.sent("POST", "/v1/job-events") as unknown[]).length > 0, 10_000);
  await first.stop();
  fake.failJobEvents = 0;
  await jobs();
  const end = await endOf(fake, job.id);
  assert.equal(end.end, "exited");
  assert.equal(end.tail, "kept\n");
});

test("the main agent starts a job with its tool, and the end comes later as a job event", async () => {
  // Guards against: the tools not given to the main agent, or a turn held until the command ends.
  const { fake, start, calls } = await world();
  await start((call) => {
    if (call.lastRole !== "user") return { text: "done" };
    if (call.lastText.includes("start it")) return { calls: [{ tool: "job_start", args: { command: "sleep 0.5; echo finished" } }] };
    return { text: "noted" };
  });
  fake.push({
    seq: 1,
    source: "ui",
    id: "m-1",
    occurred_at: "2026-11-16T09:00:00Z",
    received_at: "2026-11-16T09:00:00Z",
    summary: "start it",
    delivery: "now",
    inline: true,
    payload: { text: "start it" },
    appended: { path: "/sources/ui/2026-11-16.jsonl", lines: [1, 1] },
  });
  await until(() => fake.jobEvents.length === 1, 10_000);
  const main = calls.find((call) => call.lastText.includes("start it"))!;
  for (const tool of ["job_start", "job_list", "job_stop"]) assert.ok(main.tools.includes(tool), tool);
  assert.equal(fake.jobEvents[0]!.payload.tail, "finished\n");
  assert.equal(ends(fake).length, 1);
});
