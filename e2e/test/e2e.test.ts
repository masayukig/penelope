// The Pod end to end (e2e/README.md): the owner signs in and talks, the
// sandbox's runner makes turns with the fake model, the memory is committed,
// the sandbox's traffic goes through the Sentinel, a receiver's events reach
// a turn, the night switches the session, and ended turns are folded.
//
// The scenarios share one Pod and go in order; each starts from where the one
// before left it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  Browser,
  compose,
  composeEnv,
  E2E_DIR,
  eventually,
  exec,
  type ModelCall,
  outside,
  pod,
  RUN_DIR,
  sentinelRecords,
  sleep,
  Stream,
  type StreamEvent,
  where,
} from "./support.ts";

const TAG = process.env.PENELOPE_E2E_TAG;
const KEEP = process.env.PENELOPE_E2E_KEEP === "1";
const MODEL_SURROGATE = "e2e-surrogate-model-0001";
const BACKEND_SURROGATE = "e2e-surrogate-backend-0001";

const browser = new Browser();
let stream = new Stream();
let failed = false;

/** The model calls whose last input carries `marker`, at the given step of the turn. */
async function callsFor(marker: string, steps?: number): Promise<ModelCall[]> {
  return (await outside.modelCalls()).filter((call) => {
    const at = where(call);
    return at.input.includes(marker) && (steps === undefined || at.steps === steps);
  });
}

function streamed(event: string, test: (data: Record<string, unknown>) => boolean): StreamEvent | undefined {
  return stream.events.find((entry) => entry.event === event && test(entry.data as Record<string, unknown>));
}

/** A scenario that, when it fails, has the logs of every container written out at the end. */
function track(scenario: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await scenario();
    } catch (error) {
      failed = true;
      throw error;
    }
  };
}

async function send(text: string): Promise<void> {
  const { status } = await browser.json("/api/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  assert.equal(status, 202);
}

const replied = (text: string, timeoutMs = 120_000) =>
  eventually(`the reply ${text} on the stream`, () => streamed("reply", (data) => data.text === text), timeoutMs);

/** The log of /memory, as the backend's git sees it: subject, body and the files of each commit. */
function memoryLog(): string {
  return exec("backend", "cd /memory && git -c safe.directory=/memory log --format='--%n%s%n%b' --name-only 2>&1 || true").stdout;
}

function intake(envelope: Record<string, unknown>): string {
  return exec("receivers", "node /e2e/sender/send.ts", { input: JSON.stringify(envelope) }).stdout.trim();
}

/** The address Docker gave a container of the test, on its default bridge. */
function address(service: string): string {
  const id = compose(["ps", "--quiet", service]).stdout.trim();
  const run = spawnSync("docker", ["inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", id], { encoding: "utf8" });
  const ip = run.stdout.trim();
  assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/, `the address of ${service}`);
  return ip;
}

before(async () => {
  assert.ok(TAG, "PENELOPE_E2E_TAG names the images to test (make e2e sets it)");
  composeEnv.PENELOPE_E2E_TAG = TAG;
  rmSync(RUN_DIR, { recursive: true, force: true });
  const certs = spawnSync(join(E2E_DIR, "certs.sh"), [RUN_DIR], { encoding: "utf8" });
  assert.equal(certs.status, 0, certs.stderr);
  compose(["down", "--volumes", "--remove-orphans"], { check: false });
  // The outside first: the Pod asks its name server. Then the Pod's namespace,
  // whose address is the backend's public URL. Then the rest.
  compose(["up", "--detach", "--build", "outside"]);
  writeFileSync(join(RUN_DIR, "resolv.conf"), `nameserver ${address("outside")}\noptions ndots:1\n`);
  compose(["up", "--detach", "pod"]);
  pod.url = `http://${address("pod")}:8080`;
  composeEnv.PENELOPE_E2E_PUBLIC_URL = pod.url;
  compose(["up", "--detach"]);
  await eventually("the backend's health", async () => ((await browser.request("/healthz")).status === 200 ? true : undefined));
});

