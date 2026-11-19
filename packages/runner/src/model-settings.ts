import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { modelRef, type ModelSelection, type ThinkingLevel } from "@penelope/contract";

import type { Backend } from "./backend.ts";

type Default = { model: Model<Api> | undefined; thinking: ThinkingLevel };
const current = (session: AgentSession): Default => ({ model: session.model, thinking: session.thinkingLevel });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** One deployment setting, sampled once before each turn, including the night and sub-agents. */
export class TurnModels {
  private selection: ModelSelection | null = null;
  private defaults = new WeakMap<AgentSession, Default>();
  private mainDefault: Default | undefined;

  private readonly runtime: ModelRuntime;
  private readonly backend: Backend;
  private readonly log: (line: string) => void;

  constructor(runtime: ModelRuntime, backend: Backend, log: (line: string) => void) {
    this.runtime = runtime;
    this.backend = backend;
    this.log = log;
  }

  remember(session: AgentSession, main = false): void {
    const fallback = current(session);
    this.defaults.set(session, fallback);
    if (main) this.mainDefault = fallback;
  }

  /** Also refresh when idle, so the UI has a catalog before the first turn and after a backend restart. */
  async report(stop?: AbortSignal): Promise<ModelSelection | null> {
    const timeout = AbortSignal.timeout(5_000);
    const signal = stop ? AbortSignal.any([timeout, stop]) : timeout;
    try {
      const models = await this.runtime.getAvailable(undefined, { signal });
      const fallback = this.mainDefault;
      const { selection } = await this.backend.reportModels({
        models: models.map((model) => ({
          provider: model.provider,
          id: model.id,
          name: model.name,
          context_window: model.contextWindow,
          thinking_levels: getSupportedThinkingLevels(model),
        })),
        default: fallback?.model ? { model: modelRef(fallback.model), thinking: fallback.thinking } : null,
      }, signal);
      this.selection = selection;
    } catch (error) {
      if (!stop?.aborted) this.log(`model settings not refreshed: ${message(error)}`);
    }
    return this.selection;
  }

  async prepare(session: AgentSession, stop?: AbortSignal): Promise<void> {
    const selection = await this.report(stop);
    if (!selection || stop?.aborted) return;
    const available = this.runtime.getAvailableSnapshot();
    const model = available.find((entry) => modelRef(entry) === selection.model);
    if (model) {
      await this.switchTo(session, model, selection.thinking);
      return;
    }
    this.log(`saved model ${selection.model} is no longer available; using the session default`);
    const fallback = this.defaults.get(session);
    if (fallback?.model) {
      const ref = modelRef(fallback.model);
      const defaultModel = available.find((entry) => modelRef(entry) === ref);
      if (defaultModel) await this.switchTo(session, defaultModel, fallback.thinking);
    }
  }

  private async switchTo(session: AgentSession, model: Model<Api>, thinking: ThinkingLevel): Promise<void> {
    const previous = session.model;
    if (!previous || modelRef(previous) !== modelRef(model)) {
      const tokens = session.getContextUsage()?.tokens;
      if (previous && model.contextWindow < previous.contextWindow && tokens != null && tokens > model.contextWindow - model.maxTokens) {
        try {
          // The old model is more likely to fit the history for the summary. Its quota
          // might be the reason for switching, so compaction failure must not block it.
          await session.compact();
        } catch (error) {
          this.log(`could not compact before switching to ${modelRef(model)}: ${message(error)}`);
        }
      }
      await session.setModel(model);
    }
    session.setThinkingLevel(thinking);
  }
}
