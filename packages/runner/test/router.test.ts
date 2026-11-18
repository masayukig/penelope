import assert from "node:assert/strict";
import { test } from "node:test";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelRouteRequest, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { TurnEndRequest } from "@penelope/contract";

import { ConfigError, readConfig } from "../src/config.ts";
import { decide, ModelRouter, type RouterConfig } from "../src/router.ts";
import { until } from "./fake-backend.ts";
import { BACKUP, MODEL } from "./fake-model.ts";
import { acked, ui, world } from "./world.ts";

const CONFIG: RouterConfig = {
  primary: { provider: "openai", id: "gpt" },
  fallback: { provider: "anthropic", id: "claude" },
  prometheus: "http://prometheus:9090",
  query: "used",
  high: 85,
  low: 70,
  cacheSeconds: 300,
};

/** A router over a catalog that has every model, reading `used` (a number, or a failure). */
function router(used: () => number | Error | undefined) {
  const logs: string[] = [];
  const clock = { now: 0 };
  const runtime = { getModel: (provider: string, id: string) => ({ provider, id }) } as unknown as ModelRuntime;
  let reads = 0;
  const r = new ModelRouter(
    CONFIG,
    runtime,
    (line) => logs.push(line),
    async () => {
      reads++;
      const value = used();
      if (value instanceof Error) throw value;
      return { ok: true, status: 200, json: async () => ({ data: { result: value === undefined ? [] : [{ value: [0, String(value)] }] } }) };
    },
    () => clock.now,
  );
  return { r, logs, clock, reads: () => reads };
}

const request = (reason: ModelRouteRequest["reason"], extra: Partial<ModelRouteRequest> = {}): ModelRouteRequest =>
  ({ model: { provider: "router", id: "auto" }, thinkingLevel: "medium", reason, messages: [], ...extra }) as ModelRouteRequest;

const failure = (provider: string, model: string, errorMessage: string) =>
  ({ role: "assistant", provider, model, stopReason: "error", errorMessage }) as AssistantMessage;

const routed = async (r: ModelRouter, req: ModelRouteRequest) => {
  const { model } = await r.route(req);
  return `${model.provider}/${model.id}`;
};

test("the switch has a hysteresis", () => {
  assert.equal(decide(false, 84, 85, 70), false);
  assert.equal(decide(false, 85, 85, 70), true);
  assert.equal(decide(true, 75, 85, 70), true); // in between, it stays
  assert.equal(decide(true, 69, 85, 70), false);
  assert.equal(decide(true, undefined, 85, 70), true); // unknown keeps where it is
  assert.equal(decide(false, undefined, 85, 70), false);
});

test("a fresh request goes by the reading, which is cached", async () => {
  let used: number | Error | undefined = 10;
  const { r, clock, reads } = router(() => used);
  assert.equal(await routed(r, request("user")), "openai/gpt");
  used = 90;
  assert.equal(await routed(r, request("user")), "openai/gpt"); // the cached reading
  assert.equal(reads(), 1);
  clock.now = 301_000;
  assert.equal(await routed(r, request("user")), "anthropic/claude");
  used = 75;
  clock.now = 602_000;
  assert.equal(await routed(r, request("user")), "anthropic/claude");
  used = 60;
  clock.now = 903_000;
  assert.equal(await routed(r, request("user")), "openai/gpt");
});

test("until Prometheus is read, the fallback; when it cannot be read, the last decision stays", async () => {
  let used: number | Error | undefined = new Error("fetch failed");
  const { r, clock, logs } = router(() => used);
  assert.equal(await routed(r, request("user")), "anthropic/claude");
  assert.match(logs.join("\n"), /Prometheus not read \(fetch failed\)/);
  used = 10;
  clock.now = 301_000;
  assert.equal(await routed(r, request("user")), "openai/gpt");
  used = undefined; // an empty result, as when the usage is stale
  clock.now = 602_000;
  assert.equal(await routed(r, request("user")), "openai/gpt");
});

test("tool follow-ups and retries stay on the model that answered", async () => {
  const { r } = router(() => 99);
  const previous = { model: { provider: "openai", id: "gpt" }, thinkingLevel: "high" } as ModelRouteRequest["previous"];
  assert.equal(await routed(r, request("continuation", { previous })), "openai/gpt");
  const failed = { ...previous!, message: failure("openai", "gpt", "overloaded") };
  assert.equal(await routed(r, request("retry", { failed })), "openai/gpt");
});

test("a usage limit of the primary sends the request and the next ones to the fallback, and holds", async () => {
  const { r, clock } = router(() => 10);
  assert.equal(await routed(r, request("user")), "openai/gpt");
  clock.now = 200_000; // the limit is hit within the first reading's time
  const message = failure("openai", "gpt", "The ChatGPT user has reached their Subscription Sharing usage limit");
  assert.equal(await routed(r, request("retry", { failed: { model: { provider: "openai", id: "gpt" } as never, message } })), "anthropic/claude");
  const previous = { model: { provider: "openai", id: "gpt" } } as ModelRouteRequest["previous"];
  assert.equal(await routed(r, request("continuation", { previous })), "anthropic/claude");
  clock.now = 301_000; // the reading still says 10%, but the hold is not over
  assert.equal(await routed(r, request("user")), "anthropic/claude");
  clock.now = 602_000;
  assert.equal(await routed(r, request("user")), "openai/gpt");
});

