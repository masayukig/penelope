// The runner: it takes events from the backend and makes turns of them in her
// one session (ADR-0002), reports what happens in each turn, and switches the
// session at night (ADR-0007).
//
// One turn is one run of Pi: from the prompt until Pi will not go on by
// itself. An event that comes during a turn joins it: `now` as a steer,
// `batch` as a follow-up. The events of a turn are acked after the backend
// has been told the turn ended.

import { randomUUID } from "node:crypto";

import type { AgentSession, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Activity, ControlPayload, DeliveredEvent } from "@penelope/contract";

import { TurnRecorder } from "./activities.ts";
import type { Backend } from "./backend.ts";
import type { Config } from "./config.ts";
import {
  curatorManager,
  newSessionFile,
  openFile,
  openSession,
  type PiSetup,
  readState,
  type SessionState,
  writeState,
} from "./pi.ts";
import {
  curatorInput,
  curatorSystemPrompt,
  type Places,
  readPromptFiles,
  reflectionInput,
  systemPrompt,
} from "./prompts.ts";
import { backendTools } from "./tools.ts";
import { formatEvents } from "./turn-input.ts";

export interface RunnerOptions {
  config: Config;
  backend: Backend;
  modelRuntime: ModelRuntime;
  settings: () => SettingsManager;
  log?: (line: string) => void;
}

interface Turn {
  session: AgentSession;
  seqs: number[];
  /** The steers and follow-ups handed to Pi during the turn, until Pi has them. */
  queued: Promise<unknown>[];
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

/** YYYY-MM-DD in the runner's time zone. */
const today = () => new Date().toLocaleDateString("sv-SE");

export class Runner {
  private readonly config: Config;
  private readonly backend: Backend;
  private readonly setup: PiSetup;
  private readonly log: (line: string) => void;
  private readonly places: Places;

  private session: AgentSession | undefined;
  private state: SessionState | undefined;
  private turn: Turn | undefined;
  /** Events taken but not yet acked: a second delivery of one is not taken again. */
  private readonly taken = new Set<number>();
  private readonly inbox: DeliveredEvent[] = [];
  private wake: (() => void) | undefined;
  private sending: Promise<void> = Promise.resolve();

  constructor(options: RunnerOptions) {
    this.config = options.config;
    this.backend = options.backend;
    this.log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.setup = {
      config: options.config,
      modelRuntime: options.modelRuntime,
      settings: options.settings,
      tools: backendTools(options.backend),
    };
    this.places = { memory: options.config.memoryDir, sources: options.config.sourcesDir, home: options.config.home };
  }

  /** Runs until `signal` aborts. */
  async run(signal: AbortSignal): Promise<void> {
    await this.open();
    signal.addEventListener("abort", () => {
      this.wake?.();
      void this.session?.abort();
    });
    try {
      await Promise.all([this.poll(signal), this.work(signal)]);
    } finally {
      this.session?.dispose();
    }
  }

  private async mainPrompt(): Promise<string> {
    const files = await readPromptFiles(this.config.memoryDir, this.config.promptFileMaxBytes);
    return systemPrompt(this.config.identity, this.places, files);
  }

  /** Her session as the last run left it, or a new one. */
  private async open(): Promise<void> {
    this.state = await readState(this.config);
    if (!this.state) {
      this.state = { file: await newSessionFile(this.config) };
      await writeState(this.config, this.state);
    }
    this.session = await openSession(this.setup, await this.mainPrompt(), openFile(this.config, this.state.file));
  }

  // ── Taking events ──

  private async poll(signal: AbortSignal): Promise<void> {
    let after = 0;
    let failures = 0;
    while (!signal.aborted) {
      let events: DeliveredEvent[];
      try {
        events = await this.backend.poll(after, this.config.pollWaitSeconds, signal);
        failures = 0;
      } catch (error) {
        if (signal.aborted) return;
        failures++;
        this.log(`poll failed: ${(error as Error).message}`);
        await sleep(Math.min(1000 * 2 ** (failures - 1), 30_000), signal);
        continue;
      }
      const fresh = events.filter((event) => !this.taken.has(event.seq));
      for (const event of fresh) {
        this.taken.add(event.seq);
        after = Math.max(after, event.seq);
      }
      if (fresh.length > 0) this.deliver(fresh);
    }
  }

