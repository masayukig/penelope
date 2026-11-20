import { Backend } from "../packages/runner/src/backend.ts";
import { Memory } from "../packages/backend/src/memory.ts";
import { Sources } from "../packages/backend/src/sources.ts";
import type { Activity, DeliveredEvent, ModelSelection, SessionRotatedRequest, TurnEndRequest } from "@penelope/contract";

// In-process sandbox API, with the real source format and turn-end Git commits.
// Deliver one event at a time and don't advance the replay clock until its ack.
export class ReplayBackend extends Backend {
  private pending?: { event: DeliveredEvent; handed: boolean; ack: () => void };
  private wake?: () => void;
  private readonly memory: Memory;
  private readonly sources: Sources;
  readonly ends: Omit<TurnEndRequest, "agent">[] = [];
  readonly rotations: Omit<SessionRotatedRequest, "agent">[] = [];
  selection: ModelSelection | null = null;
  toolResults: Extract<Activity, { kind: "tool_result" }>[] = [];

  constructor(memory: string, sources: string) {
    super({ url: "http://unused.invalid", token: "unused", agent: "main" });
    this.memory = new Memory(memory, { name: "Night Replay", email: "replay@example.com" });
    this.sources = new Sources(sources, "UTC");
  }

  async seed(): Promise<void> {
    await this.memory.commit({ agent: "main", turnId: "seed" });
  }

  deliver(source: string, id: string, summary: string, payload: unknown): Promise<void> {
    if (this.pending) throw new Error("Previous event is still outstanding");
    const occurred_at = new Date().toISOString();
    const control = source === "control";
    const seq = ++this.seq;
    const line = { seq, source, id, summary, occurred_at, received_at: occurred_at, payload };
    const appended = this.sources.append(line);
    const event: DeliveredEvent = {
      seq, source, id, summary, occurred_at, received_at: occurred_at, appended, delivery: "now",
      ...(control ? { inline: true, payload } : { inline: false }),
    };
    return new Promise((ack) => {
      this.pending = { event, handed: false, ack };
      this.wake?.();
    });
  }

  private seq = 0;

  override async poll(_after: number, _wait: number, signal?: AbortSignal): Promise<DeliveredEvent[]> {
    while (!signal?.aborted) {
      if (this.pending && !this.pending.handed) {
        this.pending.handed = true;
        return [this.pending.event];
      }
      await new Promise<void>((resolve) => {
        const wake = () => {
          signal?.removeEventListener("abort", wake);
          this.wake = undefined;
          resolve();
        };
        this.wake = wake;
        signal?.addEventListener("abort", wake, { once: true });
      });
    }
    return [];
  }

  override async ack(seqs: number[]): Promise<void> {
    if (!this.pending || !seqs.includes(this.pending.event.seq)) return;
    const { ack } = this.pending;
    this.pending = undefined;
    ack();
  }

  override async reportModels() { return { selection: this.selection }; }

  override async activity(activities: Activity[]): Promise<void> {
    this.toolResults.push(...activities.filter((a) => a.kind === "tool_result"));
  }

  override async turnEnd(end: Omit<TurnEndRequest, "agent">): Promise<void> {
    await this.memory.commit({ agent: this.agent, turnId: end.turn_id });
    this.ends.push(end);
  }

  override async rotated(rotation: Omit<SessionRotatedRequest, "agent">): Promise<void> {
    this.rotations.push(rotation);
  }
}
