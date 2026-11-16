import assert from "node:assert/strict";
import { createECDH, createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { SubAgents } from "../src/agents.ts";
import { Conversation } from "../src/conversation.ts";
import { openDatabase } from "../src/db.ts";
import { Feed } from "../src/feed.ts";
import { close, type Handler, listenTcp, sendJson } from "../src/http.ts";
import { GitHubLogin, type GitHubSettings } from "../src/login/github.ts";
import { LoginSessions } from "../src/login/sessions.ts";
import { PushSubscriptions } from "../src/push/notifier.ts";
import { Queue } from "../src/queue.ts";
import { Sources } from "../src/sources.ts";
import { AwakeHours } from "../src/time.ts";
import { uiHandler } from "../src/ui-api.ts";
import { ask, type Ask, FakeClock, multipart, SseReader, tempDir } from "./support.ts";

const OWNER = 4242;

/** A stand-in for GitHub's token exchange and user API. */
async function fakeGitHub(t: { after: (fn: () => Promise<void>) => void }) {
  const state = { userId: OWNER, down: false, challenges: new Map<string, string>(), exchanged: 0 };
  const server = http.createServer((request, response) => {
    if (state.down) {
      response.writeHead(503).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.url === "/login/oauth/access_token") {
        state.exchanged += 1;
        const form = new URLSearchParams(Buffer.concat(chunks).toString());
        const challenge = state.challenges.get(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const ok = challenge === createHash("sha256").update(verifier).digest("base64url") && form.get("client_secret") === "secret";
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(ok ? { access_token: "gho_x" } : { error: "bad_verification_code" }));
        return;
      }
      if (request.url === "/user" && request.headers.authorization === "Bearer gho_x") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: state.userId, login: "someone" }));
        return;
      }
      response.writeHead(401).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => close(server));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    state,
    endpoints: { authorizeUrl: `${base}/login/oauth/authorize`, tokenUrl: `${base}/login/oauth/access_token`, userUrl: `${base}/user` },
  };
}

async function setup(
  t: { after: (fn: () => void | Promise<void>) => void },
  {
    configured = true,
    publicUrl = "http://penelope.example.com",
    agent = { name: "Iris", icons: {} as Record<string, string> },
    a2a = undefined as Handler | undefined,
    web = undefined as Handler | undefined,
    pushKey = undefined as string | undefined,
  } = {},
) {
  const dir = tempDir(t);
  const clock = new FakeClock("2026-11-14T09:00:00Z");
  const now = clock.now;
  const db = openDatabase(path.join(dir, "backend.sqlite"));
  const sourcesDir = path.join(dir, "sources");
  const queue = new Queue(db, new Sources(sourcesDir, "UTC"), {
    now,
    inline: new Set(["ui", "control"]),
    builtinDelivery: { ui: "now" },
    batch: { quietMs: 300_000, maxMs: 1_800_000 },
    awake: new AwakeHours("00:00-00:00", "UTC"),
    redeliverMs: 300_000,
  });
  const feed = new Feed();
  const conversation = new Conversation(db, feed, { now });
  const agents = new SubAgents(db, feed, conversation, { now });
  const github = await fakeGitHub(t);
  const sessions = new LoginSessions(db, { now });
  const settings: GitHubSettings | undefined = configured
    ? { clientId: "client", clientSecret: "secret", ownerId: OWNER, callbackUrl: `${publicUrl}/auth/github/callback` }
    : undefined;
  const login = new GitHubLogin({ settings, endpoints: github.endpoints, sessions, now, log: () => {} });
  const subscriptions = new PushSubscriptions(db, { now });
  const push = pushKey === undefined ? undefined : { publicKey: pushKey, subscriptions };
  const server = await listenTcp(
    uiHandler({
      queue,
      conversation,
      agents,
      feed,
      login,
      sessions,
      ownerId: settings?.ownerId,
      publicUrl,
      agent,
      now,
      ...(a2a ? { a2a } : {}),
      ...(web ? { web } : {}),
      ...(push ? { push } : {}),
    }),
    "127.0.0.1",
    0,
  );
  t.after(async () => {
    await close(server);
    db.close();
  });
  const target = { port: (server.address() as AddressInfo).port };
  const cookieOf = (token: string) => `penelope_session=${token}`;
  /** A session as a finished login leaves it. */
  const signIn = () => cookieOf(sessions.create(OWNER).token);
  const call = (pathname: string, cookie: string | undefined, options: Ask = {}) =>
    ask(target, pathname, { ...options, headers: { ...(cookie ? { cookie } : {}), ...options.headers } });
  return { queue, conversation, agents, feed, sessions, github, target, signIn, call, sourcesDir, clock, subscriptions };
}

