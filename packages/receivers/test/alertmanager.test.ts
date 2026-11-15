import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { WebhookOutcome, WebhookRequest } from "../src/plugin.ts";
import { alertmanager, streamOf, summaryOf } from "../src/plugins/alertmanager.ts";
import { SettingsError } from "../src/plugin.ts";

const TOKEN = "example-token-0001";
const RECEIVED = new Date("2026-11-15T10:05:00.000Z");

function handler(settings: Record<string, unknown> = {}) {
  return alertmanager.create({ token_file: "/run/secrets/token", ...settings }, {
    readFile: (path) => {
      if (path === "/run/secrets/token") return `  ${TOKEN}\n`;
      throw new Error(`ENOENT: ${path}`);
    },
  });
}

function request(body: unknown, authorization: string | null = `Bearer ${TOKEN}`): WebhookRequest {
  return {
    headers: authorization === null ? {} : { authorization },
    body: new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)),
    receivedAt: RECEIVED,
  };
}

function accepted(outcome: WebhookOutcome) {
  assert.equal(outcome.kind, "accept", JSON.stringify(outcome));
  return outcome as Extract<WebhookOutcome, { kind: "accept" }>;
}

const crashLooping = {
  status: "firing",
  labels: { alertname: "KubePodCrashLooping", severity: "critical", namespace: "default", pod: "web-0" },
  annotations: { summary: "Pod default/web-0 is crash looping." },
  startsAt: "2026-11-15T10:00:00.000Z",
  endsAt: "0001-01-01T00:00:00Z",
  generatorURL: "https://prometheus.example.com/graph?g0.expr=up",
  fingerprint: "a1b2c3d4e5f60718",
};

const webhook = (alerts: unknown[], extra: Record<string, unknown> = {}) => ({
  version: "4",
  groupKey: "{}:{alertname=\"KubePodCrashLooping\"}",
  status: "firing",
  receiver: "penelope",
  groupLabels: { alertname: "KubePodCrashLooping" },
  commonLabels: {},
  commonAnnotations: {},
  externalURL: "https://alertmanager.example.com",
  truncatedAlerts: 0,
  alerts,
  ...extra,
});

describe("the Alertmanager plugin's settings", () => {
  test("is a webhook plugin named alertmanager", () => {
    assert.equal(alertmanager.name, "alertmanager");
    assert.equal(alertmanager.kind, "webhook");
  });

  test("needs token_file", () => {
    assert.throws(() => alertmanager.create({}, { readFile: () => TOKEN }), (error: unknown) => {
      assert.ok(error instanceof SettingsError);
      assert.match(error.message, /^token_file: /);
      return true;
    });
  });

  test("refuses a token file that cannot be read or is empty", () => {
    assert.throws(() => alertmanager.create({ token_file: "/nowhere" }, { readFile: () => { throw new Error("ENOENT"); } }), { message: /^token_file: / });
    assert.throws(() => alertmanager.create({ token_file: "/empty" }, { readFile: () => " \n" }), { message: /^token_file: / });
  });

  test("refuses fields it does not know", () => {
    assert.throws(() => handler({ token: TOKEN }), (error: unknown) => error instanceof SettingsError && /^token: /.test(error.message));
  });

  test("refuses now_severities and drop_labels of the wrong shape", () => {
    assert.throws(() => handler({ now_severities: "critical" }), { message: /^now_severities: / });
    assert.throws(() => handler({ now_severities: [1] }), { message: /^now_severities: / });
    assert.throws(() => handler({ drop_labels: ["sender"] }), { message: /^drop_labels: / });
    assert.throws(() => handler({ drop_labels: { sender: 1 } }), { message: /^drop_labels: / });
  });
});

describe("the Alertmanager plugin's check of the sender", () => {
  test("refuses with 401 a missing header, another scheme and a wrong token, the same way", () => {
    const body = webhook([crashLooping]);
    for (const authorization of [null, `Basic ${TOKEN}`, "Bearer wrong", `Bearer ${TOKEN}x`, "Bearer ", TOKEN]) {
      assert.deepEqual(handler()(request(body, authorization)), { kind: "refuse", status: 401 }, String(authorization));
    }
  });

  test("checks the token before reading the body", () => {
    assert.deepEqual(handler()(request("not json", "Bearer wrong")), { kind: "refuse", status: 401 });
  });

  test("takes the scheme in any case", () => {
    accepted(handler()(request(webhook([crashLooping]), `bearer ${TOKEN}`)));
  });
});

