// Alertmanager's webhook (ADR-0023, docs/receivers.md "Alertmanager のプラグイン"):
// each change of state of an alert is one event.
import { createHash, timingSafeEqual } from "node:crypto";

import type { Delivery } from "@penelope/contract";

import {
  isObject,
  onlyKnown,
  type PluginEvent,
  readKey,
  SettingsError,
  type WebhookOutcome,
  type WebhookPlugin,
  type WebhookRequest,
} from "../plugin.ts";

/** One alert as the webhook sends it, as far as the plugin reads it. */
type Alert = {
  status: "firing" | "resolved";
  fingerprint: string;
  startsAt: string;
  endsAt?: unknown;
  labels: Record<string, string>;
  annotations?: unknown;
};

/** RFC 3339 with a time and an offset, as the intake takes occurred_at. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
const isTime = (value: unknown): value is string => typeof value === "string" && RFC3339.test(value) && !Number.isNaN(Date.parse(value));

/** What Alertmanager sends as endsAt while an alert is firing. */
const ZERO_TIME = "0001-01-01T00:00:00Z";

const STREAM_MAX = 100;
const SUMMARY_MAX = 200;

const digest = (text: string) => createHash("sha256").update(text, "utf8").digest();

export const alertmanager: WebhookPlugin = {
  name: "alertmanager",
  kind: "webhook",
  create(settings, env) {
    onlyKnown(settings, ["token_file", "now_severities", "drop_labels"]);
    const token = digest(readKey("token_file", settings.token_file, env));
    const nowSeverities = stringList("now_severities", settings.now_severities ?? ["critical"]);
    const dropLabels = labelMap("drop_labels", settings.drop_labels ?? { sender: "penelope" });

    return (request: WebhookRequest): WebhookOutcome => {
      if (!authorized(request.headers.authorization, token)) return { kind: "refuse", status: 401 };
      const parsed = parseBody(request.body);
      if (typeof parsed === "string") return { kind: "refuse", status: 400, reason: parsed };

      const events: PluginEvent[] = [];
      let dropped = 0;
      for (const alert of parsed.alerts) {
        if (Object.entries(dropLabels).some(([name, value]) => alert.labels[name] === value)) {
          dropped++;
          continue;
        }
        events.push(eventOf(alert, parsed.externalURL, nowSeverities, request.receivedAt));
      }
      const notes = parsed.truncated > 0 ? [`truncated_alerts=${parsed.truncated}`] : [];
      return { kind: "accept", events, dropped, notes };
    };
  },
};

function stringList(field: string, value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new SettingsError(field, "must be a list of strings");
  }
  return value;
}

function labelMap(field: string, value: unknown): Record<string, string> {
  if (!isObject(value) || !Object.values(value).every((item) => typeof item === "string")) {
    throw new SettingsError(field, "must map label names to string values");
  }
  return value as Record<string, string>;
}

/**
 * `Bearer <token>` with the token of the settings. The digests are compared,
 * so the time it takes depends neither on how much of the token matched nor
 * on its length.
 */
function authorized(header: string | undefined, token: Buffer): boolean {
  const given = header === undefined ? undefined : /^Bearer (.+)$/i.exec(header)?.[1];
  // A digest is compared even without a token, so that every refusal costs the same.
  return timingSafeEqual(digest(given ?? ""), token) && given !== undefined;
}

type Body = { alerts: Alert[]; externalURL: unknown; truncated: number };

/** The alerts of the body, or why the whole request is refused. */
function parseBody(bytes: Uint8Array): Body | string {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return "the body is not JSON";
  }
  if (!isObject(body) || !Array.isArray(body.alerts)) return "the body has no alerts list";
  for (const [index, item] of body.alerts.entries()) {
    const why = alertError(item);
    if (why) return `alerts[${index}]: ${why}`;
  }
  const truncated = typeof body.truncatedAlerts === "number" ? body.truncatedAlerts : 0;
  return { alerts: body.alerts as Alert[], externalURL: body.externalURL, truncated };
}

function alertError(item: unknown): string | undefined {
  if (!isObject(item)) return "not an object";
  if (item.status !== "firing" && item.status !== "resolved") return "status must be firing or resolved";
  if (typeof item.fingerprint !== "string" || item.fingerprint === "") return "fingerprint must be a non-empty string";
  if (!isTime(item.startsAt)) return "startsAt must be an RFC 3339 time";
  if (!isObject(item.labels) || !Object.values(item.labels).every((value) => typeof value === "string")) {
    return "labels must map names to strings";
  }
  return undefined;
}

/** The payload is the alert as it came, with the request's externalURL beside its own fields. */
function eventOf(alert: Alert, externalURL: unknown, nowSeverities: readonly string[], receivedAt: Date): PluginEvent {
  const severity = alert.labels.severity;
  const delivery: Delivery = alert.status === "firing" && severity !== undefined && nowSeverities.includes(severity) ? "now" : "batch";
  const stream = streamOf(alert.labels.alertname);
  return {
    id: `${alert.fingerprint}/${alert.status}/${alert.startsAt}`,
    occurred_at: alert.status === "firing" ? alert.startsAt : endOf(alert.endsAt, receivedAt),
    summary: summaryOf(alert),
    ...(stream === undefined ? {} : { stream }),
    delivery,
    payload: externalURL === undefined ? alert : { ...alert, externalURL },
  };
}

function endOf(endsAt: unknown, receivedAt: Date): string {
  return isTime(endsAt) && endsAt !== ZERO_TIME ? endsAt : receivedAt.toISOString();
}

/**
 * The stream of an alertname (docs/receivers.md, "`stream` の写し方"): upper
 * case to lower, each other character outside the segment's own to `_`, a
 * leading `.` to `_`, cut at 100. Nothing when there is nothing left.
 */
export function streamOf(alertname: string | undefined): string | undefined {
  if (alertname === undefined) return undefined;
  const mapped = [...alertname]
    .map((char) => (/^[A-Z]$/.test(char) ? char.toLowerCase() : /^[a-z0-9._-]$/.test(char) ? char : "_"))
    .join("")
    .replace(/^\./, "_")
    .slice(0, STREAM_MAX);
  return mapped === "" ? undefined : mapped;
}

/** `[FIRING critical] <alertname>: <annotations.summary>` in one line of up to 200 code points. */
export function summaryOf(alert: Pick<Alert, "status" | "labels" | "fingerprint" | "annotations">): string {
  const state = alert.status === "firing" ? "FIRING" : "RESOLVED";
  const severity = alert.labels.severity ? ` ${alert.labels.severity}` : "";
  const name = alert.labels.alertname || alert.fingerprint;
  const said = isObject(alert.annotations) && typeof alert.annotations.summary === "string" ? alert.annotations.summary : "";
  const line = `[${state}${severity}] ${name}${said ? `: ${said}` : ""}`;
  return [...line.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")].slice(0, SUMMARY_MAX).join("");
}
