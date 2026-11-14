// What goes down the UI's stream (docs/ui-api.md): replies, what the turns
// do and the agent's state, numbered so that a stream that reconnects gets
// what it missed.
import type { StreamEvent } from "@penelope/contract";

export type Listener = (id: number, event: StreamEvent) => void;

/** The default number of recent events kept for a stream that reconnects. */
export const DEFAULT_FEED_KEPT = 1000;

export class Feed {
  private readonly kept: Array<{ id: number; event: StreamEvent }> = [];
  private readonly listeners = new Set<Listener>();
  private readonly keep: number;
  private lastId = 0;

  constructor(keep = DEFAULT_FEED_KEPT) {
    this.keep = keep;
  }

  publish(event: StreamEvent): void {
    const id = ++this.lastId;
    this.kept.push({ id, event });
    if (this.kept.length > this.keep) this.kept.shift();
    for (const listener of [...this.listeners]) listener(id, event);
  }

  /**
   * Calls `listener` with every event from now on. Given the id of the last
   * event a stream saw (`Last-Event-ID`), the kept events after it come first.
   * What is no longer kept is lost; the UI reads the history again for it.
   */
  subscribe(lastEventId: string | undefined, listener: Listener): () => void {
    const after = lastEventId === undefined ? Number.NaN : Number(lastEventId);
    if (Number.isSafeInteger(after)) {
      for (const { id, event } of this.kept) if (id > after) listener(id, event);
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