describe("the Alertmanager plugin's check of the body", () => {
  const refused = (body: unknown) => {
    const outcome = handler()(request(body));
    assert.equal(outcome.kind, "refuse", JSON.stringify(body));
    assert.equal((outcome as { status: number }).status, 400);
  };

  test("refuses with 400 a body that is not JSON or has no alerts array", () => {
    refused("{");
    refused([]);
    refused({ version: "4" });
    refused({ alerts: {} });
  });

  test("refuses the whole request if any alert is not of the shape", () => {
    const { status: _s, ...noStatus } = crashLooping;
    const { fingerprint: _f, ...noFingerprint } = crashLooping;
    const { startsAt: _t, ...noStartsAt } = crashLooping;
    const { labels: _l, ...noLabels } = crashLooping;
    for (const bad of [
      "an alert",
      noStatus,
      { ...crashLooping, status: "pending" },
      noFingerprint,
      { ...crashLooping, fingerprint: "" },
      noStartsAt,
      { ...crashLooping, startsAt: 1 },
      { ...crashLooping, startsAt: "yesterday" },
      noLabels,
      { ...crashLooping, labels: { alertname: 1 } },
    ]) {
      refused(webhook([crashLooping, bad]));
    }
  });

  test("does not check the other fields", () => {
    const outcome = accepted(handler()(request({ alerts: [crashLooping], version: 5, groupLabels: null })));
    assert.equal(outcome.events.length, 1);
  });

  test("takes an empty list of alerts as nothing to send", () => {
    assert.deepEqual(handler()(request(webhook([]))), { kind: "accept", events: [], dropped: 0, notes: [] });
  });

  test("notes the alerts that Alertmanager left out with max_alerts", () => {
    assert.deepEqual(accepted(handler()(request(webhook([crashLooping], { truncatedAlerts: 3 })))).notes, ["truncated_alerts=3"]);
    assert.deepEqual(accepted(handler()(request(webhook([crashLooping], { truncatedAlerts: 0 })))).notes, []);
  });
});

describe("the Alertmanager plugin's events", () => {
  test("makes the example of docs/receivers.md into one event", () => {
    assert.deepEqual(accepted(handler()(request(webhook([crashLooping])))), {
      kind: "accept",
      events: [
        {
          id: "a1b2c3d4e5f60718/firing/2026-11-15T10:00:00.000Z",
          occurred_at: "2026-11-15T10:00:00.000Z",
          summary: "[FIRING critical] KubePodCrashLooping: Pod default/web-0 is crash looping.",
          stream: "kubepodcrashlooping",
          delivery: "now",
          payload: { ...crashLooping, externalURL: "https://alertmanager.example.com" },
        },
      ],
      dropped: 0,
      notes: [],
    });
  });

  test("makes one event of each alert, in order", () => {
    const other = { ...crashLooping, fingerprint: "ffff", labels: { alertname: "Other", severity: "warning" } };
    const events = accepted(handler()(request(webhook([crashLooping, other])))).events;
    assert.deepEqual(events.map((event) => event.id), ["a1b2c3d4e5f60718/firing/2026-11-15T10:00:00.000Z", "ffff/firing/2026-11-15T10:00:00.000Z"]);
  });

  test("gives a resend of the same alert in the same state the same id, and a new firing a new one", () => {
    const id = (alert: unknown) => accepted(handler()(request(webhook([alert])))).events[0]!.id;
    assert.equal(id(crashLooping), id({ ...crashLooping, annotations: { summary: "changed" } }));
    assert.notEqual(id(crashLooping), id({ ...crashLooping, startsAt: "2026-11-15T11:00:00.000Z" }));
    assert.notEqual(id(crashLooping), id({ ...crashLooping, status: "resolved" }));
  });

  test("dates a resolved alert by endsAt, or by when it was received if endsAt is not a time", () => {
    const resolved = { ...crashLooping, status: "resolved", endsAt: "2026-11-15T10:04:00.000Z" };
    const at = (alert: unknown) => accepted(handler()(request(webhook([alert])))).events[0]!.occurred_at;
    assert.equal(at(resolved), "2026-11-15T10:04:00.000Z");
    assert.equal(at({ ...resolved, endsAt: "0001-01-01T00:00:00Z" }), RECEIVED.toISOString());
    assert.equal(at({ ...resolved, endsAt: "soon" }), RECEIVED.toISOString());
    const { endsAt: _e, ...noEndsAt } = resolved;
    assert.equal(at(noEndsAt), RECEIVED.toISOString());
  });

  test("makes only a firing alert of a severity in now_severities now, and always says which", () => {
    const delivery = (alert: unknown, settings: Record<string, unknown> = {}) =>
      accepted(handler(settings)(request(webhook([alert])))).events[0]!.delivery;
    assert.equal(delivery(crashLooping), "now");
    assert.equal(delivery({ ...crashLooping, status: "resolved" }), "batch");
    assert.equal(delivery({ ...crashLooping, labels: { alertname: "X", severity: "warning" } }), "batch");
    assert.equal(delivery({ ...crashLooping, labels: { alertname: "X" } }), "batch");
    assert.equal(delivery({ ...crashLooping, labels: { alertname: "X", severity: "warning" } }, { now_severities: ["warning"] }), "now");
    assert.equal(delivery(crashLooping, { now_severities: [] }), "batch");
  });

  test("leaves out the stream of an alert without an alertname, or one that maps to nothing", () => {
    const events = accepted(handler()(request(webhook([{ ...crashLooping, labels: { severity: "critical" } }, { ...crashLooping, labels: { alertname: "" } }])))).events;
    assert.equal("stream" in events[0]!, false);
    assert.equal("stream" in events[1]!, false);
  });

  test("leaves externalURL out of the payload when the request has none", () => {
    const { externalURL: _x, ...noURL } = webhook([crashLooping]);
    assert.deepEqual(accepted(handler()(request(noURL))).events[0]!.payload, crashLooping);
  });

  test("drops the alerts with a label of drop_labels and counts them", () => {
    const own = { ...crashLooping, fingerprint: "0000", labels: { ...crashLooping.labels, sender: "penelope" } };
    const outcome = accepted(handler()(request(webhook([own, crashLooping]))));
    assert.deepEqual(outcome.events.map((event) => event.id.split("/")[0]), ["a1b2c3d4e5f60718"]);
    assert.equal(outcome.dropped, 1);
  });

  test("drops an alert that matches any one of drop_labels, and none when it is empty", () => {
    const labelled = { ...crashLooping, labels: { ...crashLooping.labels, team: "self" } };
    const many = { drop_labels: { sender: "penelope", team: "self" } };
    assert.equal(accepted(handler(many)(request(webhook([labelled])))).dropped, 1);
    const own = { ...crashLooping, labels: { ...crashLooping.labels, sender: "penelope" } };
    assert.equal(accepted(handler({ drop_labels: {} })(request(webhook([own])))).dropped, 0);
    assert.equal(accepted(handler({ drop_labels: { sender: "someone" } })(request(webhook([own])))).dropped, 0);
  });
});

