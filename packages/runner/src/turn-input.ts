// The text a turn's events become (docs/events.md, "ターンに入る形"). An inline
// event brings its content; any other its summary and where it was appended;
// batched events are counted per source and stream. Facts only (ADR-0008).

import type { Appended, DeliveredEvent } from "@penelope/contract";

function where(event: DeliveredEvent): string {
  return event.stream ? `${event.source}/${event.stream}` : event.source;
}

function content(payload: unknown): string {
  if (typeof payload === "object" && payload !== null && typeof (payload as { text?: unknown }).text === "string") {
    return (payload as { text: string }).text;
  }
  return JSON.stringify(payload);
}

function single(event: DeliveredEvent): string {
  const head = `[seq ${event.seq}] ${where(event)}, ${event.occurred_at}`;
  const attachments = event.attachments?.length ? `\nAttachments: ${event.attachments.map((attachment) => attachment.path).join(", ")}` : "";
  if (event.inline) return `${head}\n${content(event.payload)}${attachments}`;
  return `${head}: ${event.summary}\n${place([event.appended])}${attachments}`;
}

/** The lines of each file, with touching ranges merged: `path lines 4-5, 7-7`. */
function place(appended: Appended[]): string {
  const byPath = new Map<string, [number, number][]>();
  for (const { path, lines } of appended) {
    const ranges = byPath.get(path) ?? [];
    ranges.push([lines[0], lines[1]]);
    byPath.set(path, ranges);
  }
  const out: string[] = [];
  for (const [path, ranges] of byPath) {
    ranges.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const range of ranges) {
      const last = merged.at(-1);
      if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
      else merged.push([...range]);
    }
    out.push(`${path} lines ${merged.map(([from, to]) => `${from}-${to}`).join(", ")}`);
  }
  return out.join("\n");
}

function batched(events: DeliveredEvent[]): string {
  const count = events.length === 1 ? "1 event" : `${events.length} events`;
  const seqs = events.map((event) => event.seq).join(", ");
  return `[batch] ${where(events[0]!)}: ${count} (seq ${seqs})\n${place(events.map((event) => event.appended))}`;
}

/** One input for the events handed over together. */
export function formatEvents(events: DeliveredEvent[]): string {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const parts: string[] = [];
  const groups = new Map<string, DeliveredEvent[]>();
  for (const event of sorted) {
    if (event.delivery === "batch" && !event.inline) {
      const key = where(event);
      groups.set(key, [...(groups.get(key) ?? []), event]);
    } else {
      parts.push(single(event));
    }
  }
  for (const group of groups.values()) parts.push(batched(group));
  return parts.join("\n\n");
}