/** A Set-Cookie line as its value and its attributes, in whatever order they came. */
function parseCookie(line: string | undefined): { name: string; value: string; attributes: Map<string, string> } {
  assert.ok(line, "a Set-Cookie line");
  const [pair, ...rest] = line.split(";").map((part) => part.trim());
  const [name, value] = pair!.split("=") as [string, string];
  const attributes = new Map(
    rest.map((part) => {
      const [key, ...v] = part.split("=");
      return [key!.toLowerCase(), v.join("=")] as [string, string];
    }),
  );
  return { name, value, attributes };
}

/** Follows a login through GitHub as a browser would, and answers the callback's response. */
async function logIn(env: Awaited<ReturnType<typeof setup>>, { tamperState = false } = {}) {
  const start = await env.call("/auth/github/start", undefined);
  assert.equal(start.status, 302);
  const authorize = new URL(String(start.headers.location));
  const code = `code-${Math.random()}`;
  env.github.state.challenges.set(code, authorize.searchParams.get("code_challenge") ?? "");
  const state = tamperState ? "forged" : authorize.searchParams.get("state");
  return env.call(`/auth/github/callback?code=${code}&state=${state}`, undefined);
}

describe("the login", () => {
  it("sends the browser to GitHub with a state and a PKCE challenge", async (t) => {
    const env = await setup(t);
    const start = await env.call("/auth/github/start", undefined);
    assert.equal(start.status, 302);
    const location = new URL(String(start.headers.location));
    assert.equal(`${location.origin}${location.pathname}`, env.github.endpoints.authorizeUrl);
    assert.equal(location.searchParams.get("client_id"), "client");
    assert.equal(location.searchParams.get("redirect_uri"), "http://penelope.example.com/auth/github/callback");
    assert.equal(location.searchParams.get("code_challenge_method"), "S256");
    // An S256 challenge is the 43 base64url characters of a SHA-256 (RFC 7636).
    assert.match(location.searchParams.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
    assert.ok((location.searchParams.get("state") ?? "").length > 0);
  });

  it("lets the owner in with a session cookie and goes back to the top", async (t) => {
    const env = await setup(t);
    const callback = await logIn(env);
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.location, "/");
    const [cookie] = callback.headers["set-cookie"] ?? [];
    // The cookie of docs/backend.md: one, HttpOnly, SameSite=Strict, for the whole site, for 30 days.
    const { name, value, attributes } = parseCookie(cookie);
    assert.equal(name, "penelope_session");
    assert.ok(value.length > 0);
    assert.equal(attributes.get("path"), "/");
    assert.ok(attributes.has("httponly"));
    assert.equal(attributes.get("samesite")?.toLowerCase(), "strict");
    assert.equal(attributes.get("max-age"), String(30 * 24 * 60 * 60));
    assert.ok(!attributes.has("secure"), "not Secure over http");
    const session = `${name}=${value}`;
    assert.equal((await env.call("/api/history", session)).status, 200);
  });

  it("marks the cookie Secure when the backend is served over https", async (t) => {
    const env = await setup(t, { publicUrl: "https://penelope.example.com" });
    const [cookie] = (await logIn(env)).headers["set-cookie"] ?? [];
    assert.ok(parseCookie(cookie).attributes.has("secure"));
  });

  it("does not let in a GitHub account that is not the owner's", async (t) => {
    const env = await setup(t);
    env.github.state.userId = 7;
    const callback = await logIn(env);
    assert.equal(callback.status, 403);
    assert.equal(callback.json().error, "account-not-allowed");
    assert.equal(callback.headers["set-cookie"], undefined);
  });

  it("refuses a callback whose state it did not give, without asking GitHub", async (t) => {
    const env = await setup(t);
    const callback = await logIn(env, { tamperState: true });
    assert.equal(callback.status, 400);
    assert.equal(callback.json().error, "invalid-state");
    assert.equal(env.github.state.exchanged, 0);
  });

  it("takes each state once", async (t) => {
    const env = await setup(t);
    const start = await env.call("/auth/github/start", undefined);
    const authorize = new URL(String(start.headers.location));
    env.github.state.challenges.set("c", authorize.searchParams.get("code_challenge") ?? "");
    const url = `/auth/github/callback?code=c&state=${authorize.searchParams.get("state")}`;
    assert.equal((await env.call(url, undefined)).status, 302);
    assert.equal((await env.call(url, undefined)).status, 400);
  });

  it("refuses a login that took longer than its 10 minutes", async (t) => {
    const env = await setup(t);
    const start = await env.call("/auth/github/start", undefined);
    const authorize = new URL(String(start.headers.location));
    env.github.state.challenges.set("c", authorize.searchParams.get("code_challenge") ?? "");
    env.clock.advance(10);
    const callback = await env.call(`/auth/github/callback?code=c&state=${authorize.searchParams.get("state")}`, undefined);
    assert.equal(callback.status, 400);
    assert.equal(callback.json().error, "login-expired");
  });

  it("answers 403 when the owner declined at GitHub", async (t) => {
    const env = await setup(t);
    const start = await env.call("/auth/github/start", undefined);
    const state = new URL(String(start.headers.location)).searchParams.get("state");
    const callback = await env.call(`/auth/github/callback?error=access_denied&state=${state}`, undefined);
    assert.equal(callback.status, 403);
    assert.equal(callback.json().error, "github-denied");
  });

  it("answers 502 when GitHub does not take the code", async (t) => {
    // Guards against: a login that goes on, or is taken as GitHub being down, when the exchange is refused.
    const env = await setup(t);
    const start = await env.call("/auth/github/start", undefined);
    const state = new URL(String(start.headers.location)).searchParams.get("state");
    // GitHub never gave this code: its exchange is refused.
    const callback = await env.call(`/auth/github/callback?code=unknown&state=${state}`, undefined);
    assert.equal(callback.status, 502);
    assert.equal(callback.json().error, "github-exchange-failed");
    assert.equal(callback.headers["set-cookie"], undefined);
  });

  it("answers 429 while too many logins are under way, until they expire", async (t) => {
    // Guards against: logins started without end filling the backend's memory (docs/backend.md: they live 10 minutes).
    const env = await setup(t);
    let refused: Awaited<ReturnType<typeof env.call>> | undefined;
    for (let i = 0; i < 1000 && !refused; i++) {
      const start = await env.call("/auth/github/start", undefined);
      if (start.status !== 302) refused = start;
    }
    assert.ok(refused, "some number of logins under way is too many");
    assert.equal(refused.status, 429);
    assert.equal(refused.json().error, "too-many-logins");
    env.clock.advance(10);
    assert.equal((await env.call("/auth/github/start", undefined)).status, 302, "the expired ones make room");
  });

  it("answers 502 when GitHub cannot be reached", async (t) => {
    const env = await setup(t);
    env.github.state.down = true;
    const callback = await logIn(env);
    assert.equal(callback.status, 502);
    assert.equal(callback.json().error, "github-unavailable");
  });

  it("lets no one in when it is not configured", async (t) => {
    const env = await setup(t, { configured: false });
    const start = await env.call("/auth/github/start", undefined);
    assert.equal(start.status, 503);
    assert.equal(start.json().error, "login-not-configured");
    const forged = env.sessions.create(OWNER).token;
    assert.equal((await env.call("/api/history", `penelope_session=${forged}`)).status, 401);
  });

  it("logs out: the cookie is cleared and the session no longer works", async (t) => {
    const env = await setup(t);
    const session = env.signIn();
    const out = await env.call("/auth/logout", session, { method: "POST" });
    assert.equal(out.status, 204);
    const cleared = parseCookie(out.headers["set-cookie"]?.[0]);
    assert.equal(cleared.name, "penelope_session");
    assert.equal(cleared.value, "");
    assert.equal(cleared.attributes.get("max-age"), "0");
    assert.equal((await env.call("/api/history", session)).status, 401);
  });
});

