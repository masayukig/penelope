// Background jobs (ADR-0030): commands the main agent starts with a tool that
// returns at once. Each runs under bash in a process group of its own, as the
// same user, with its standard output and standard error both written to one
// file. When it ends, the runner puts a `job` event to the main agent with how
// it ended and the end of its output.
//
// Each job has a directory of its own under the config's jobDir, named by its
// id: job.json, its record, and output.log. The record keeps the end the
// backend has not taken yet, so that it survives the runner stopping and is
// sent again with the same id. A runner that starts finds the jobs the last
// one left running, kills what is left of their process groups and tells them
// as interrupted, as how they ended cannot be known.

import { randomBytes } from "node:crypto";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { JobEnd, JobEndKind } from "@penelope/contract";

import type { Backend } from "./backend.ts";
import type { JobLimits } from "./config.ts";

/** What job.json keeps of a job. */
export interface JobRecord {
  id: string;
  command: string;
  cwd: string;
  /** The process group's leader. */
  pid: number;
  started_at: string;
  timeout_seconds: number;
  /** Its end, until the backend has taken it. */
  pending?: { id: string; summary: string; payload: JobEnd };
  /** The backend has taken its end. */
  done?: true;
}

/** A running job, as `job_start` and `job_list` give it. */
export interface JobInfo {
  id: string;
  command: string;
  cwd: string;
  started_at: string;
  timeout_seconds: number;
  output: string;
}

/** What a tool refuses; its message is the tool's error. */
export class JobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobError";
  }
}

export interface StartJob {
  command: string;
  cwd?: string;
  timeout_seconds?: number;
}

export interface JobsOptions {
  /** HOME: a relative working directory is taken from it, and it is the default. */
  home: string;
  dir: string;
  limits: JobLimits;
  backend: Backend;
  log: (line: string) => void;
  /** The first wait before an end is sent again; it doubles up to 30 seconds. */
  retryMs: number;
  /** How long a job has after SIGTERM before SIGKILL. */
  graceMs?: number;
}

interface Live {
  record: JobRecord;
  child: ChildProcess;
  /** Why the runner is ending it, once it is. */
  ending?: "stopped" | "timed-out";
  /** The last signal the runner sent it. */
  sent?: NodeJS.Signals;
  timers: NodeJS.Timeout[];
  exited: Promise<void>;
}

const RECORD = "job.json";
const OUTPUT = "output.log";
const SUMMARY_MAX = 200;
const RETRY_MAX_MS = 30_000;

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

function summaryOf(end: JobEnd): string {
  const head =
    end.end === "exited" ? `exit ${end.exit_code}` : end.end === "signaled" ? end.signal! : end.end === "timed-out" ? "timed out" : end.end;
  const line = [...end.command.split("\n")[0]!.trim()].slice(0, SUMMARY_MAX).join("");
  return `[${head}] ${line}`;
}

/** Sends `signal` to the process group; false when there is none. */
function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * The last `chars` characters of the file, read from its end, and its size.
 * A character cut by where the read starts is left out.
 */
async function tailOf(path: string, chars: number): Promise<{ tail: string; truncated: boolean; bytes: number }> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return { tail: "", truncated: false, bytes: 0 };
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, chars * 4);
    const start = size - length;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    let from = 0;
    if (start > 0) while (from < buffer.length && (buffer[from]! & 0xc0) === 0x80) from++;
    const all = [...buffer.subarray(from).toString("utf8")];
    return { tail: all.slice(-chars).join(""), truncated: start > 0 || all.length > chars, bytes: size };
  } finally {
    await handle.close();
  }
}

export class Jobs {
  private readonly home: string;
  private readonly dir: string;
  private readonly limits: JobLimits;
  private readonly backend: Backend;
  private readonly log: (line: string) => void;
  private readonly retryMs: number;
  private readonly graceMs: number;
  private readonly running = new Map<string, Live>();
  /** Starts past their checks, not yet running. */
  private reserved = 0;
  /** Records whose end is to be sent, oldest first. */
  private readonly outbox: JobRecord[] = [];
  private delivering: Promise<void> | undefined;
  private readonly saving = new Map<string, Promise<void>>();
  private readonly stopped = new AbortController();
  private stopping: Promise<void> | undefined;

