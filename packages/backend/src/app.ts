// The backend put together: one SQLite file, /sources and /memory, and three
// servers: the intake and the sandbox's API on Unix sockets, the UI's API on
// TCP (docs/pod.md).
import { mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";

import type { Config } from "./config.ts";
import { Conversation } from "./conversation.ts";
import { openDatabase } from "./db.ts";
import { Feed } from "./feed.ts";
import { close, listenTcp, listenUnix } from "./http.ts";
import { intakeHandler } from "./intake.ts";
import { type GitHubEndpoints, GitHubLogin } from "./login/github.ts";
import { LoginSessions } from "./login/sessions.ts";
import { Memory } from "./memory.ts";
import { Queue } from "./queue.ts";
import { sandboxHandler } from "./sandbox-api.ts";
import { Scheduler, Schedules } from "./schedules.ts";
import { Sources } from "./sources.ts";
import { AwakeHours } from "./time.ts";
import { uiHandler } from "./ui-api.ts";

export type Backend = { port: number; close: () => Promise<void> };

export async function startBackend(
  config: Config,
  { log = console.error, now = Date.now, githubEndpoints }: { log?: (line: string) => void; now?: () => number; githubEndpoints?: GitHubEndpoints } = {},
): Promise<Backend> {
  for (const dir of [path.dirname(config.databasePath), config.sourcesDir, config.memoryDir, path.dirname(config.intakeSocket), path.dirname(config.sandboxSocket)]) {
    mkdirSync(dir, { recursive: true });
  }
  const db = openDatabase(config.databasePath);
  const queue = new Queue(db, new Sources(config.sourcesDir, config.timeZone), {
    now,
    inline: config.inline,
    builtinDelivery: config.builtinDelivery,
    batch: config.batch,
    awake: new AwakeHours(config.awakeHours, config.timeZone),
    redeliverMs: config.redeliverMs,
  });
  const feed = new Feed();
  const conversation = new Conversation(db, feed, { now });
  const schedules = new Schedules(db, { now, timeZone: config.timeZone });
  const scheduler = new Scheduler(schedules, queue, { now, timeZone: config.timeZone, nightly: config.nightly, log });
  const memory = new Memory(config.memoryDir, config.gitAuthor);
  const sessions = new LoginSessions(db, { now });
  const login = new GitHubLogin({ settings: config.github, ...(githubEndpoints ? { endpoints: githubEndpoints } : {}), sessions, now, log });

  const intake = await listenUnix(intakeHandler(queue, { log }), config.intakeSocket, log);
  const sandbox = await listenUnix(
    sandboxHandler({ token: config.sandboxToken, queue, conversation, schedules, memory, now, log }),
    config.sandboxSocket,
    log,
  );
  const ui = await listenTcp(
    uiHandler({ queue, conversation, feed, login, sessions, ownerId: config.github?.ownerId, publicUrl: config.publicUrl, now }),
    config.listen.host,
    config.listen.port,
    log,
  );
  const stopScheduler = scheduler.start();

  if (config.sandboxToken === undefined) log("backend: no PENELOPE_SANDBOX_TOKEN_FILE; the sandbox's API refuses every request");
  if (config.github === undefined) log("backend: no GitHub login set up; no one can sign in to the UI");
  const port = (ui.address() as AddressInfo).port;
  log(`backend: intake on ${config.intakeSocket}, sandbox's API on ${config.sandboxSocket}, UI on ${config.listen.host}:${port}`);

  return {
    port,
    close: async () => {
      stopScheduler();
      await Promise.all([close(intake), close(sandbox), close(ui)]);
      db.close();
    },
  };
}
