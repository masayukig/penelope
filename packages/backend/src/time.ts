// Wall-clock time in the backend's time zone: the day a /sources file is
// named after, and the awake hours that hold a batch until the morning.
import { Cron } from "croner";

const MINUTES_IN_A_DAY = 24 * 60;

/** `YYYY-MM-DD` of the instant in the time zone. */
export function dayIn(ms: number, timeZone: string): string {
  // en-CA writes dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

/** Minutes since midnight of the instant in the time zone. */
function minuteOfDay(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(ms);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return value("hour") * 60 + value("minute");
}

const HOURS = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * The hours a batch may be handed over in, `HH:MM-HH:MM` in a time zone.
 * Awake from the start up to the end; the end may be past midnight. The same
 * start and end means always awake.
 */
export class AwakeHours {
  private readonly start: number;
  private readonly end: number;
  private readonly morning: Cron;
  readonly timeZone: string;

  constructor(hours: string, timeZone: string) {
    const match = HOURS.exec(hours);
    if (!match) throw new Error(`awake hours must be HH:MM-HH:MM, not ${JSON.stringify(hours)}`);
    const [, sh, sm, eh, em] = match.map(Number) as [number, number, number, number, number];
    this.start = sh * 60 + sm;
    this.end = eh * 60 + em;
    this.timeZone = timeZone;
    this.morning = new Cron(`${sm} ${sh} * * *`, { timezone: timeZone, paused: true, mode: "5-part" });
  }

  isAwake(ms: number): boolean {
    if (this.start === this.end) return true;
    const minute = minuteOfDay(ms, this.timeZone);
    if (this.start < this.end) return minute >= this.start && minute < this.end;
    return minute >= this.start || minute < this.end;
  }

  /** The next time the awake hours start, after `ms`. */
  nextStart(ms: number): number {
    const next = this.morning.nextRun(new Date(ms));
    // A daily pattern always has a next run; a day ahead is the fallback.
    return next ? next.getTime() : ms + MINUTES_IN_A_DAY * 60_000;
  }
}

export const iso = (ms: number): string => new Date(ms).toISOString();