describe("the stream of an alertname", () => {
  test("maps it as docs/receivers.md shows", () => {
    assert.equal(streamOf("KubePodCrashLooping"), "kubepodcrashlooping");
    assert.equal(streamOf("Disk usage: /var"), "disk_usage___var");
  });

  test("replaces each character outside the segment's own, and a leading dot", () => {
    assert.equal(streamOf("ディスク"), "____");
    assert.equal(streamOf(".hidden.Name"), "_hidden.name");
    assert.equal(streamOf("a.b_c-d9"), "a.b_c-d9");
    assert.equal(streamOf("😀x"), "_x");
  });

  test("cuts it at 100 characters, and gives nothing for nothing", () => {
    assert.equal(streamOf("A".repeat(150)), "a".repeat(100));
    assert.equal(streamOf(""), undefined);
    assert.equal(streamOf(undefined), undefined);
  });
});

describe("the summary of an alert", () => {
  const alert = (status: "firing" | "resolved", labels: Record<string, string>, annotations?: Record<string, unknown>) =>
    ({ status, labels, fingerprint: "f00d", ...(annotations ? { annotations } : {}) });

  test("is the state, the severity, the alertname and the annotation's summary", () => {
    assert.equal(summaryOf(alert("firing", { alertname: "A", severity: "critical" }, { summary: "s" })), "[FIRING critical] A: s");
    assert.equal(summaryOf(alert("resolved", { alertname: "A", severity: "warning" }, { summary: "s" })), "[RESOLVED warning] A: s");
  });

  test("leaves out what the alert does not have", () => {
    assert.equal(summaryOf(alert("firing", { alertname: "A" }, { summary: "s" })), "[FIRING] A: s");
    assert.equal(summaryOf(alert("firing", { severity: "info" }, { summary: "s" })), "[FIRING info] f00d: s");
    assert.equal(summaryOf(alert("firing", { alertname: "A", severity: "info" }, { summary: "" })), "[FIRING info] A");
    assert.equal(summaryOf(alert("firing", { alertname: "A", severity: "info" })), "[FIRING info] A");
    assert.equal(summaryOf(alert("firing", { alertname: "A", severity: "info" }, { summary: 3 })), "[FIRING info] A");
  });

  test("puts one space for newlines and control characters, and is cut at 200 code points", () => {
    assert.equal(summaryOf(alert("firing", { alertname: "A" }, { summary: "one\r\ntwo\tthree\u0007" })), "[FIRING] A: one two three ");
    const long = summaryOf(alert("firing", { alertname: "A" }, { summary: "😀".repeat(300) }));
    assert.equal([...long].length, 200);
    assert.ok(long.startsWith("[FIRING] A: 😀"));
  });
});