test("only the primary's limit errors fail over", () => {
  const { r } = router(() => 10);
  assert.equal(r.failedOver(failure("anthropic", "claude", "429 too many requests")), false);
  assert.equal(r.failedOver(failure("openai", "gpt", "invalid request")), false);
  assert.equal(r.failedOver(failure("openai", "gpt", "subscription_sharing_usage_limit_exceeded")), true);
  assert.equal(r.failedOver(failure("openai", "gpt", "insufficient_quota")), true);
});

test("a throttle of the primary is left to Pi's own retry", () => {
  const { r } = router(() => 10);
  // pi-ai's utils/retry.js retries these on the same model; only an exhausted limit fails over.
  for (const message of ["429 Too Many Requests", "rate limit reached, try again in 2s", "too many requests"]) {
    assert.equal(r.failedOver(failure("openai", "gpt", message)), false, message);
  }
  assert.equal(r.onFallback, true); // untouched: still the first decision
});

test("PENELOPE_MODEL_ROUTER is read as JSON, with defaults", () => {
  const env = {
    HOME: "/home/agent",
    PENELOPE_BACKEND_URL: "http://backend",
    PENELOPE_BACKEND_TOKEN: "t",
    PENELOPE_NAME: "n",
    PENELOPE_ROLE: "r",
    PENELOPE_OWNER: "o",
  };
  assert.equal(readConfig(env).router, undefined);
  const value = JSON.stringify({ primary: "openai/gpt", fallback: "anthropic/claude", prometheus: "http://prometheus:9090", query: "used" });
  const routed = { ...env, PENELOPE_MODEL: "router/auto" };
  assert.deepEqual(readConfig({ ...routed, PENELOPE_MODEL_ROUTER: value }).router, CONFIG);
  assert.throws(() => readConfig({ ...routed, PENELOPE_MODEL_ROUTER: '{"primary":"openai/gpt"}' }), ConfigError);
  assert.throws(() => readConfig({ ...routed, PENELOPE_MODEL_ROUTER: "openai/gpt" }), ConfigError);
  for (const json of ["null", "[]", "1"]) assert.throws(() => readConfig({ ...routed, PENELOPE_MODEL_ROUTER: json }), ConfigError, json);
  // Only finite JSON numbers and an http(s) URL with a host.
  const base = JSON.parse(value) as Record<string, unknown>;
  for (const bad of [{ low: null }, { high: "90" }, { cacheSeconds: "Infinity" }, { prometheus: "http://" }, { prometheus: "ftp://prometheus" }]) {
    const json = JSON.stringify({ ...base, ...bad });
    assert.throws(() => readConfig({ ...routed, PENELOPE_MODEL_ROUTER: json }), ConfigError, json);
  }
  // One without the other is refused at start, not found out at the first request.
  assert.throws(() => readConfig(routed), ConfigError);
  assert.throws(() => readConfig({ ...env, PENELOPE_MODEL: "openai/gpt", PENELOPE_MODEL_ROUTER: value }), ConfigError);
});

test("a turn that hits the primary's limit is logged and goes on once on the fallback", async () => {
  const { fake, start, calls, logs } = await world({ routerUsed: 10, turnFold: false });
  await start((call) =>
    call.model === MODEL ? { error: "The ChatGPT user has reached their Subscription Sharing usage limit" } : { text: "from the fallback" },
  );
  fake.push(ui(1, "hello"));
  await until(() => acked(fake).includes(1));
  assert.deepEqual(
    calls.map((c) => c.model),
    [MODEL, BACKUP],
  );
  assert.match(logs.join("\n"), /fake\/scripted failed: .*usage limit/);
  assert.match(logs.join("\n"), /tried once more on another model/);
});

test("without the router, a model error is logged and the turn ends as before", async () => {
  const { fake, start, calls, logs } = await world({ turnFold: false });
  await start(() => ({ error: "usage limit" }));
  fake.push(ui(1, "hello"));
  await until(() => acked(fake).includes(1));
  assert.equal(calls.length, 1);
  assert.match(logs.join("\n"), /fake\/scripted failed: usage limit/);
});

test("a turn that went on on the fallback ends as done; one whose fallback fails too, as failed", async () => {
  for (const [fallback, result] of [[{ text: "from the fallback" }, "done"], [{ error: "the fallback is away" }, "failed"]] as const) {
    const { fake, start } = await world({ routerUsed: 10, turnFold: false });
    await start((call) => (call.model === MODEL ? { error: "subscription_sharing_usage_limit_exceeded" } : fallback));
    fake.push(ui(1, "hello"));
    await until(() => fake.sent("POST", "/v1/turns/end").length === 1);
    const [end] = fake.sent("POST", "/v1/turns/end") as TurnEndRequest[];
    assert.equal(end!.result, result);
  }
});

test("an event that comes while the turn goes on on the fallback is run in the same turn", async () => {
  const { fake, start, calls } = await world({ routerUsed: 10, turnFold: false });
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await start(async (call) => {
    if (call.model === MODEL) return { error: "subscription_sharing_usage_limit_exceeded" };
    if (!call.userTexts.some((text) => text.includes("and this"))) await held;
    return { text: "from the fallback" };
  });
  fake.push(ui(1, "hello"));
  await until(() => calls.some((c) => c.model === BACKUP));
  fake.push(ui(2, "and this"));
  await until(() => fake.polledAfter(2));
  release();
  await until(() => acked(fake).includes(2));
  // Guards against: the event acked but never shown to a model, or sent to the failing primary.
  const after = calls.filter((c) => c.userTexts.some((text) => text.includes("and this")));
  assert.ok(after.length > 0);
  assert.ok(after.every((c) => c.model === BACKUP));
  assert.deepEqual((fake.sent("POST", "/v1/turns/end") as TurnEndRequest[]).map((end) => end.seqs), [[1, 2]]);
});
