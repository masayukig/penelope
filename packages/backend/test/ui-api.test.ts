import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { Conversation } from "../src/conversation.ts";
import { openDatabase } from "../src/db.ts";
import { Feed } from "../src/feed.ts";
import { close, listenTcp } from "../src/http.ts";
import { GitHubLogin, type GitHubSettings } from "../src/login/github.ts";
import { LoginSessions } from "../src/login/sessions.ts";
import { Queue } from "../src/queue.ts";
import { Sources } from "../src/sources.ts";
import { AwakeHours } from "../src/time.ts";
import { uiHandler } from "../src/ui-api.ts";
import { ask, type Ask, multipart, SseReader, tempDir } from "./support.ts";

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
    agent = { name: "Iris", iconFile: undefined as string | undefined },
  } = {},
) {
  const dir = tempDir(t);
  const db = openDatabase(path.join(dir, "backend.sqlite"));
  const sourcesDir = path.join(dir, "sources");
  const queue = new Queue(db, new Sources(sourcesDir, "UTC"), {
    now: Date.now,
    inline: new Set(["ui", "control"]),
    builtinDelivery: { ui: "now" },
    batch: { quietMs: 300_000, maxMs: 1_800_000 },
    awake: new AwakeHours("00:00-00:00", "UTC"),
    redeliverMs: 300_000,
  });
  const feed = new Feed();
  const conversation = new Conversation(db, feed, { now: Date.now });
  const github = await fakeGitHub(t);
  const sessions = new LoginSessions(db, { now: Date.now });
  const settings: GitHubSettings | undefined = configured
    ? { clientId: "client", clientSecret: "secret", ownerId: OWNER, callbackUrl: `${publicUrl}/auth/github/callback` }
    : undefined;
  const login = new GitHubLogin({ settings, endpoints: github.endpoints, sessions, now: Date.now, log: () => {} });
  const server = await listenTcp(
    uiHandler({ queue, conversation, feed, login, sessions, ownerId: settings?.ownerId, publicUrl, agent, now: Date.now }),
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
  return { queue, conversation, feed, sessions, github, target, signIn, call, sourcesDir };
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
    assert.match(location.searchParams.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
    assert.match(location.searchParams.get("state") ?? "", /^[A-Za-z0-9_-]{43}$/);
    assert.equal(location.searchParams.get("allow_signup"), "false");
  });

  it("lets the owner in with a session cookie and goes back to the top", async (t) => {
    const env = await setup(t);
    const callback = await logIn(env);
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.location, "/");
    const [cookie] = callback.headers["set-cookie"] ?? [];
    assert.match(cookie ?? "", /^penelope_session=[A-Za-z0-9_-]{43}; Path=\/; Expires=.*; Max-Age=2592000; HttpOnly; SameSite=Strict$/);
    const session = cookie!.split(";")[0]!;
    assert.equal((await env.call("/api/history", session)).status, 200);
  });

  it("marks the cookie Secure when the backend is served over https", async (t) => {
    const env = await setup(t, { publicUrl: "https://penelope.example.com" });
    const [cookie] = (await logIn(env)).headers["set-cookie"] ?? [];
    assert.match(cookie ?? "", /; Secure; SameSite=Strict$/);
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

  it("answers 403 when the owner declined at GitHub", async (t) => {
    const env = await setup(t);
    const start = await env.call("/auth/github/start", undefined);
    const state = new URL(String(start.headers.location)).searchParams.get("state");
    const callback = await env.call(`/auth/github/callback?error=access_denied&state=${state}`, undefined);
    assert.equal(callback.status, 403);
    assert.equal(callback.json().error, "github-denied");
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
    assert.match(out.headers["set-cookie"]?.[0] ?? "", /^penelope_session=; Path=\/; .*Max-Age=0/);
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
      const env = await setup(t, { agent: { name: "Iris", iconFile: undefined } });
      const answer = await env.call("/api/agent", undefined);
      assert.equal(answer.status, 200);
      assert.deepEqual(answer.json(), { name: "Iris" });
      assert.equal((await env.call("/api/agent/icon", undefined)).status, 404);
    });

    it("serves the icon the settings point to, without a session", async (t) => {
      const dir = tempDir(t);
      const iconFile = path.join(dir, "face.png");
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      writeFileSync(iconFile, png);
      const env = await setup(t, { agent: { name: "Iris", iconFile } });
      const agent = (await env.call("/api/agent", undefined)).json();
      assert.equal(agent.name, "Iris");
      const icon = await env.call(agent.icon, undefined);
      assert.equal(icon.status, 200);
      assert.equal(icon.headers["content-type"], "image/png");
      assert.equal(icon.text, png.toString("utf8"));
    });

    it("gives nothing else away without a session", async (t) => {
      const env = await setup(t);
      assert.equal((await env.call("/api/agent/other", undefined)).status, 401);
    });
  });

  it("answers the health check without a session", async (t) => {
    const env = await setup(t);
    assert.equal((await env.call("/healthz", undefined)).status, 200);
  });

  it("has nothing else to serve until the Web UI is built", async (t) => {
    const env = await setup(t);
    assert.equal((await env.call("/", undefined)).status, 404);
    assert.equal((await env.call("/api/nothing", env.signIn())).status, 404);
  });
});