describe("the UI's API", () => {
  it("answers 401 to a request without a session", async (t) => {
    const env = await setup(t);
    for (const [pathname, options] of [
      ["/api/history", {}],
      ["/api/stream", {}],
      ["/api/messages", { json: { text: "hi" } }],
      ["/api/agents", {}],
    ] as const) {
      const answer = await env.call(pathname, undefined, options);
      assert.equal(answer.status, 401, pathname);
      assert.equal(typeof answer.json().error, "string");
    }
    assert.equal((await env.call("/api/history", "penelope_session=not-a-token")).status, 401);
  });

  describe("a message", () => {
    it("becomes an inline ui event and a line of the history", async (t) => {
      const env = await setup(t);
      const answer = await env.call("/api/messages", env.signIn(), { json: { text: "hello\nmore" } });
      assert.equal(answer.status, 202);
      const { id } = answer.json();
      const [event] = env.queue.take({ after: 0 });
      assert.equal(event?.source, "ui");
      assert.equal(event?.id, id);
      assert.equal(event?.summary, "hello");
      assert.equal(event?.delivery, "now");
      assert.deepEqual(event?.inline && event.payload, { text: "hello\nmore" });
      assert.deepEqual(env.conversation.page().entries.map((e) => [e.kind, e.id, e.text]), [["owner", id, "hello\nmore"]]);
    });

    it("carries files sent with it as multipart", async (t) => {
      const env = await setup(t);
      const { body, contentType } = await multipart([
        ["text", "see this"],
        ["file", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: "image/png" }), "shot.png"],
      ]);
      const answer = await env.call("/api/messages", env.signIn(), { body, headers: { "content-type": contentType } });
      assert.equal(answer.status, 202);
      const [event] = env.queue.take({ after: 0 });
      assert.deepEqual(event?.attachments, [{ path: path.join(env.sourcesDir, "ui/files/1-shot.png"), mime_type: "image/png", size: 8 }]);
    });

    it("is summed up by its first line, cut at 200 characters", async (t) => {
      // Guards against: a long message making a summary that is not one line (docs/ui-api.md).
      const env = await setup(t);
      const cookie = env.signIn();
      await env.call("/api/messages", cookie, { json: { text: `${"a".repeat(300)}\nsecond` } });
      const [event] = env.queue.take({ after: 0 });
      assert.ok(event!.summary.startsWith("a".repeat(200)));
      assert.ok(!event!.summary.includes("a".repeat(201)));
      assert.ok(!event!.summary.includes("second"));
    });

    it("of files alone is summed up by how many there are", async (t) => {
      const env = await setup(t);
      const { body, contentType } = await multipart([
        ["file", new Blob(["a"]), "a.txt"],
        ["file", new Blob(["b"]), "b.txt"],
      ]);
      assert.equal((await env.call("/api/messages", env.signIn(), { body, headers: { "content-type": contentType } })).status, 202);
      const [event] = env.queue.take({ after: 0 });
      assert.match(event!.summary, /\b2\b/);
    });

    it("is refused with no text and no files", async (t) => {
      const env = await setup(t);
      assert.equal((await env.call("/api/messages", env.signIn(), { json: { text: "" } })).status, 400);
      assert.equal((await env.call("/api/messages", env.signIn(), { json: {} })).status, 400);
    });
  });

  describe("the history", () => {
    it("comes newest first, a page at a time", async (t) => {
      const env = await setup(t);
      for (let i = 1; i <= 60; i++) env.conversation.ownerMessage({ id: `m-${i}`, text: `${i}` });
      const cookie = env.signIn();
      const first = (await env.call("/api/history", cookie)).json();
      assert.equal(first.entries.length, 50);
      assert.equal(first.entries[0].id, "m-60");
      const second = (await env.call(`/api/history?before=${encodeURIComponent(first.before)}`, cookie)).json();
      assert.deepEqual(second.entries.map((e: { id: string }) => e.id).slice(0, 2), ["m-10", "m-9"]);
      assert.equal(second.before, undefined);
    });

    it("refuses a cursor it did not give", async (t) => {
      const env = await setup(t);
      assert.equal((await env.call("/api/history?before=x", env.signIn())).status, 400);
    });
  });

  describe("the stream", () => {
    it("sends replies, activity and state as server-sent events", async (t) => {
      const env = await setup(t);
      const reader = new SseReader();
      t.after(() => reader.close());
      await reader.open(env.target, "/api/stream", { cookie: env.signIn() });
      assert.equal(reader.status, 200);
      env.conversation.reply({ agent: "main", text: "done" });
      env.conversation.turnEnded("main");
      await reader.waitFor(2);
      assert.deepEqual(reader.events.map((e) => [e.id, e.event]), [["1", "reply"], ["2", "state"]]);
      assert.equal(reader.events[0]?.data.text, "done");
    });

    it("sends again what came after the Last-Event-ID", async (t) => {
      const env = await setup(t);
      env.conversation.turnEnded("main");
      env.conversation.turnEnded("main");
      const reader = new SseReader();
      t.after(() => reader.close());
      await reader.open(env.target, "/api/stream", { cookie: env.signIn(), "last-event-id": "1" });
      await reader.waitFor(1);
      assert.deepEqual(reader.events.map((e) => e.id), ["2"]);
    });
  });

  // The login screen and the home screen's icon show who she is before
  // anyone signs in, and the name comes from the settings (ADR-0001).
  describe("the agent", () => {
    it("is named from the settings, without a session", async (t) => {
      const env = await setup(t, { agent: { name: "Iris", icons: {} } });
      const answer = await env.call("/api/agent", undefined);
      assert.equal(answer.status, 200);
      assert.deepEqual(answer.json(), { name: "Iris" });
      assert.equal((await env.call("/api/agent/icons/neutral", undefined)).status, 404);
    });

    // The avatar changes its face with the expression of her replies (ADR-0016).
    it("serves each face of the avatar the settings chose, without a session", async (t) => {
      const dir = tempDir(t);
      const faces = { neutral: Buffer.from("RIFF-neutral"), happy: Buffer.from("RIFF-happy") };
      for (const [name, body] of Object.entries(faces)) writeFileSync(path.join(dir, `${name}.webp`), body);
      const icons = { neutral: path.join(dir, "neutral.webp"), happy: path.join(dir, "happy.webp") };
      const env = await setup(t, { agent: { name: "Iris", icons } });
      const agent = (await env.call("/api/agent", undefined)).json();
      assert.deepEqual(Object.keys(agent.icons).sort(), ["happy", "neutral"]);
      const happy = await env.call(agent.icons.happy, undefined);
      assert.equal(happy.status, 200);
      assert.equal(happy.headers["content-type"], "image/webp");
      assert.equal(happy.text, "RIFF-happy");
      assert.equal((await env.call("/api/agent/icons/angry", undefined)).status, 404);
    });

    it("gives nothing else away without a session", async (t) => {
      const env = await setup(t);
      assert.equal((await env.call("/api/agent/other", undefined)).status, 401);
      assert.equal((await env.call("/api/agent/icons/../../history", undefined)).status, 401);
    });
  });

  describe("the sub-agents", () => {
    it("are listed while they are not closed, with their purpose and state", async (t) => {
      const env = await setup(t);
      const at = "2026-11-14T09:00:00Z";
      assert.deepEqual((await env.call("/api/agents", env.signIn())).json(), { agents: [] });
      env.agents.record({ agent: "review-pr-22", purpose: "review PR 22", closed: false });
      env.clock.advance(1);
      env.agents.record({ agent: "dig-logs", purpose: "dig the logs", closed: false });
      env.agents.record({ agent: "old-one", purpose: "done long ago", closed: false });
      env.agents.record({ agent: "old-one", purpose: "done long ago", closed: true });
      env.clock.advance(1);
      env.conversation.activities("dig-logs", [{ kind: "turn_start", at, turn_id: "t-1" }]);
      env.conversation.activities("main", [{ kind: "turn_start", at, turn_id: "t-2" }]);
      const answer = await env.call("/api/agents", env.signIn());
      assert.equal(answer.status, 200);
      assert.deepEqual(answer.json(), {
        agents: [
          {
            agent: "review-pr-22",
            purpose: "review PR 22",
            state: "waiting",
            started_at: "2026-11-14T09:00:00.000Z",
            state_since: "2026-11-14T09:00:00.000Z",
          },
          {
            agent: "dig-logs",
            purpose: "dig the logs",
            state: "thinking",
            started_at: "2026-11-14T09:01:00.000Z",
            state_since: at,
          },
        ],
      });
    });
  });

  it("answers the health check without a session", async (t) => {
    const env = await setup(t);
    assert.equal((await env.call("/healthz", undefined)).status, 200);
  });

  // What is not under /api/ is the Web UI's (web.test.ts); an API path it does not have is 404, not a page.
  it("answers 404 to an API path it does not have", async (t) => {
    const env = await setup(t);
    assert.equal((await env.call("/api/nothing", env.signIn())).status, 404);
  });

  describe("the A2A way in", () => {
    const web: Handler = async (_request, response) => sendJson(response, 200, { page: true });

    it("is handed /a2a and what is under it, without a login", async (t) => {
      // Guards against: the senders' calls going to the Web UI, or asked for the owner's cookie.
      const a2a: Handler = async (request, response) => sendJson(response, 200, { a2a: request.url });
      const { call } = await setup(t, { a2a, web });
      for (const pathname of ["/a2a", "/a2a/", "/a2a/.well-known/agent-card.json"]) {
        const answer = await call(pathname, undefined);
        assert.deepEqual(answer.json(), { a2a: pathname });
      }
      assert.deepEqual((await call("/a2another", undefined)).json(), { page: true });
    });

    it("is not found while it is closed, rather than the Web UI's page", async (t) => {
      // Guards against: a sender reading the page as an Agent Card, or taking a closed way in for an open one.
      const { call } = await setup(t, { web });
      const answer = await call("/a2a/.well-known/agent-card.json", undefined);
      assert.equal(answer.status, 404);
      assert.equal(typeof answer.json().error, "string");
    });
  });

  describe("the subscriptions to notices", () => {
    const KEY = "BPublicKeyOfTheDeployment";
    const keys = () => {
      const ecdh = createECDH("prime256v1");
      ecdh.generateKeys();
      return { p256dh: ecdh.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 1).toString("base64url") };
    };
    const subscribe = (env: Awaited<ReturnType<typeof setup>>, cookie: string | undefined, body: unknown) =>
      env.call("/api/push/subscriptions", cookie, { method: "POST", json: body });

    it("tells the UI the VAPID public key, or that there is no Web Push", async (t) => {
      const on = await setup(t, { pushKey: KEY });
      assert.deepEqual((await on.call("/api/push", on.signIn())).json(), { web_push: { public_key: KEY } });
      const off = await setup(t);
      const answer = await off.call("/api/push", off.signIn());
      assert.equal(answer.status, 200);
      assert.deepEqual(answer.json(), {});
    });

    it("registers and removes a browser's subscription for the owner's session only", async (t) => {
      const env = await setup(t, { pushKey: KEY });
      const subscription = { kind: "web-push", endpoint: "https://push.example.com/send/1", keys: keys() };
      assert.equal((await subscribe(env, undefined, subscription)).status, 401);
      assert.equal(env.subscriptions.all().length, 0);

      const cookie = env.signIn();
      assert.equal((await subscribe(env, cookie, subscription)).status, 204);
      // The same browser again replaces what it had.
      assert.equal((await subscribe(env, cookie, { ...subscription, keys: keys() })).status, 204);
      assert.equal((await subscribe(env, cookie, { ...subscription, endpoint: "https://push.example.com/send/2" })).status, 204);
      assert.deepEqual(
        env.subscriptions.all().map((s) => s.endpoint),
        ["https://push.example.com/send/1", "https://push.example.com/send/2"],
      );

      const remove = (who: string | undefined) =>
        env.call("/api/push/subscriptions/delete", who, { method: "POST", json: { endpoint: "https://push.example.com/send/1" } });
      assert.equal((await remove(undefined)).status, 401);
      assert.equal((await remove(cookie)).status, 204);
      // Removing what is not there is the same answer.
      assert.equal((await remove(cookie)).status, 204);
      assert.deepEqual(
        env.subscriptions.all().map((s) => s.endpoint),
        ["https://push.example.com/send/2"],
      );
    });

    it("refuses a subscription it could not send to", async (t) => {
      const env = await setup(t, { pushKey: KEY });
      const cookie = env.signIn();
      for (const body of [
        { kind: "web-push", endpoint: "http://push.example.com/send/1", keys: keys() },
        { kind: "web-push", endpoint: "https://push.example.com/send/1", keys: { p256dh: "AAAA", auth: "AAAA" } },
        { kind: "apns", endpoint: "https://push.example.com/send/1", keys: keys() },
        "not an object",
      ]) {
        const answer = await subscribe(env, cookie, body);
        assert.equal(answer.status, 400, JSON.stringify(body));
        assert.equal(typeof answer.json().error, "string");
      }
      assert.equal((await env.call("/api/push/subscriptions/delete", cookie, { method: "POST", json: { endpoint: 1 } })).status, 400);
      assert.equal(env.subscriptions.all().length, 0);
    });

    it("takes no subscription when there is no Web Push", async (t) => {
      const env = await setup(t);
      const answer = await subscribe(env, env.signIn(), { kind: "web-push", endpoint: "https://push.example.com/send/1", keys: keys() });
      assert.equal(answer.status, 503);
      assert.equal(answer.json().error, "web-push-not-configured");
    });
  });
});
