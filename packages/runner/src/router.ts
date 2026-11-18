// A virtual model, router/auto, over an ordered list of models. Each fresh
// request goes to the first model while its subscription has room, and down
// the list when it does not. The first model's room is read from Prometheus as
// a percentage used; the switch has a hysteresis (down at `high`, back to the
// first below `low`). The later models have no reading: the router moves past
// one only when it answers with a usage limit or an authorization failure.
// Set by PENELOPE_MODEL_ROUTER (docs/model-router.md); without it nothing is
// registered.

import type { Api, AssistantMessage, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRouteRequest, ModelRuntime } from "@earendil-works/pi-coding-agent";

export const ROUTER_PROVIDER = "router";
export const ROUTER_MODEL = "auto";

/** The note that asks the model to go on after a failed request was retried on another model. */
export const MODEL_RETRY = {
  customType: "penelope.model_retry",
  content: "(The model request failed and is being retried on another model. Go on with the turn.)",
  display: false,
};

export interface RouterConfig {
  /** In order of preference; the first is the one whose usage is read. At least two. */
  models: { provider: string; id: string }[];
  /** Prometheus' base URL. */
  prometheus: string;
  /** An instant query whose largest value is the percentage of the first model's limit used. Empty, the reading is unknown. */
  query: string;
  high: number;
  low: number;
  /** How long one reading is used. */
  cacheSeconds: number;
}

const THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/**
 * Errors that say a model cannot be used now: its subscription or quota is used
 * up (the provider limits pi-ai does not retry, NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN
 * in its utils/retry.js), or its credential is refused or missing (a relay without
 * a login answers "no access token"; the Grok sidecar hands a fake token to force
 * a 401 here). A retry on the same model would fail again. A 429, "too many
 * requests" or "rate limit" alone is a throttle that Pi retries on the same
 * model, and does not move the router.
 */
const UNUSABLE = new RegExp(
  [
    "usage.?limit",
    "available balance",
    "insufficient_quota",
    "out of budget",
    "quota exceeded",
    "billing",
    '"code"\\s*:\\s*"?1308(?![0-9])',
    "(?<![a-z0-9])(?:403|401)(?![a-z0-9])",
    "forbidden",
    "unauthori[sz]ed",
    "authentication",
    "no access token",
    "access token has expired",
  ].join("|"),
  "i",
);

/** Whether to be off the first model after a reading; an unknown reading keeps where it is. */
export function decide(onFallback: boolean, used: number | undefined, high: number, low: number): boolean {
  if (used === undefined) return onFallback;
  return onFallback ? used >= low : used >= high;
}

type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class ModelRouter {
  /**
   * The index of the model fresh requests go to. Until the first reading, the
   * second: when Prometheus cannot be read the first's room is not known, and a
   * request to a full first model fails.
   */
  tier = 1;
  private readAt = -Infinity;
  /** After a failure, the router stays at least this long where it moved to, whatever the readings say. */
  private heldUntil = -Infinity;

  private readonly config: RouterConfig;
  private readonly runtime: ModelRuntime;
  private readonly log: (line: string) => void;
  private readonly fetch: Fetch;
  private readonly now: () => number;

  constructor(config: RouterConfig, runtime: ModelRuntime, log: (line: string) => void, fetch: Fetch = globalThis.fetch, now: () => number = Date.now) {
    this.config = config;
    this.runtime = runtime;
    this.log = log;
    this.fetch = fetch;
    this.now = now;
  }

  register(): void {
    this.runtime.registerVirtualModel({
      provider: ROUTER_PROVIDER,
      id: ROUTER_MODEL,
      name: `Auto (${this.config.models.map((_, i) => this.name(i)).join(" / ")})`,
      thinkingLevels: THINKING_LEVELS,
      route: (request) => this.route(request),
    });
  }

  async route(request: ModelRouteRequest): Promise<{ model: Model<Api>; thinkingLevel: ModelThinkingLevel }> {
    // Tool follow-ups and retries stay on the model that answered, which keeps the prompt cache,
    // unless a failure moved the router past that model.
    const sticky = request.reason === "retry" ? (request.failed ?? request.previous) : request.reason === "continuation" ? request.previous : undefined;
    if (request.failed && this.failedOver(request.failed.message)) return this.to(this.tier, request.thinkingLevel);
    if (sticky && !(this.held() && this.isPassed(sticky.model.provider, sticky.model.id))) {
      return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? request.thinkingLevel };
    }
    await this.refresh();
    return this.to(this.tier, request.thinkingLevel);
  }

  /**
   * Whether a failed answer was one of the models saying it cannot be used now.
   * If so, the router moves past it, to the next model, and holds there; a retry
   * goes there too. The last model failing has nowhere to go.
   */
  failedOver(message: AssistantMessage): boolean {
    if (message.stopReason !== "error") return false;
    const index = this.indexOf(message.provider, message.model);
    if (index < 0 || !UNUSABLE.test(message.errorMessage ?? "")) return false;
    const next = Math.max(this.tier, index + 1);
    if (next >= this.config.models.length) {
      this.log(`model router: ${this.name(index)} cannot be used and there is no model after it`);
      return false;
    }
    if (next !== this.tier) this.log(`model router: ${this.name(index)} cannot be used; to ${this.name(next)}`);
    this.tier = next;
    this.heldUntil = this.now() + this.config.cacheSeconds * 1000;
    return true;
  }

  private held(): boolean {
    return this.now() < this.heldUntil;
  }

  private async refresh(): Promise<void> {
    if (this.now() - this.readAt < this.config.cacheSeconds * 1000) return;
    this.readAt = this.now();
    let used: number | undefined;
    try {
      const url = `${this.config.prometheus.replace(/\/$/, "")}/api/v1/query?query=${encodeURIComponent(this.config.query)}`;
      const response = await this.fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`http ${response.status}`);
      const body = (await response.json()) as { data?: { result?: { value: [number, string] }[] } };
      const values = (body.data?.result ?? []).map((series) => Number(series.value[1])).filter(Number.isFinite);
      if (values.length > 0) used = Math.max(...values);
      else this.log("model router: the usage query returned nothing; no change");
    } catch (error) {
      this.log(`model router: Prometheus not read (${(error as Error).message}); no change`);
    }
    if (this.held()) return;
    // The reading is of the first model only: it decides between the first and the rest.
    // Off the first, the router stays on whichever later model it is on.
    const off = decide(this.tier > 0, used, this.config.high, this.config.low);
    const next = off ? Math.max(this.tier, 1) : 0;
    if (next !== this.tier) this.log(`model router: ${used}% used; to ${this.name(next)}`);
    this.tier = next;
  }

  private to(index: number, thinkingLevel: ModelThinkingLevel): { model: Model<Api>; thinkingLevel: ModelThinkingLevel } {
    const { provider, id } = this.config.models[index]!;
    const model = this.runtime.getModel(provider, id);
    if (!model) throw new Error(`model router: Pi has no model ${provider}/${id}`);
    return { model, thinkingLevel };
  }

  private indexOf(provider: string, id: string): number {
    return this.config.models.findIndex((m) => m.provider === provider && m.id === id);
  }

  /** Whether the router has moved past this model of the list. */
  private isPassed(provider: string, id: string): boolean {
    const index = this.indexOf(provider, id);
    return index >= 0 && index < this.tier;
  }

  private name(index: number): string {
    return `${this.config.models[index]!.provider}/${this.config.models[index]!.id}`;
  }
}
