// The input a turn's events become (docs/events.md, "ターンに入る形"): one JSON
// object a line inside <events>, each line a TurnLine of the contract. An
// inline event brings its content; any other its summary and where it was
// appended; batched events are one line per source and stream. Facts only
// (ADR-0008).

import type { Appended, DeliveredEvent, TurnBatch, TurnEvent, TurnLine } from "@penelope/contract";

const where = (event: DeliveredEvent) => (event.stream ? `${event.source}/${event.stream}` : event.source);

function text(payload: unknown): string {
  if (typeof payload === "object" && payload !== null && typeof (payload as { text?: unknown }).text === "string") {
    return (payload as { text: string }).text;
  }
  return JSON.stringify(payload);
}

function single(event: DeliveredEvent): TurnEvent {
  const head = {
    seq: event.seq,
    source: event.source,
    ...(event.stream ? { stream: event.stream } : {}),
    delivery: event.delivery,
    occurred_at: event.occurred_at,
    summary: event.summary,
  };
  const attachments = event.attachments?.length ? { attachments: event.attachments } : {};
  return event.inline ? { ...head, text: text(event.payload), ...attachments } : { ...head, appended: event.appended, ...attachments };
}

/** The ranges of each file, in the order the files first come, with touching ranges merged. */
function places(appended: Appended[]): Appended[] {
  const byPath = new Map<string, [number, number][]>();
  for (const { path, lines } of appended) byPath.set(path, [...(byPath.get(path) ?? []), [lines[0], lines[1]]]);
  const out: Appended[] = [];
  for (const [path, ranges] of byPath) {
    ranges.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const range of ranges) {
      const last = merged.at(-1);
      if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
      else merged.push([...range]);
    }
    out.push(...merged.map((lines) => ({ path, lines })));
  }
  return out;
}

function batched(events: DeliveredEvent[]): TurnBatch {
  const first = events[0]!;
  return {
    kind: "batch",
    source: first.source,
    ...(first.stream ? { stream: first.stream } : {}),
    count: events.length,
    seqs: events.map((event) => event.seq),
    summary: events.map((event) => event.summary).join("\n"),
    appended: places(events.map((event) => event.appended)),
  };
}

/** The lines for the events handed over together: in seq order, the batches last. */
export function turnLines(events: DeliveredEvent[]): TurnLine[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const lines: TurnLine[] = [];
  const groups = new Map<string, DeliveredEvent[]>();
  for (const event of sorted) {
    if (event.delivery === "batch" && !event.inline) groups.set(where(event), [...(groups.get(where(event)) ?? []), event]);
    else lines.push(single(event));
  }
  for (const group of groups.values()) lines.push(batched(group));
  return lines;
}

/** One input for the events handed over together. */
export function formatEvents(events: DeliveredEvent[]): string {
  return `<events>\n${turnLines(events)
    .map((line) => JSON.stringify(line))
    .join("\n")}\n</events>`;
}
