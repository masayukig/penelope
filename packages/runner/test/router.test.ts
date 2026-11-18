import assert from "node:assert/strict";
import { test } from "node:test";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelRouteRequest, ModelRuntime } from "@earendil-works/pi-coding-agent";

import { ConfigError, readConfig } from "../src/config.ts";
import { decide, ModelRouter, type RouterConfig } from "../src/router.ts";
import { until } from "./fake-backend.ts";
import { BACKUP, MODEL, SPARE } from "./fake-model.ts";
import { acked, ui, world } from "./world.ts";

const CONFIG: RouterConfig = {
  models: [
    { provider: "openai", id: "gpt" },
    { provider: "anthropic", id: "claude" },
  ],
  prometheus: "http://prometheus:9090",
  query: "used",
  high: 85,
  low: 70,
  cacheSeconds: 300,
};

/** The chain ChatGPT → Grok → Anthropic. */
const CHAIN: RouterConfig = {
  ...CONFIG,
  models: [
    { provider: "openai", id: "gpt" },
    { provider: "xai", id: "grok" },
    { provider: "anthropic", id: "claude" },
  ],
};

/** A router over a catalog that has every model, reading `used` (a number, or a failure). */
function router(used: () => number | Error | undefined, config: RouterConfig = CONFIG) {
  const logs: string[] = [];
  const clock = { now: 0 };
  const runtime = { getModel: (provider: string, id: string) => ({ provider, id }) } as unknown as ModelRuntime;
  let reads = 0;
  const r = new ModelRouter(
    config,
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

test("the switch has a hysteresis, as route-switcher's", () => {
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
  assert.deepEqual(readConfig({ ...env, PENELOPE_MODEL_ROUTER: value }).router, CONFIG);
  assert.throws(() => readConfig({ ...env, PENELOPE_MODEL_ROUTER: '{"primary":"openai/gpt"}' }), ConfigError);
  const chain = JSON.stringify({ models: ["openai/gpt", "xai/grok", "anthropic/claude"], prometheus: "http://prometheus:9090", query: "used" });
  assert.deepEqual(readConfig({ ...env, PENELOPE_MODEL_ROUTER: chain }).router, CHAIN);
  const one = JSON.stringify({ models: ["openai/gpt"], prometheus: "http://prometheus:9090", query: "used" });
  assert.throws(() => readConfig({ ...env, PENELOPE_MODEL_ROUTER: one }), ConfigError);
  assert.throws(() => readConfig({ ...env, PENELOPE_MODEL_ROUTER: "openai/gpt" }), ConfigError);
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

test("in a chain, a high reading moves to the second model, and a low one back to the first", async () => {
  let used = 90;
  const { r, clock } = router(() => used, CHAIN);
  assert.equal(await routed(r, request("user")), "xai/grok");
  used = 10;
  clock.now = 301_000;
  assert.equal(await routed(r, request("user")), "openai/gpt");
});

test("in a chain, a later model is passed only when it fails, and the first comes back with a low reading", async () => {
  let used = 90;
  const { r, clock, logs } = router(() => used, CHAIN);
  assert.equal(await routed(r, request("user")), "xai/grok");
  // Grok has no reading; an ordinary error keeps it, a refusal of its credential passes it.
  assert.equal(r.failedOver(failure("xai", "grok", "500 internal error")), false);
  clock.now = 100_000;
  const refused = failure("xai", "grok", "403 Forbidden");
  assert.equal(await routed(r, request("retry", { failed: { model: { provider: "xai", id: "grok" } as never, message: refused } })), "anthropic/claude");
  assert.match(logs.join("\n"), /xai\/grok cannot be used; to anthropic\/claude/);
  // A follow-up of Grok's does not go back to it while the hold lasts.
  const previous = { model: { provider: "xai", id: "grok" } } as ModelRouteRequest["previous"];
  assert.equal(await routed(r, request("continuation", { previous })), "anthropic/claude");
  // The hold is over but the first is still high: the router stays on the third, not back to Grok.
  clock.now = 401_000;
  assert.equal(await routed(r, request("user")), "anthropic/claude");
  used = 60;
  clock.now = 702_000;
  assert.equal(await routed(r, request("user")), "openai/gpt");
});

test("in a chain, the first model's limit goes to the second, and the last model's has nowhere to go", async () => {
  const { r } = router(() => 10, CHAIN);
  assert.equal(await routed(r, request("user")), "openai/gpt");
  assert.equal(r.failedOver(failure("openai", "gpt", "subscription_sharing_usage_limit_exceeded")), true);
  assert.equal(r.tier, 1);
  assert.equal(r.failedOver(failure("xai", "grok", "429 Too Many Requests")), true);
  assert.equal(r.tier, 2);
  assert.equal(r.failedOver(failure("anthropic", "claude", "429 rate limit")), false);
  assert.equal(r.tier, 2);
  // A late failure of the first, from a follow-up that stayed on it, does not move the router back up.
  assert.equal(r.failedOver(failure("openai", "gpt", "usage limit")), true);
  assert.equal(r.tier, 2);
});

test("a turn walks down the chain while each model refuses, and ends when one answers", async () => {
  const { fake, start, calls, logs } = await world({ routerUsed: 10, routerModels: [MODEL, BACKUP, SPARE], turnFold: false });
  await start((call) =>
    call.model === MODEL ? { error: "usage limit" } : call.model === BACKUP ? { error: "401 Unauthorized: no access token" } : { text: "from the spare" },
  );
  fake.push(ui(1, "hello"));
  await until(() => acked(fake).includes(1));
  assert.deepEqual(
    calls.map((c) => c.model),
    [MODEL, BACKUP, SPARE],
  );
  assert.equal(logs.filter((line) => line.includes("tried once more on another model")).length, 2);
});
