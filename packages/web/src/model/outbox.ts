// The owner's messages on their way to the backend. Written while the
// stream is down, a message is held and sent once it is back, in the order
// written: the notice of the offline screen says so.
import type { PostMessageResponse } from "@penelope/contract";

import { Unauthorized, Unreachable } from "./api.ts";
import type { Action, LocalFile } from "./store.ts";

type Waiting = { key: string; text: string; files: File[] };

export class Outbox {
  private readonly send: (text: string, files: File[]) => Promise<PostMessageResponse>;
  private readonly dispatch: (action: Action) => void;
  private readonly now: () => number;
  private readonly waiting: Waiting[] = [];
  private up = false;
  private flushing = false;
  private count = 0;

  constructor(options: { send: (text: string, files: File[]) => Promise<PostMessageResponse>; dispatch: (action: Action) => void; now?: () => number }) {
    this.send = options.send;
    this.dispatch = options.dispatch;
    this.now = options.now ?? Date.now;
  }

  submit({ text, files, duringTurn }: { text: string; files: File[]; duringTurn: boolean }): void {
    const key = `local-${++this.count}`;
    this.dispatch({ type: "queued", key, at: new Date(this.now()).toISOString(), text, files: files.map(localFile), duringTurn });
    this.waiting.push({ key, text, files });
    void this.flush();
  }

  online(): void {
    this.up = true;
    void this.flush();
  }

  offline(): void {
    this.up = false;
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.up && this.waiting.length > 0) {
        const next = this.waiting[0]!;
        this.dispatch({ type: "sending", key: next.key });
        try {
          const taken = await this.send(next.text, next.files);
          this.waiting.shift();
          this.dispatch({ type: "sent", key: next.key, ...taken });
        } catch (error) {
          if (error instanceof Unreachable) {
            this.dispatch({ type: "queued-again", key: next.key });
            this.up = false;
            return;
          }
          if (error instanceof Unauthorized) {
            this.dispatch({ type: "queued-again", key: next.key });
            this.dispatch({ type: "unauthorized" });
            this.up = false;
            return;
          }
          this.waiting.shift();
          this.dispatch({ type: "failed", key: next.key });
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}

function localFile(file: File): LocalFile {
  return {
    name: file.name,
    type: file.type,
    size: file.size,
    ...(file.type.startsWith("image/") && typeof URL.createObjectURL === "function" ? { url: URL.createObjectURL(file) } : {}),
  };
}
