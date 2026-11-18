// The Signal plugin (docs/receivers.md, "Signal のプラグイン"): its settings,
// the events it makes of what signal-cli receives, and the whole of it against
// a made-up signal-cli on a Unix socket. Every number is made up.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { SettingsError, type ConnectionEvent } from "../src/plugin.ts";
import { eventOf, signal, signalPlugin } from "../src/plugins/signal.ts";

const OWNER = "+15550000001";
const AGENT = "+15550000002";
const STRANGER = "+15550000003";
const env = { readFile: () => "" };
const SETTINGS = { socket: "/run/signal/cli.sock", account: AGENT, senders: [OWNER] };

function refused(settings: Record<string, unknown>): string {
  try {
    signal.create(settings, env);
  } catch (error) {
    assert.ok(error instanceof SettingsError, String(error));
    return error.message;
  }
  assert.fail("the settings were taken");
}

describe("the Signal plugin's settings", () => {
  test("take a socket, the account and the senders", () => {
    assert.equal(signal.kind, "connection");
    signal.create({ ...SETTINGS, senders: [OWNER, "0b0e5b1c-1111-4222-8333-444455556666"], send_socket: "/run/signal-send/send.sock", max_file_bytes: 1024, rpc_timeout_seconds: 5 }, env);
  });

  test("refuse what they cannot run with, naming the field", () => {
    assert.equal(refused({ ...SETTINGS, extra: 1 }), "extra: not a field of this plugin");
    assert.equal(refused({ ...SETTINGS, socket: "cli.sock" }), "socket: must be the absolute path of a Unix socket");
    assert.equal(refused({ ...SETTINGS, account: "0901234567" }), "account: must be a phone number in E.164 (+81…)");
    assert.equal(refused({ ...SETTINGS, senders: [] }), "senders: must be a list of one or more phone numbers or UUIDs");
    assert.equal(refused({ ...SETTINGS, senders: [OWNER, "alice"] }), "senders[1]: must be a phone number in E.164 or a UUID");
    assert.equal(refused({ ...SETTINGS, max_file_bytes: 0 }), "max_file_bytes: must be an integer from 1 to 62914560");
  });
});

const message = (dataMessage: Record<string, unknown>, from = OWNER) => ({ sourceNumber: from, sourceUuid: null, sourceName: "Owner", timestamp: 1794819600000, dataMessage: { timestamp: 1794819600000, ...dataMessage } });
const allowed = new Set([OWNER]);

describe("the events it makes", () => {
  test("a message from an allowed sender comes now, its text inline", () => {
    const made = eventOf(message({ message: "hello\nthere", quote: { id: 1794819500000, text: "earlier" } }), allowed)!;
    assert.deepEqual(made.event, {
      id: `${OWNER}/1794819600000`,
      occurred_at: "2026-11-16T09:00:00.000Z",
      stream: "dm.15550000001",
      delivery: "now",
      summary: "Signal Owner: hello there",
      payload: { type: "message", from: { number: OWNER, name: "Owner" }, timestamp: 1794819600000, text: "hello\nthere", quote: { timestamp: 1794819500000, text: "earlier" } },
    });
    assert.deepEqual(made.attachments, []);
  });

  test("files are listed, to be fetched", () => {
    const made = eventOf(message({ attachments: [{ id: "a1.png", contentType: "image/png", filename: "photo.png", size: 3 }] }), allowed)!;
    assert.equal(made.event.summary, "Signal Owner: (1 file)");
    assert.deepEqual(made.event.payload.files, [{ name: "photo.png", mimetype: "image/png", size: 3, attached: false }]);
    assert.deepEqual(made.attachments, [{ id: "a1.png", name: "photo.png", type: "image/png", size: 3 }]);
  });

  test("a reaction is batched", () => {
    const made = eventOf(message({ reaction: { emoji: "👍", targetSentTimestamp: 1794819500000, isRemove: false } }), allowed)!;
    assert.equal(made.event.delivery, "batch");
    assert.equal(made.event.summary, "Signal Owner reacted 👍");
    assert.deepEqual(made.event.payload.reaction, { emoji: "👍", target_timestamp: 1794819500000, removed: false });
  });

  test("groups, strangers, receipts and empty messages are dropped", () => {
    assert.equal(eventOf(message({ message: "hi", groupInfo: { groupId: "g" } }), allowed), undefined);
    assert.equal(eventOf(message({ message: "hi" }, STRANGER), allowed), undefined);
    assert.equal(eventOf({ sourceNumber: OWNER, receiptMessage: { isRead: true } }, allowed), undefined);
    assert.equal(eventOf(message({}), allowed), undefined);
  });
});

/** signal-cli's JSON-RPC on a Unix socket, one line a message. */
class FakeSignalCli {
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  readonly server: net.Server;
  clients: net.Socket[] = [];
  sendResult: unknown = { timestamp: 1794819700000, results: [{ type: "SUCCESS" }] };

  readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.server = net.createServer((client) => {
      this.clients.push(client);
      let buffer = "";
      client.on("error", () => {});
      client.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const request = JSON.parse(buffer.slice(0, end)) as { id: number; method: string; params: Record<string, unknown> };
          buffer = buffer.slice(end + 1);
          this.calls.push({ method: request.method, params: request.params });
          const result = request.method === "getAttachment" ? { data: Buffer.from([1, 2, 3]).toString("base64") } : request.method === "send" ? this.sendResult : {};
          client.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
        }
      });
    });
  }

  listen = () => new Promise<void>((resolve) => this.server.listen(this.path, resolve));
  push(envelope: unknown) {
    for (const client of this.clients) client.write(`${JSON.stringify({ jsonrpc: "2.0", method: "receive", params: { envelope, account: AGENT } })}\n`);
  }
  close = () => new Promise<void>((resolve) => {
    for (const client of this.clients) client.destroy();
    this.clients = [];
    this.server.close(() => resolve());
  });
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "in time");
};

function post(path: string, form: FormData) {
  return new Promise<{ status: number; body: Record<string, unknown> }>(async (resolve, reject) => {
    const request = new Request("http://signal/v1/send", { method: "POST", body: form });
    const body = Buffer.from(await request.arrayBuffer());
    const req = http.request({ socketPath: path, path: "/v1/send", method: "POST", headers: { "content-type": request.headers.get("content-type")!, "content-length": body.length } }, (response) => {
      const parts: Buffer[] = [];
      response.on("data", (part: Buffer) => parts.push(part));
      response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(parts).toString("utf8")) as Record<string, unknown> }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("the Signal plugin against signal-cli", () => {
  const dir = mkdtempSync(join(tmpdir(), "receivers-signal-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("hands messages over, fetches files, sends a read receipt, answers through the send socket and connects again", async () => {
    const cli = new FakeSignalCli(join(dir, "cli.sock"));
    await cli.listen();
    const delivered: ConnectionEvent[] = [];
    const lines: string[] = [];
    let take = false;
    const sendSocket = join(dir, "send.sock");
    const connection = signalPlugin({ backoffMs: () => 10 }).create({ ...SETTINGS, socket: cli.path, send_socket: sendSocket }, env);
    const handle = connection.start({
      deliver: async (events) => {
        if (!take) {
          take = true; // the first try is not taken, the next is
          return false;
        }
        delivered.push(...events);
        return true;
      },
      log: (line) => lines.push(line),
      now: () => new Date(),
    });
    try {
      await until(() => cli.clients.length === 1 && lines.includes("connected"));
      cli.push(message({ message: "hi" }, STRANGER));
      cli.push(message({ message: "look", attachments: [{ id: "a1.png", contentType: "image/png", filename: "photo.png", size: 3 }] }));
      await until(() => delivered.length === 1 && cli.calls.some((call) => call.method === "sendReceipt"));
      const [event] = delivered;
      assert.equal(event!.id, `${OWNER}/1794819600000`);
      assert.deepEqual(event!.files, [{ name: "photo.png", type: "image/png", data: Buffer.from([1, 2, 3]) }]);
      assert.equal((event!.payload as { files: { attached: boolean }[] }).files[0]!.attached, true);
      assert.deepEqual(
        cli.calls.map((call) => call.method),
        ["getAttachment", "sendReceipt"],
      );
      assert.deepEqual(cli.calls[1]!.params, { account: AGENT, recipient: OWNER, targetTimestamp: [1794819600000], type: "read" });
      assert.ok(lines.includes("envelope events=0 dropped=1"));

      const form = new FormData();
      form.set("text", "here it is\n");
      form.append("file", new Blob([new Uint8Array([4, 5])], { type: "image/png" }), "drawn;1.png");
      const sent = await post(sendSocket, form);
      assert.deepEqual(sent, { status: 200, body: { timestamp: 1794819700000 } });
      assert.deepEqual(cli.calls.at(-1), {
        method: "send",
        params: { account: AGENT, recipient: [OWNER], message: "here it is", attachments: ["data:image/png;filename=drawn_1.png;base64,BAU="] },
      });

      const stranger = new FormData();
      stranger.set("text", "hi");
      stranger.set("to", STRANGER);
      assert.equal((await post(sendSocket, stranger)).status, 403);
      assert.equal((await post(sendSocket, new FormData())).status, 400);
      cli.sendResult = { timestamp: 1, results: [{ type: "UNREGISTERED_FAILURE" }] };
      const refusedForm = new FormData();
      refusedForm.set("text", "hi");
      assert.deepEqual(await post(sendSocket, refusedForm), { status: 502, body: { error: "Signal did not take it (UNREGISTERED_FAILURE)" } });

      // signal-cli goes away and comes back.
      await cli.close();
      await until(() => lines.some((line) => line.startsWith("connecting again")));
      assert.equal((await post(sendSocket, refusedForm)).status, 503);
      await cli.listen();
      await until(() => cli.clients.length === 1 && lines.filter((line) => line === "connected").length === 2);
    } finally {
      await handle.stop();
      await cli.close();
    }
  });
});