  constructor(options: JobsOptions) {
    this.home = options.home;
    this.dir = options.dir;
    this.limits = options.limits;
    this.backend = options.backend;
    this.log = options.log;
    this.retryMs = options.retryMs;
    this.graceMs = options.graceMs ?? 5000;
  }

  /** The jobs the last runner left: those that ran are killed and told as interrupted; ends not taken are sent. */
  async restore(): Promise<void> {
    let ids: string[];
    try {
      ids = await readdir(this.dir);
    } catch {
      return;
    }
    for (const id of ids.sort()) {
      let record: JobRecord;
      try {
        record = JSON.parse(await readFile(join(this.dir, id, RECORD), "utf8")) as JobRecord;
      } catch (error) {
        this.log(`job ${id} left out: its record cannot be read: ${failure(error)}`);
        continue;
      }
      if (record.done) continue;
      if (!record.pending) {
        if (signalGroup(record.pid, "SIGKILL")) this.log(`job ${id}: killed what was left of its process group`);
        await this.end(record, "interrupted", {});
      }
      this.send(record);
    }
  }

  /** Starts a job and returns as soon as it runs. */
  async start(request: StartJob): Promise<JobInfo> {
    const timeout = request.timeout_seconds ?? this.limits.maxSeconds;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > this.limits.maxSeconds) {
      throw new JobError(`timeout_seconds must be a whole number of seconds from 1 to ${this.limits.maxSeconds}, the runner's limit.`);
    }
    const cwd = resolve(this.home, request.cwd ?? ".");
    const info = await stat(cwd).catch(() => undefined);
    if (!info) throw new JobError(`The working directory ${cwd} does not exist.`);
    if (!info.isDirectory()) throw new JobError(`The working directory ${cwd} is not a directory.`);
    if (this.running.size + this.reserved >= this.limits.max) {
      throw new JobError(`${this.limits.max} jobs are running, the most at once; none was started. The running jobs: ${JSON.stringify(this.list())}`);
    }
    this.reserved++;
    try {
      await mkdir(this.dir, { recursive: true });
      let id: string;
      for (;;) {
        id = randomBytes(4).toString("hex");
        try {
          await mkdir(join(this.dir, id));
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      const output = join(this.dir, id, OUTPUT);
      const handle = await open(output, "a", 0o600);
      // Nothing is awaited between the spawn and the listeners, so that an end
      // or a failure to start cannot come before they are there.
      let child: ChildProcess;
      let live: Live | undefined;
      let failed: Promise<Error> | undefined;
      try {
        child = spawn("bash", ["-c", request.command], { cwd, detached: true, stdio: ["ignore", handle.fd, handle.fd] });
        const pid = child.pid;
        if (pid === undefined) {
          failed = new Promise<Error>((resolve) => child.once("error", resolve));
        } else {
          const record: JobRecord = { id, command: request.command, cwd, pid, started_at: new Date().toISOString(), timeout_seconds: timeout };
          let exited!: () => void;
          const started: Live = { record, child, timers: [], exited: new Promise((resolve) => (exited = resolve)) };
          child.once("exit", (code, signal) => {
            void this.finished(started, code, signal).finally(exited);
          });
          this.running.set(id, started);
          started.timers.push(setTimeout(() => this.terminate(started, "timed-out"), timeout * 1000));
          live = started;
        }
      } finally {
        await handle.close();
      }
      if (!live) throw new JobError(`The command could not be started: ${(await failed!).message}`);
      const { record } = live;
      await this.save(record);
      return this.infoOf(record);
    } finally {
      this.reserved--;
    }
  }

  /** The running jobs. */
  list(): JobInfo[] {
    return [...this.running.values()].map(({ record }) => this.infoOf(record));
  }

  /** Stops a running job with its process group; returns once it has ended. */
  async kill(id: string): Promise<void> {
    const live = this.running.get(id);
    if (!live) throw new JobError(`There is no running job ${JSON.stringify(id)}.`);
    this.terminate(live, "stopped");
    await live.exited;
  }

  /**
   * Ends the jobs as the runner stops, without telling: their records stay
   * running, for the next runner to tell as interrupted.
   */
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.stopped.abort();
      for (const live of this.running.values()) {
        for (const timer of live.timers) clearTimeout(timer);
        signalGroup(live.record.pid, "SIGKILL");
      }
      await Promise.allSettled([...this.running.values()].map((live) => live.exited));
      await this.delivering;
      await Promise.allSettled([...this.saving.values()]);
    })();
    return this.stopping;
  }

  // ── Within ──

  private infoOf(record: JobRecord): JobInfo {
    const { id, command, cwd, started_at, timeout_seconds } = record;
    return { id, command, cwd, started_at, timeout_seconds, output: join(this.dir, id, OUTPUT) };
  }

  /** SIGTERM to the process group, then SIGKILL after the grace. */
  private terminate(live: Live, why: "stopped" | "timed-out"): void {
    if (live.ending) return;
    live.ending = why;
    live.sent = "SIGTERM";
    signalGroup(live.record.pid, "SIGTERM");
    live.timers.push(
      setTimeout(() => {
        if (!this.running.has(live.record.id)) return;
        live.sent = "SIGKILL";
        signalGroup(live.record.pid, "SIGKILL");
      }, this.graceMs),
    );
  }

  private async finished(live: Live, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    for (const timer of live.timers) clearTimeout(timer);
    this.running.delete(live.record.id);
    if (this.stopped.signal.aborted) return;
    const kind: JobEndKind = live.ending ?? (signal ? "signaled" : "exited");
    const how: { exit_code?: number; signal?: string } = {};
    if (code !== null) how.exit_code = code;
    const by = signal ?? (live.ending ? live.sent : undefined);
    if (by) how.signal = by;
    await this.end(live.record, kind, how);
    this.send(live.record);
  }

  /** Writes the job's end into its record, to be sent. */
  private async end(record: JobRecord, kind: JobEndKind, how: { exit_code?: number; signal?: string }): Promise<void> {
    const output = join(this.dir, record.id, OUTPUT);
    const { tail, truncated, bytes } = await tailOf(output, this.limits.tailChars);
    const ended = new Date();
    const payload: JobEnd = {
      job: record.id,
      command: record.command,
      cwd: record.cwd,
      end: kind,
      ...how,
      started_at: record.started_at,
      ended_at: ended.toISOString(),
      seconds: Math.max(0, Math.round((ended.getTime() - Date.parse(record.started_at)) / 1000)),
      output,
      output_bytes: bytes,
      tail,
      tail_truncated: truncated,
    };
    record.pending = { id: record.id, summary: summaryOf(payload), payload };
    await this.save(record);
  }

  /** Puts the job's end in the outbox, which is sent in order, each again until the backend takes it. */
  private send(record: JobRecord): void {
    this.outbox.push(record);
    this.pump();
  }

  private pump(): void {
    if (this.delivering || this.outbox.length === 0 || this.stopped.signal.aborted) return;
    this.delivering = (async () => {
      let failures = 0;
      while (this.outbox.length > 0 && !this.stopped.signal.aborted) {
        const next = this.outbox[0]!;
        try {
          await this.backend.jobEvent(next.pending!);
        } catch (error) {
          failures++;
          this.log(`end of job ${next.id} not sent: ${failure(error)}`);
          await this.sleep(Math.min(this.retryMs * 2 ** (failures - 1), RETRY_MAX_MS));
          continue;
        }
        failures = 0;
        this.outbox.shift();
        delete next.pending;
        next.done = true;
        await this.save(next).catch((error: unknown) => this.log(`record of job ${next.id} not written: ${failure(error)}`));
      }
    })().finally(() => {
      this.delivering = undefined;
      this.pump();
    });
  }

  private save(record: JobRecord): Promise<void> {
    const path = join(this.dir, record.id, RECORD);
    const text = `${JSON.stringify(record)}\n`;
    const next = (this.saving.get(record.id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        await writeFile(`${path}.tmp`, text, { mode: 0o600 });
        await rename(`${path}.tmp`, path);
      });
    this.saving.set(record.id, next);
    return next;
  }

  private sleep(ms: number): Promise<void> {
    const signal = this.stopped.signal;
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