  /** Into the running turn when there is one, else into the inbox for the next. */
  private deliver(events: DeliveredEvent[]): void {
    const turn = this.turn;
    const control = events.some((event) => event.source === "control");
    if (!turn || control || this.inbox.length > 0) {
      this.inbox.push(...events);
      this.wake?.();
      return;
    }
    const now = events.filter((event) => event.delivery === "now");
    const batch = events.filter((event) => event.delivery === "batch");
    if (now.length > 0) turn.queued.push(turn.session.steer(formatEvents(now)));
    if (batch.length > 0) turn.queued.push(turn.session.followUp(formatEvents(batch)));
    turn.seqs.push(...events.map((event) => event.seq));
  }

  // ── Making turns ──

  private async work(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (this.inbox.length === 0) {
        await new Promise<void>((resolve) => (this.wake = resolve));
        this.wake = undefined;
        continue;
      }
      const first = this.inbox[0]!;
      if (first.source === "control") {
        this.inbox.shift();
        await this.control(first);
        continue;
      }
      const until = this.inbox.findIndex((event) => event.source === "control");
      const events = this.inbox.splice(0, until < 0 ? this.inbox.length : until);
      await this.turnOf(
        this.session!,
        formatEvents(events),
        events.map((event) => event.seq),
      );
    }
  }

  private send(activity: Activity): void {
    this.sending = this.sending
      .then(() => this.backend.activity([activity]))
      .catch((error: unknown) => this.log(`activity not sent: ${(error as Error).message}`));
  }

  /**
   * One turn: Pi runs `input`, and what comes during it joins it. Then the
   * backend is told the turn ended (it commits /memory), and the events are
   * acked. A turn that fails is not acked: the backend hands its events over
   * again.
   */
  private async turnOf(session: AgentSession, input: string, seqs: number[], joinable = true): Promise<void> {
    const recorder = new TurnRecorder(randomUUID(), () => new Date().toISOString(), (activity) => this.send(activity));
    const unsubscribe = session.subscribe((event) => recorder.handle(event));
    const turn: Turn = { session, seqs: [...seqs], queued: [] };
    if (joinable) this.turn = turn;
    recorder.start();
    let failed = false;
    try {
      let text = input;
      for (;;) {
        await session.prompt(text);
        // Pi may have finished before a steer or follow-up reached it; what is
        // left in its queue is run as a prompt of the same turn.
        let count = 0;
        while (count !== turn.queued.length) {
          count = turn.queued.length;
          await Promise.allSettled(turn.queued);
        }
        if (session.pendingMessageCount === 0) break;
        const { steering, followUp } = session.clearQueue();
        text = [...steering, ...followUp].join("\n\n");
      }
    } catch (error) {
      failed = true;
      this.log(`turn ${recorder.turnId} failed: ${(error as Error).message}`);
    } finally {
      if (joinable) this.turn = undefined;
      unsubscribe();
    }
    recorder.end();
    await this.sending;
    try {
      await this.backend.turnEnd(recorder.turnId);
    } catch (error) {
      this.log(`turn end not sent: ${(error as Error).message}`);
    }
    if (failed) {
      for (const seq of turn.seqs) this.taken.delete(seq);
      return;
    }
    await this.ack(turn.seqs);
  }

  private async ack(seqs: number[]): Promise<void> {
    if (seqs.length === 0) return;
    try {
      await this.backend.ack(seqs);
    } catch (error) {
      this.log(`ack not sent: ${(error as Error).message}`);
    }
    for (const seq of seqs) this.taken.delete(seq);
  }

  // ── The nightly switch ──

  private async control(event: DeliveredEvent): Promise<void> {
    const payload = (event.inline ? event.payload : undefined) as ControlPayload | undefined;
    if (payload?.kind !== "nightly") {
      this.log(`unknown control event ${event.seq}; acked without action`);
      await this.ack([event.seq]);
      return;
    }
    // A nightly event that comes again after its switch was made only needs telling.
    if (this.state?.nightly !== event.seq) await this.nightly(event.seq);
    await this.backend.rotated().catch((error: unknown) => this.log(`rotation not sent: ${(error as Error).message}`));
    await this.ack([event.seq]);
  }

  /** Her reflection, the curator's turn, then a new session (ADR-0007). */
  private async nightly(seq: number): Promise<void> {
    await this.turnOf(this.session!, reflectionInput(this.places), [], false);

    const curator = await openSession(
      { ...this.setup, tools: [] },
      curatorSystemPrompt(this.config.identity, this.places),
      curatorManager(this.config),
    );
    try {
      await this.turnOf(curator, curatorInput(this.places, today()), [], false);
    } finally {
      curator.dispose();
    }

    const state = { file: await newSessionFile(this.config), nightly: seq };
    const session = await openSession(this.setup, await this.mainPrompt(), openFile(this.config, state.file));
    await writeState(this.config, state);
    this.session?.dispose();
    this.session = session;
    this.state = state;
  }
}
