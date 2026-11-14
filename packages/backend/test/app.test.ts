import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { startBackend } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { run } from "../src/main.ts";
import { ask, tempDir } from "./support.ts";

describe("the backend", () => {
  it("takes an event in, hands it to the runner, keeps the reply and commits the memory", async (t) => {
    const dir = tempDir(t);
    writeFileSync(path.join(dir, "token"), "real-token\n");
    const config = loadConfig(
      {
        PENELOPE_DATABASE: path.join(dir, "state/backend.sqlite"),
        PENELOPE_SOURCES_DIR: path.join(dir, "sources"),
        PENELOPE_MEMORY_DIR: path.join(dir, "memory"),
        PENELOPE_INTAKE_SOCKET: path.join(dir, "intake/backend.sock"),
        PENELOPE_SANDBOX_SOCKET: path.join(dir, "sandbox/backend.sock"),
        PENELOPE_LISTEN: "127.0.0.1:0",
        PENELOPE_SANDBOX_TOKEN_FILE: path.join(dir, "token"),
      },
      (file) => execFileSync("cat", [file], { encoding: "utf8" }),
    );
    const backend = await startBackend(config, { log: () => {} });
    t.after(() => backend.close());

    const intake = { socketPath: config.intakeSocket };
    const sandbox = { socketPath: config.sandboxSocket };
    const auth = { authorization: "Bearer real-token" };

    const sent = await ask(intake, "/v1/events", {
      json: { source: "github", id: "d-1", occurred_at: "2026-11-14T09:00:00Z", summary: "a push", delivery: "now", payload: {} },
    });
    assert.equal(sent.status, 202);

    const { events } = (await ask(sandbox, "/v1/events?agent=main&wait=5", { headers: auth })).json();
    assert.deepEqual(events.map((e: { summary: string }) => e.summary), ["a push"]);
    assert.ok(existsSync(events[0].appended.path));

    await ask(sandbox, "/v1/replies", { headers: auth, json: { agent: "main", text: "seen", in_reply_to: events[0].seq } });
    writeFileSync(path.join(config.memoryDir, "diary.md"), "a push came\n");
    assert.equal((await ask(sandbox, "/v1/turns/end", { headers: auth, json: { agent: "main", turn_id: "t-1" } })).status, 204);
    assert.equal((await ask(sandbox, "/v1/events/ack", { headers: auth, json: { agent: "main", seqs: [events[0].seq] } })).status, 204);

    const log = execFileSync("git", ["-c", `safe.directory=${config.memoryDir}`, "log", "--format=%s"], {
      cwd: config.memoryDir,
      encoding: "utf8",
    });
    assert.equal(log, "Turn t-1\n");
    // The UI's port answers, and without a login it lets no one in.
    const ui = { port: backend.port };
    assert.equal((await ask(ui, "/healthz")).status, 200);
    assert.equal((await ask(ui, "/api/history")).status, 401);
  });
});

describe("the command", () => {
  it("prints the version from PENELOPE_VERSION", () => {
    assert.deepEqual(run(["version"], { PENELOPE_VERSION: "v1.2.3" }), { code: 0, stdout: "v1.2.3\n", stderr: "" });
  });

  it("prints dev when no version was given", () => {
    assert.equal(run(["version"], {}).stdout, "dev\n");
  });

  it("prints the usage and exits with 2 for anything else", () => {
    const result = run(["nonsense"], {});
    assert.equal(result.code, 2);
    assert.match(result.stderr, /^usage: backend serve\|version/);
  });
});
