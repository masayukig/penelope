export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ModelSelection {
  /** Pi's provider and model ID, separated at the first slash. */
  model: string;
  thinking: ThinkingLevel;
}

export interface AvailableModel {
  provider: string;
  id: string;
  name: string;
  context_window: number;
  thinking_levels: ThinkingLevel[];
}

export interface ModelCatalog {
  models: AvailableModel[];
  default: ModelSelection | null;
}

/** Sandbox reports a catalog; backend returns only the owner's saved setting. */
export interface ModelSelectionResponse {
  selection: ModelSelection | null;
}

export interface SettingsResponse extends ModelCatalog, ModelSelectionResponse {}

export function modelRef(model: Pick<AvailableModel, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}
