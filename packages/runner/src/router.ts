// A virtual model, router/auto, that sends each fresh request to a primary
// model while its subscription has room, and to a fallback model when it does
// not. The room is read from Prometheus as a percentage used; the switch has a
// hysteresis (to the fallback at `high`, back below `low`). Set by
// PENELOPE_MODEL_ROUTER (docs/model-router.md); without it nothing is registered.

import type { Api, AssistantMessage, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRouteRequest, ModelRuntime } from "@earendil-works/pi-coding-agent";


export const ROUTER_PROVIDER = "router";
export const ROUTER_MODEL = "auto";

export interface RouterConfig {
  primary: { provider: string; id: string };
  fallback: { provider: string; id: string };
  /** Prometheus' base URL. */
  prometheus: string;
  /** An instant query whose largest value is the percentage of the primary's limit used. Empty, the reading is unknown. */
  query: string;
  high: number;
  low: number;
  /** How long one reading is used. */
  cacheSeconds: number;
}

const THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** Errors that say the primary's subscription has no room now; a retry on the same model would fail again. */
const USAGE_LIMIT = /usage.?limit|(?<![a-z0-9])429(?![a-z0-9])|rate.?limit|too many requests/i;

/** Whether to be on the fallback after a reading; an unknown reading keeps where it is. */
export function decide(onFallback: boolean, used: number | undefined, high: number, low: number): boolean {
  if (used === undefined) return onFallback;
  return onFallback ? used >= low : used >= high;
}

type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class ModelRouter {
  /**
   * Until the first reading, the fallback: when Prometheus cannot be read the
   * primary's room is not known, and a request to a full primary fails.
   */
  onFallback = true;
  private readAt = -Infinity;
  /** After a usage-limit failure, the fallback holds at least this long, whatever the readings say. */
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
      name: `Auto (${this.name("primary")} / ${this.name("fallback")})`,
      thinkingLevels: THINKING_LEVELS,
      route: (request) => this.route(request),
    });
  }

  async route(request: ModelRouteRequest): Promise<{ model: Model<Api>; thinkingLevel: ModelThinkingLevel }> {
    // Tool follow-ups and retries stay on the model that answered, which keeps the prompt cache,
    // unless that was the primary and its limit has been hit.
    const sticky = request.reason === "retry" ? (request.failed ?? request.previous) : request.reason === "continuation" ? request.previous : undefined;
    if (request.failed && this.failedOver(request.failed.message)) return this.to("fallback", request.thinkingLevel);
    if (sticky && !(this.held() && this.isPrimary(sticky.model.provider, sticky.model.id))) {
      return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? request.thinkingLevel };
    }
    await this.refresh();
    return this.to(this.onFallback ? "fallback" : "primary", request.thinkingLevel);
  }

  /**
   * Whether a failed answer was the primary saying its limit is reached. If so,
   * the router goes to the fallback and holds there, and a retry goes there too.
   */
  failedOver(message: AssistantMessage): boolean {
    if (message.stopReason !== "error" || !this.isPrimary(message.provider, message.model)) return false;
    if (!USAGE_LIMIT.test(message.errorMessage ?? "")) return false;
    if (!this.onFallback) this.log(`model router: ${this.name("primary")} hit its limit; to ${this.name("fallback")}`);
    this.onFallback = true;
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
    const next = decide(this.onFallback, used, this.config.high, this.config.low);
    if (next !== this.onFallback) this.log(`model router: ${used}% used; to ${this.name(next ? "fallback" : "primary")}`);
    this.onFallback = next;
  }

  private to(which: "primary" | "fallback", thinkingLevel: ModelThinkingLevel): { model: Model<Api>; thinkingLevel: ModelThinkingLevel } {
    const { provider, id } = this.config[which];
    const model = this.runtime.getModel(provider, id);
    if (!model) throw new Error(`model router: Pi has no model ${provider}/${id}`);
    return { model, thinkingLevel };
  }

  private isPrimary(provider: string, id: string): boolean {
    return provider === this.config.primary.provider && id === this.config.primary.id;
  }

  private name(which: "primary" | "fallback"): string {
    return `${this.config[which].provider}/${this.config[which].id}`;
  }
}
