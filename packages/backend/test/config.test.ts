import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConfigError, loadConfig } from "../src/config.ts";

const files: Record<string, string> = {
  "/secrets/sandbox-token": "real-token\n",
  "/secrets/github-secret": "client-secret\n",
  "/avatars/iris/avatar.json": JSON.stringify({ id: "iris", name: "Iris", icons: { neutral: "icons/neutral.webp", happy: "icons/happy.webp" } }),
  "/avatars/escape/avatar.json": JSON.stringify({ name: "Out", icons: { neutral: "../../secrets/github-secret.webp" } }),
  "/avatars/text/avatar.json": JSON.stringify({ name: "Text", icons: { neutral: "icons/neutral.txt" } }),
  "/avatars/broken/avatar.json": "{",
  "/sa/token": "backend-sa-token\n",
  "/sa/ca.crt": "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n",
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
      heartbeatMs: undefined,
      builtinDelivery: { ui: "now", cron: "now", a2a: "now", self: "now" },
      inline: new Set(["ui", "control"]),
      gitAuthor: { name: "penelope-backend", email: "backend@penelope.invalid" },
      agent: { name: "Agent", icons: {} },
      webDir: "/app/web",
      a2a: undefined,
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
        PENELOPE_AVATARS_DIR: "/avatars",
        PENELOPE_AVATAR: "iris",
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
    // The name and the faces are the avatar's the deployment chose: nothing in the code names her (ADR-0001).
    assert.deepEqual(config.agent, { name: "Iris", icons: { neutral: "/avatars/iris/icons/neutral.webp", happy: "/avatars/iris/icons/happy.webp" } });
    assert.equal(config.webDir, "/srv/web");
  });

  it("lets the settings name the agent over her avatar's name", () => {
    const config = loadConfig({ PENELOPE_AVATARS_DIR: "/avatars", PENELOPE_AVATAR: "iris", PENELOPE_AGENT_NAME: " Kestrel " }, read);
    assert.equal(config.agent.name, "Kestrel");
    assert.equal(config.agent.icons.neutral, "/avatars/iris/icons/neutral.webp");
    assert.equal(loadConfig({ PENELOPE_AGENT_NAME: "Kestrel" }, read).agent.name, "Kestrel");
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

  it("has a heartbeat only when its minutes are set (ADR-0031)", () => {
    assert.equal(loadConfig({ PENELOPE_HEARTBEAT_MINUTES: "60" }, read).heartbeatMs, 60 * 60_000);
  });

  it("refuses values it cannot use", () => {
    for (const env of [
      { PENELOPE_LISTEN: "8080" },
      { PENELOPE_TIME_ZONE: "Mars/Olympus" },
      { PENELOPE_AWAKE_HOURS: "morning" },
      { PENELOPE_NIGHTLY_CRON: "at night" },
      { PENELOPE_BATCH_QUIET_MINUTES: "-1" },
      { PENELOPE_HEARTBEAT_MINUTES: "0" },
      { PENELOPE_HEARTBEAT_MINUTES: "an hour" },
      { PENELOPE_DELIVERY_UI: "later" },
      { PENELOPE_OWNER_GITHUB_ID: "someone" },
      { PENELOPE_PUBLIC_URL: "not a url" },
      { PENELOPE_SANDBOX_TOKEN_FILE: "/secrets/missing" },
      // An avatar must be there and readable, its faces images inside its own directory.
      { PENELOPE_AVATARS_DIR: "/avatars", PENELOPE_AVATAR: "missing" },
      { PENELOPE_AVATARS_DIR: "/avatars", PENELOPE_AVATAR: "broken" },
      { PENELOPE_AVATARS_DIR: "/avatars", PENELOPE_AVATAR: "escape" },
      { PENELOPE_AVATARS_DIR: "/avatars", PENELOPE_AVATAR: "text" },
      { PENELOPE_AVATARS_DIR: "/avatars", PENELOPE_AVATAR: "../secrets" },
    ]) {
      assert.throws(() => loadConfig(env, read), ConfigError, JSON.stringify(env));
    }
  });

  it("refuses an empty secret", () => {
    files["/secrets/empty"] = "\n";
    assert.throws(() => loadConfig({ PENELOPE_SANDBOX_TOKEN_FILE: "/secrets/empty" }, read), ConfigError);
  });

  describe("the A2A way in", () => {
    const base = { PENELOPE_PUBLIC_URL: "https://penelope.example.com", PENELOPE_A2A_SENDERS: "agents/claude, natsumi/natsumi" };
    const gated = { PENELOPE_A2A_AUTH: "gated-assertion", PENELOPE_A2A_GATED_ISSUER: "https://auth.example.com", PENELOPE_A2A_GATED_JWKS_URL: "https://auth.example.com/__gated/jwks.json" };
    const cluster = { KUBERNETES_SERVICE_HOST: "10.0.0.1", KUBERNETES_SERVICE_PORT: "443", PENELOPE_KUBERNETES_TOKEN_FILE: "/sa/token", PENELOPE_KUBERNETES_CA_FILE: "/sa/ca.crt" };

    it("is closed without senders", () => {
      // Guards against: the way in opened by a check set up with nobody allowed (ADR-0010).
      assert.equal(loadConfig({ ...gated, PENELOPE_PUBLIC_URL: "https://penelope.example.com" }, read).a2a, undefined);
    });

    it("checks gated's assertion for the public host, with the limits' defaults", () => {
      const { a2a } = loadConfig({ ...base, ...gated }, read);
      assert.deepEqual(a2a, {
        senders: ["agents/claude", "natsumi/natsumi"],
        gated: { issuer: "https://auth.example.com", jwksUrl: "https://auth.example.com/__gated/jwks.json", audience: "penelope.example.com" },
        tokenReview: undefined,
        description: "",
        url: "https://penelope.example.com/a2a/",
        limits: { deadlineMs: 24 * 3_600_000, maxOpenTasks: 3 },
      });
    });

    it("reviews tokens with the API server of the cluster it runs in, for the audiences set", () => {
      const { a2a } = loadConfig({ ...base, ...cluster, PENELOPE_A2A_AUTH: "tokenreview", PENELOPE_A2A_AUDIENCES: "https://penelope.example.com, https://auth.example.com" }, read);
      assert.deepEqual(a2a?.tokenReview, {
        kubernetes: { url: "https://10.0.0.1:443", tokenFile: "/sa/token", ca: files["/sa/ca.crt"] },
        audiences: ["https://penelope.example.com", "https://auth.example.com"],
      });
      assert.equal(a2a?.gated, undefined);
    });

    it("may check both ways at once, and reads the limits and the description", () => {
      const { a2a } = loadConfig(
        {
          ...base,
          ...gated,
          ...cluster,
          PENELOPE_A2A_AUTH: "gated-assertion,tokenreview",
          PENELOPE_A2A_AUDIENCES: "https://penelope.example.com",
          PENELOPE_KUBERNETES_URL: "https://kubernetes.example.com:6443",
          PENELOPE_A2A_DESCRIPTION: "The cluster's operator.",
          PENELOPE_A2A_DEADLINE_HOURS: "6",
          PENELOPE_A2A_MAX_OPEN_TASKS: "1",
        },
        read,
      );
      assert.ok(a2a?.gated && a2a.tokenReview);
      assert.equal(a2a.tokenReview.kubernetes.url, "https://kubernetes.example.com:6443");
      assert.deepEqual(a2a.tokenReview.audiences, ["https://penelope.example.com"]);
      assert.equal(a2a.description, "The cluster's operator.");
      assert.deepEqual(a2a.limits, { deadlineMs: 6 * 3_600_000, maxOpenTasks: 1 });
    });

    it("does not start with senders but no way to check them, or a check it cannot make", () => {
      // Guards against: a way in that lets everyone in, or nobody, without saying so at the start.
      for (const env of [
        { ...base },
        { ...base, PENELOPE_A2A_AUTH: "password" },
        { ...base, PENELOPE_A2A_AUTH: "gated-assertion" },
        { ...base, ...gated, PENELOPE_PUBLIC_URL: undefined },
        { ...base, PENELOPE_A2A_AUTH: "tokenreview", PENELOPE_A2A_AUDIENCES: "https://penelope.example.com" },
        { ...base, ...cluster, PENELOPE_A2A_AUTH: "tokenreview", PENELOPE_A2A_AUDIENCES: "https://penelope.example.com", PENELOPE_KUBERNETES_TOKEN_FILE: "/sa/missing" },
        // Without an audience of its own, the API server's would let in the token every Pod of the ServiceAccount is given.
        { ...base, ...cluster, PENELOPE_A2A_AUTH: "tokenreview" },
        { ...base, ...gated, PENELOPE_A2A_SENDERS: "claude" },
        { ...base, ...gated, PENELOPE_A2A_SENDERS: "a/claude,b/claude" },
        { ...base, ...gated, PENELOPE_A2A_MAX_OPEN_TASKS: "0" },
      ]) {
        assert.throws(() => loadConfig(env, read), ConfigError, JSON.stringify(env));
      }
    });
  });
});