after(() => {
  stream.close();
  if (failed || KEEP) {
    process.stderr.write(compose(["logs", "--no-color", "--timestamps"], { check: false }).stdout);
  }
  if (!KEEP) compose(["down", "--volumes", "--remove-orphans"], { check: false });
});

describe("the Pod end to end", () => {
  it("lets the owner in through GitHub's OAuth", track(async () => {
    // Guards against: the owner not getting in, or someone other than the owner's GitHub account getting a session.
    const start = await browser.request("/auth/github/start");
    assert.equal(start.status, 302);
    const location = new URL(start.headers.location!);
    assert.equal(location.origin + location.pathname, "https://github.com/login/oauth/authorize");

    // The owner's browser at GitHub, which sends it back with a code.
    const { code, state, redirect_uri } = await outside.authorize(location.search);
    assert.equal(redirect_uri, `${pod.url}/auth/github/callback`);
    const callback = await browser.request(`/auth/github/callback?${new URLSearchParams({ code, state })}`);
    assert.equal(callback.status, 302, callback.text);
    assert.equal(callback.headers.location, "/");
    assert.ok(browser.cookie?.startsWith("penelope_session="));

    const history = await browser.json<{ entries: unknown[] }>("/api/history");
    assert.equal(history.status, 200);
    assert.deepEqual(history.body.entries, []);
    await stream.open(browser.cookie!);
  }));

  it("serves the Web UI from the backend, named from the settings", track(async () => {
    // Guards against: the backend's image without the built UI or the avatars, or the UI not learning the agent's name from the settings.
    const page = await browser.request("/");
    assert.equal(page.status, 200);
    assert.match(page.headers["content-type"] ?? "", /^text\/html/);
    const script = /src="(\/assets\/[^"]+\.js)"/.exec(page.text)?.[1];
    const styles = /href="(\/assets\/[^"]+\.css)"/.exec(page.text)?.[1];
    assert.ok(script && styles, "the page loads its script and its styles");
    for (const asset of [script, styles]) assert.equal((await browser.request(asset)).status, 200, asset);
    // The login screen and the home screen read these before anyone signs in.
    const agent = new Browser().json<{ name: string; icons?: Record<string, string> }>("/api/agent");
    assert.equal(agent.status, 200);
    assert.equal(agent.body.name, "E2E Agent");
    // The avatar the settings chose is in the image, a face for each expression.
    const happy = new Browser().request(agent.body.icons?.happy ?? "/api/agent/icons/happy");
    assert.equal(happy.status, 200);
    assert.equal(happy.headers["content-type"], "image/webp");
    const manifest = JSON.parse((await new Browser().request("/manifest.webmanifest")).text) as { name: string };
    assert.equal(manifest.name, "E2E Agent");
  }));

  it("makes a turn of the owner's message and streams the reply and what happened", track(async () => {
    // Guards against: a message not reaching a turn, the reply or the activity not reaching the UI, or the model getting the surrogate.
    await send("E2E-TURN-1 こんにちは");
    const reply = await replied("E2E-REPLY-1", 180_000);
    assert.equal((reply.data as { agent: string }).agent, "main");

    const states = () => stream.events.filter((event) => event.event === "state").map((event) => (event.data as { state: string }).state);
    await eventually("the agent waiting again", () => (states().at(-1) === "waiting" ? true : undefined));
    assert.ok(states().includes("thinking"));
    const activity = stream.events
      .filter((event) => event.event === "activity")
      .map((event) => (event.data as { activity: { kind: string; name?: string } }).activity);
    for (const kind of ["turn_start", "tool_call", "tool_result", "message", "turn_end"]) {
      assert.ok(activity.some((entry) => entry.kind === kind), `an activity of kind ${kind} on the stream`);
    }
    assert.deepEqual(
      activity.filter((entry) => entry.kind === "tool_call").map((entry) => entry.name),
      ["write", "bash", "reply"],
    );

    const history = await browser.json<{ entries: { kind: string; text: string }[] }>("/api/history");
    assert.deepEqual(
      history.body.entries.map((entry) => [entry.kind, entry.text]),
      [
        ["agent", "E2E-REPLY-1"],
        ["owner", "E2E-TURN-1 こんにちは"],
      ],
    );

    // The model's key: the sandbox sent its surrogate, the model got the real one.
    const calls = await outside.modelCalls();
    assert.ok(calls.length >= 4);
    assert.deepEqual(new Set(calls.map((call) => call.credential)), new Set(["real"]));
  }));

  it("commits /memory at the end of the turn, and the sandbox cannot write its .git", track(async () => {
    // Guards against: a turn's memory left uncommitted, the sandbox rewriting the history, or the history unreadable to her.
    const log = await eventually("the turn's commit", () => {
      const text = memoryLog();
      return text.includes("notes/e2e.md") ? text : undefined;
    });
    assert.match(log, /^Turn [0-9a-f-]{36}\nAgent: main\n/m);
    assert.equal(exec("backend", "cat /memory/notes/e2e.md").stdout, "# E2E\n\nWritten in the first turn.\n");

    const write = exec("sandbox", "touch /memory/.git/e2e 2>&1", { check: false });
    assert.notEqual(write.status, 0);
    assert.match(write.stdout, /Read-only file system/);
    // It can still read the history.
    assert.match(exec("sandbox", "cd /memory && git log --format=%s -1").stdout, /^Turn /);
  }));

  it("folds the first turn in the second turn's input to the model", track(async () => {
    // Guards against: ended turns sent whole again, with their thinking and tool output, or her replies folded away.
    // The first turn, whole, while it ran: the tool's output was there.
    const during = await callsFor("E2E-TURN-1", 2);
    assert.ok(JSON.stringify(during[0]!.messages).includes("E2E-BASH-42"));

    await send("E2E-TURN-2");
    await replied("E2E-REPLY-2");
    const [first] = await callsFor("E2E-TURN-2", 0);
    assert.ok(first, "the model was called for the second turn");
    const sent = JSON.stringify(first.messages);
    // The event and the reply stay, her text stays, the other calls are one line each, and no tool output is left.
    assert.ok(sent.includes("E2E-TURN-1 こんにちは"));
    assert.ok(sent.includes("E2E-TEXT-1"));
    assert.ok(sent.includes("(folded) write: /memory/notes/e2e.md"), sent);
    assert.ok(sent.includes("(folded) bash: echo E2E-BASH-$((40 + 2))"), sent);
    assert.ok(!sent.includes("E2E-BASH-42"), "the output of bash is folded away");
    assert.ok(!sent.includes("Successfully wrote"), "the output of write is folded away");
    const kept = first.messages.filter((message) => message.tool_calls?.some((call) => call.function.name === "reply"));
    assert.equal(kept.length, 1, "the reply is kept whole");
  }));

  it("sends the sandbox's traffic through the Sentinel, and records it", track(async () => {
    // Guards against: a surrogate leaking out, traffic leaving unrecorded, or the sandbox's loopback being redirected.
    // A host the Sentinel does not open: passed through, the outside's own certificate.
    const passed = exec("sandbox", "curl -sS --insecure https://plain.example.net/");
    assert.equal(passed.stdout, "plain over https\n");
    // Plain HTTP with a surrogate to a host that is not registered: refused before it leaves.
    const leak = exec(
      "sandbox",
      `curl -sS -o /dev/null -w '%{http_code} %header{penelope-sentinel}' -H 'Authorization: Bearer ${MODEL_SURROGATE}' http://plain.example.net/leak`,
    );
    assert.equal(leak.stdout, "403 deny");
    // Link-local, and the Sentinel's own port reached directly: refused.
    exec("sandbox", "curl -sS -m 5 http://169.254.169.254/latest/meta-data/", { check: false });
    exec("sandbox", "curl -sS -m 5 http://127.0.0.1:15001/", { check: false });
    // The sandbox's loopback is its own: neither redirected nor recorded.
    const loopback = exec(
      "sandbox",
      "python3 -m http.server 18999 --bind 127.0.0.1 --directory /tmp >/dev/null 2>&1 & pid=$!; " +
        "for i in $(seq 50); do curl -s -o /dev/null http://127.0.0.1:18999/ && break; sleep 0.1; done; " +
        "curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:18999/; kill $pid",
    );
    assert.equal(loopback.stdout, "200");

    const records = await eventually("the Sentinel's records", () => {
      const all = sentinelRecords();
      return all.some((record) => record.reason === "direct") && all.some((record) => record.host === "plain.example.net" && record.kind === "tcp")
        ? all
        : undefined;
    });
    const has = (what: Record<string, unknown>) =>
      records.some((record) => Object.entries(what).every(([key, value]) => record[key] === value));
    assert.ok(has({ kind: "tcp", action: "passthrough", host: "plain.example.net", port: 443, uid: 1000 }), "the passthrough");
    assert.ok(has({ kind: "http", action: "open", host: "model.example.com", method: "POST", path: "/v1/chat/completions", uid: 1000 }), "the model");
    assert.ok(has({ kind: "http", action: "open", host: "backend.example.com", method: "POST", path: "/v1/replies", uid: 1000 }), "the backend");
    assert.ok(has({ kind: "dns", host: "plain.example.net", qtype: "A" }), "the name lookup");
    assert.ok(has({ action: "deny", reason: "surrogate-out-of-place", host: "plain.example.net" }), "the surrogate");
    assert.ok(has({ action: "deny", reason: "link-local", addr: "169.254.169.254" }), "link-local");
    assert.ok(has({ action: "deny", reason: "direct" }), "direct");
    assert.ok(!records.some((record) => record.port === 18999), "the loopback is not recorded");
    assert.ok(!JSON.stringify(records).includes(MODEL_SURROGATE), "no surrogate in the record");
    assert.ok(!(await outside.seen()).some((entry) => entry.path === "/leak"), "the surrogate never reached the outside");
  }));

  it("has no real key in the sandbox, and only its surrogates", track(async () => {
    // Guards against: a real key, or the intake, becoming reachable from the sandbox.
    const keys = ["model-key", "backend-token", "github-client-secret", "sentinel-ca.key", "outside-ca.key", "outside.key"]
      .map((name) => readFileSync(join(RUN_DIR, name), "utf8").trim().split("\n").filter((line) => line && !line.startsWith("-----")))
      .flat();
    const found = exec(
      "sandbox",
      "grep -rlF -f /dev/stdin /home/agent /memory /sources /etc /tmp /opt/penelope /proc/1/environ 2>/dev/null; true",
      { input: `${keys.join("\n")}\n` },
    );
    assert.equal(found.stdout, "");
    assert.match(exec("sandbox", "cat /proc/1/environ | tr '\\0' '\\n'").stdout, new RegExp(`PENELOPE_BACKEND_TOKEN=${BACKEND_SURROGATE}`));
    // The intake's and the Sentinel's sockets are not in the sandbox.
    assert.equal(exec("sandbox", "ls /run/penelope 2>&1; true").stdout.includes("intake"), false);
    // The backend's port for the UI is reached over loopback, and asks for the same login.
    assert.equal(exec("sandbox", "curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/history").stdout, "401");
  }));

  it("takes a receiver's events into /sources, and brings the batch along with a now", track(async () => {
    // Guards against: a batch overtaken by a now and left behind, or an event pointing at the wrong place in /sources.
    const occurred = new Date().toISOString();
    const batch = { source: "e2e", stream: "feed", id: "batch-1", occurred_at: occurred, summary: "E2E-BATCH one", delivery: "batch", payload: { n: 1 } };
    assert.equal(intake(batch), "202");
    assert.equal(intake(batch), "202", "a duplicate is taken as received");
    assert.match(intake({ ...batch, source: "control", id: "night", payload: { kind: "nightly" } }), /^400 /);

    const day = occurred.slice(0, 10);
    const lines = exec("sandbox", `cat /sources/e2e/feed/${day}.jsonl`).stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]!).payload, { n: 1 });

    // The batch waits for its quiet minutes; nothing of it reaches the model yet.
    await sleep(3000);
    assert.equal((await callsFor("/sources/e2e/feed/")).length, 0);

    const now = { source: "e2e", stream: "feed", id: "now-1", occurred_at: new Date().toISOString(), summary: "E2E-NOW ping", delivery: "now", payload: { n: 2 } };
    assert.equal(intake(now), "202");
    await replied("E2E-REPLY-EVENTS");
    // Both reach one turn, each pointing at where it was appended (docs/events.md, "ターンに入る形"):
    // the now with its summary, the batch counted. Only what the contract fixes is read here, not
    // how the runner writes it.
    const calls = await callsFor("E2E-NOW", 0);
    assert.equal(calls.length, 1, "one turn for the now and the batch");
    const input = where(calls[0]!).input;
    const file = `/sources/e2e/feed/${day}.jsonl`;
    assert.ok(input.includes("E2E-NOW ping"), "the now's summary");
    assert.ok(input.includes(file), "the file both were appended to");
    // The batch is line 1 of the file and the now line 2; each place names its lines after the path.
    const numbers = input
      .split("\n")
      .filter((line) => line.includes(file))
      .flatMap((line) => (line.slice(line.indexOf(file) + file.length).match(/\d+/g) ?? []).map(Number));
    for (const line of [1, 2]) assert.ok(numbers.includes(line), `line ${line} of ${file}, in ${JSON.stringify(input)}`);
  }));

  // Last, as from here on a night comes every minute.
  it("switches the session at night: reflection, curator, a new session, and handoff.md committed", track(async () => {
    // Guards against: the nightly switch not running through, or the new session not starting from handoff.md.
    // The backend is made again with a night every minute, so that the test waits for the next minute
    // whatever time it is and however long the start took.
    composeEnv.PENELOPE_E2E_NIGHTLY_CRON = "* * * * *";
    stream.close();
    compose(["up", "--detach", "--no-deps", "backend"]);
    await eventually("the backend's health", async () => ((await browser.request("/healthz")).status === 200 ? true : undefined));

    await eventually(
      "the curator's turn",
      async () => ((await outside.modelCalls()).some((call) => where(call).system.includes("You are the curator")) ? true : undefined),
      240_000,
    );
    const log = await eventually("handoff.md committed", () => {
      const text = memoryLog();
      return text.includes("handoff.md") && text.includes("INDEX.md") ? text : undefined;
    });
    assert.match(log, /Turn [0-9a-f-]{36}\nAgent: main\n+handoff\.md\n/);
    const state = await eventually("the new session", () => {
      const text = exec("sandbox", "cat /home/agent/.pi/agent/sessions/main/current.json", { check: false }).stdout;
      return text.includes('"nightly"') ? (JSON.parse(text) as { file: string; nightly: number }) : undefined;
    });
    assert.equal(typeof state.nightly, "number");

    stream = new Stream();
    await stream.open(browser.cookie!);
    await send("E2E-TURN-4");
    await replied("E2E-REPLY-4");
    const [first] = await callsFor("E2E-TURN-4", 0);
    const sent = where(first!);
    assert.ok(sent.system.includes("E2E-HANDOFF: the next session starts from here."), "handoff.md is in the new system prompt");
    assert.ok(!JSON.stringify(first!.messages).includes("E2E-TURN-1"), "the day's session is left behind");

    // The next night switches again, and turns go on after it.
    await eventually(
      "a second switch",
      () => {
        const text = exec("sandbox", "cat /home/agent/.pi/agent/sessions/main/current.json", { check: false }).stdout;
        const next = JSON.parse(text) as { nightly?: number };
        return next.nightly !== undefined && next.nightly > state.nightly ? true : undefined;
      },
      150_000,
    );
    await send("E2E-TURN-5");
    await replied("E2E-REPLY-5");
  }));
});
