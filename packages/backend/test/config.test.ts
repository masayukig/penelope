import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConfigError, loadConfig } from "../src/config.ts";

const files: Record<string, string> = {
  "/secrets/sandbox-token": "real-token\n",
  "/secrets/github-secret": "client-secret\n",
};
const read = (file: string) => {
  const content = files[file];
  if (content === undefined) throw new Error(`ENOENT: ${file}`);
  return content;
};

describe("the configuration", () => {
  it("has a default for everything but the secrets and the owner", () => {
    const config = loadConfig({}, read);
    assert.deepEqual(config, {
      databasePath: "/var/lib/penelope/backend.sqlite",
      sourcesDir: "/sources",
      memoryDir: "/memory",
      intakeSocket: "/run/penelope/intake/backend.sock",
      sandboxSocket: "/run/penelope/sandbox/backend.sock",
      listen: { host: "0.0.0.0", port: 8080 },
      publicUrl: undefined,
      sandboxToken: undefined,
      github: undefined,
      timeZone: "UTC",
      awakeHours: "07:00-23:00",
      nightly: "0 4 * * *",
      batch: { quietMs: 5 * 60_000, maxMs: 30 * 60_000 },
      redeliverMs: 5 * 60_000,
      builtinDelivery: { ui: "now", cron: "now", a2a: "now", self: "now" },
      inline: new Set(["ui", "control"]),
      gitAuthor: { name: "penelope-backend", email: "backend@penelope.invalid" },
      agent: { name: "Agent", iconFile: undefined },
      webDir: "/app/web",
    });
  });

  it("reads every setting from its variable and the secrets from their files", () => {
    const config = loadConfig(
      {
        PENELOPE_DATABASE: "/data/b.sqlite",
        PENELOPE_SOURCES_DIR: "/s",
        PENELOPE_MEMORY_DIR: "/m",
        PENELOPE_INTAKE_SOCKET: "/run/i.sock",
        PENELOPE_SANDBOX_SOCKET: "/run/s.sock",
        PENELOPE_LISTEN: "[::]:9090",
        PENELOPE_PUBLIC_URL: "https://penelope.example.com/",
        PENELOPE_SANDBOX_TOKEN_FILE: "/secrets/sandbox-token",
        PENELOPE_GITHUB_CLIENT_ID: "client",
        PENELOPE_GITHUB_CLIENT_SECRET_FILE: "/secrets/github-secret",
        PENELOPE_OWNER_GITHUB_ID: "4242",
        PENELOPE_TIME_ZONE: "Asia/Tokyo",
        PENELOPE_AWAKE_HOURS: "08:00-22:00",
        PENELOPE_NIGHTLY_CRON: "30 3 * * *",
        PENELOPE_BATCH_QUIET_MINUTES: "2",
        PENELOPE_BATCH_MAX_MINUTES: "10",
        PENELOPE_REDELIVER_MINUTES: "3",
        PENELOPE_DELIVERY_CRON: "batch",
        PENELOPE_INLINE_SOURCES: "ui, self",
        PENELOPE_GIT_AUTHOR_NAME: "backend",
        PENELOPE_GIT_AUTHOR_EMAIL: "backend@example.com",
        PENELOPE_AGENT_NAME: " Iris ",
        PENELOPE_AGENT_ICON_FILE: "/config/icon.png",
        PENELOPE_WEB_DIR: "/srv/web",
      },
      read,
    );
    assert.equal(config.databasePath, "/data/b.sqlite");
    assert.deepEqual(config.listen, { host: "::", port: 9090 });
    assert.equal(config.publicUrl, "https://penelope.example.com");
    assert.equal(config.sandboxToken, "real-token");
    assert.deepEqual(config.github, {
      clientId: "client",
      clientSecret: "client-secret",
      ownerId: 4242,
      callbackUrl: "https://penelope.example.com/auth/github/callback",
    });
    assert.equal(config.timeZone, "Asia/Tokyo");
    assert.deepEqual(config.batch, { quietMs: 2 * 60_000, maxMs: 10 * 60_000 });
    assert.equal(config.redeliverMs, 3 * 60_000);
    assert.equal(config.builtinDelivery.cron, "batch");
    assert.equal(config.builtinDelivery.ui, "now");
    // control is always inline: the runner needs what it says.
    assert.deepEqual(config.inline, new Set(["ui", "self", "control"]));
    assert.deepEqual(config.gitAuthor, { name: "backend", email: "backend@example.com" });
    // The name and the icon are the deployment's: nothing in the code names her (ADR-0001).
    assert.deepEqual(config.agent, { name: "Iris", iconFile: "/config/icon.png" });
    assert.equal(config.webDir, "/srv/web");
  });

  it("takes the time zone from TZ when it has none of its own", () => {
    assert.equal(loadConfig({ TZ: "Europe/Paris" }, read).timeZone, "Europe/Paris");
  });

  it("refuses a login half set up, naming what is missing", () => {
    assert.throws(
      () => loadConfig({ PENELOPE_GITHUB_CLIENT_ID: "client", PENELOPE_PUBLIC_URL: "https://penelope.example.com" }, read),
      (error: unknown) =>
        error instanceof ConfigError &&
        /PENELOPE_GITHUB_CLIENT_SECRET_FILE/.test(error.message) &&
        /PENELOPE_OWNER_GITHUB_ID/.test(error.message),
    );
  });

  it("refuses values it cannot use", () => {
    for (const env of [
      { PENELOPE_LISTEN: "8080" },
      { PENELOPE_TIME_ZONE: "Mars/Olympus" },
      { PENELOPE_AWAKE_HOURS: "morning" },
      { PENELOPE_NIGHTLY_CRON: "at night" },
      { PENELOPE_BATCH_QUIET_MINUTES: "-1" },
      { PENELOPE_DELIVERY_UI: "later" },
      { PENELOPE_OWNER_GITHUB_ID: "someone" },
      { PENELOPE_PUBLIC_URL: "not a url" },
      { PENELOPE_SANDBOX_TOKEN_FILE: "/secrets/missing" },
      // The icon is served with the image type its extension names.
      { PENELOPE_AGENT_ICON_FILE: "/config/icon.txt" },
    ]) {
      assert.throws(() => loadConfig(env, read), ConfigError, JSON.stringify(env));
    }
  });

  it("refuses an empty secret", () => {
    files["/secrets/empty"] = "\n";
    assert.throws(() => loadConfig({ PENELOPE_SANDBOX_TOKEN_FILE: "/secrets/empty" }, read), ConfigError);
  });
});
