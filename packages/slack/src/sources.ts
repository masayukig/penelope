// Reading the Slack plugin's lines of /sources (docs/events.md, "/sources"):
// /sources/<source>/<stream>/<YYYY-MM-DD>.jsonl, one line an event. The
// backend only appends, and the sandbox reads; a line that cannot be read is
// passed over.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { SourcesLine } from "@penelope/contract";

export const DEFAULT_SOURCES = "/sources";

/** A path segment under /sources, as the intake takes `source` and `stream`. */
export const SEGMENT = /^[a-z0-9_-][a-z0-9._-]*$/;

const DAY = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The streams under a source, in order. The attachments' `files` directory is not one. */
export function streamsOf(root: string, source: string): string[] {
  try {
    return readdirSync(join(root, source), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "files" && SEGMENT.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** The days a stream has a file of, oldest first (`YYYY-MM-DD`). Nothing when there is no such stream. */
export function daysOf(root: string, source: string, stream: string): string[] {
  try {
    return readdirSync(join(root, source, stream))
      .flatMap((name) => DAY.exec(name)?.[1] ?? [])
      .sort();
  } catch {
    return [];
  }
}

/** The lines of a stream's days, in the order they were written. */
export function readDays(root: string, source: string, stream: string, days: readonly string[]): SourcesLine[] {
  return days.flatMap((day) => readFile(join(root, source, stream, `${day}.jsonl`)));
}

function readFile(file: string): SourcesLine[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((row) => {
    if (row.trim() === "") return [];
    try {
      const value = JSON.parse(row) as SourcesLine;
      return typeof value === "object" && value !== null && typeof value.seq === "number" ? [value] : [];
    } catch {
      return [];
    }
  });
}

/** The day of a time in UTC, `YYYY-MM-DD`. */
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * The lines the changes are drawn with (ADR-0029): every line of their
 * streams from the day files of `days` days before the first of them was
 * received (by the day in UTC), to the newest.
 */
export function readContext(root: string, changes: readonly SourcesLine[], { days = 1 }: { days?: number } = {}): SourcesLine[] {
  const firsts = new Map<string, { source: string; stream: string; at: number }>();
  for (const change of changes) {
    if (change.stream === undefined || !SEGMENT.test(change.source) || !SEGMENT.test(change.stream)) continue;
    const key = `${change.source}/${change.stream}`;
    const at = Date.parse(change.received_at);
    if (Number.isNaN(at)) continue;
    const known = firsts.get(key);
    if (known === undefined || at < known.at) firsts.set(key, { source: change.source, stream: change.stream, at });
  }
  return [...firsts.values()].flatMap(({ source, stream, at }) => {
    const from = dayOf(at - days * DAY_MS);
    return readDays(root, source, stream, daysOf(root, source, stream).filter((day) => day >= from));
  });
}
