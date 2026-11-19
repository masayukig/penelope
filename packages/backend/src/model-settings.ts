import type { DatabaseSync } from "node:sqlite";

import { modelRef, THINKING_LEVELS, type AvailableModel, type ModelCatalog, type ModelSelection, type SettingsResponse, type ThinkingLevel } from "@penelope/contract";

import { HttpError } from "./http.ts";

// The runner refreshes its report while polling, even when there are no events.
const CATALOG_TTL_MS = 120_000;

function thinkingLevel(value: unknown): value is ThinkingLevel {
  return THINKING_LEVELS.some((level) => level === value);
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "expected an object");
  return value as Record<string, unknown>;
}

function selectionOf(value: unknown): ModelSelection {
  const { model, thinking } = object(value);
  if (typeof model !== "string" || !/^[^/]+\/.+$/u.test(model) || !thinkingLevel(thinking)) {
    throw new HttpError(400, "expected a provider/model and thinking level");
  }
  return { model, thinking };
}

function modelOf(value: unknown): AvailableModel {
  const { provider, id, name, context_window, thinking_levels } = object(value);
  if (typeof provider !== "string" || !provider || provider.includes("/") || typeof id !== "string" || !id ||
      typeof name !== "string" || typeof context_window !== "number" || !Number.isSafeInteger(context_window) || context_window <= 0 ||
      !Array.isArray(thinking_levels) || !thinking_levels.every(thinkingLevel)) {
    throw new HttpError(400, "invalid model in catalog");
  }
  return { provider, id, name, context_window, thinking_levels };
}

export class ModelSettings {
  private catalog: { value: ModelCatalog; at: number } | undefined;

  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  read(): SettingsResponse {
    const catalog = this.catalog && this.now() - this.catalog.at < CATALOG_TTL_MS ? this.catalog.value : { models: [], default: null };
    return { ...catalog, selection: this.selection() };
  }

  selection(): ModelSelection | null {
    return (this.db.prepare("SELECT model, thinking FROM model_settings WHERE singleton = 1").get() as ModelSelection | undefined) ?? null;
  }

  report(value: unknown): void {
    const { models, default: fallback } = object(value);
    if (!Array.isArray(models)) throw new HttpError(400, "models must be a list");
    this.catalog = { value: { models: models.map(modelOf), default: fallback === null ? null : selectionOf(fallback) }, at: this.now() };
  }

  save(value: unknown): SettingsResponse {
    const selection = selectionOf(value);
    const catalog = this.read();
    const model = catalog.models.find((entry) => modelRef(entry) === selection.model);
    if (!model) throw new HttpError(400, "the model is not available in the runner");
    if (!model.thinking_levels.includes(selection.thinking)) throw new HttpError(400, "the model does not support that thinking level");
    this.db.prepare(`INSERT INTO model_settings (singleton, model, thinking) VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET model = excluded.model, thinking = excluded.thinking`).run(selection.model, selection.thinking);
    return { ...catalog, selection };
  }
}
