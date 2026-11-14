// Pi's events of one turn as the activities the backend records (docs/sandbox-api.md,
// "途中経過"): one per closed block, never token by token.

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Activity } from "@penelope/contract";

/** How much of a tool's output is sent. The rest is counted, not sent. */
export const OUTPUT_LIMIT = 16_000;

type Part = { type: string; text?: string; mimeType?: string };

/** The text of a tool's result. A part that is not text is named by its type; long output is cut. */
export function toolOutput(result: unknown): string {
  let text: string;
  if (typeof result === "string") {
    text = result;
  } else if (typeof result === "object" && result !== null && Array.isArray((result as { content?: unknown }).content)) {
    text = ((result as { content: Part[] }).content)
      .map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.mimeType ?? part.type}]`))
      .join("\n");
  } else {
    text = "";
  }
  if (text.length <= OUTPUT_LIMIT) return text;
  return `${text.slice(0, OUTPUT_LIMIT)}\n[${text.length - OUTPUT_LIMIT} more characters]`;
}

export class TurnRecorder {
  readonly turnId: string;
  private readonly now: () => string;
  private readonly send: (activity: Activity) => void;

  constructor(turnId: string, now: () => string, send: (activity: Activity) => void) {
    this.turnId = turnId;
    this.now = now;
    this.send = send;
  }

  start(): void {
    this.send({ kind: "turn_start", at: this.now(), turn_id: this.turnId });
  }

  end(): void {
    this.send({ kind: "turn_end", at: this.now(), turn_id: this.turnId });
  }

  handle(event: AgentSessionEvent): void {
    const base = { at: this.now(), turn_id: this.turnId };
    if (event.type === "message_update") {
      const block = event.assistantMessageEvent;
      if (block.type === "thinking_end" && block.content.trim()) {
        this.send({ ...base, kind: "thinking", text: block.content });
      } else if (block.type === "text_end" && block.content.trim()) {
        this.send({ ...base, kind: "message", text: block.content });
      } else if (block.type === "toolcall_end") {
        const call = block.toolCall;
        this.send({ ...base, kind: "tool_call", call_id: call.id, name: call.name, arguments: call.arguments });
      }
    } else if (event.type === "tool_execution_end") {
      this.send({ ...base, kind: "tool_result", call_id: event.toolCallId, is_error: event.isError, output: toolOutput(event.result) });
    }
  }
}
