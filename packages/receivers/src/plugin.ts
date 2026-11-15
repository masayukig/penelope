// The boundary between the receivers and a plugin (docs/receivers.md,
// "プラグインの内側の契約"). A plugin never touches the network or the intake:
// it checks its settings once at start, and turns one request into events.
import type { IncomingHttpHeaders } from "node:http";

import type { Event } from "@penelope/contract";

/** An event as a plugin makes it: every field of the envelope but `source`, which the receivers add. */
export type PluginEvent = Omit<Event, "source">;

/** What a webhook plugin is given of one request. */
export type WebhookRequest = {
  headers: IncomingHttpHeaders;
  body: Uint8Array;
  /** When the receivers took the request. */
  receivedAt: Date;
};

/**
 * A request refused (no event is made), or taken with the events it made,
 * how many things it dropped and lines for the log. `reason` and `notes` are
 * written to the log, so they never carry the body's content or a key.
 */
export type WebhookOutcome =
  | { kind: "refuse"; status: 400; reason: string }
  | { kind: "refuse"; status: 401 }
  | { kind: "accept"; events: PluginEvent[]; dropped: number; notes: string[] };

export type WebhookHandler = (request: WebhookRequest) => WebhookOutcome;

/** What a plugin may do at start: read the files its settings point at. */
export type PluginEnv = { readFile: (path: string) => string };

export type WebhookPlugin = {
  /** What the settings' `plugin` names. */
  name: string;
  kind: "webhook";
  /** Checks the settings and reads the keys; throws SettingsError if it cannot run with them. */
  create: (settings: Record<string, unknown>, env: PluginEnv) => WebhookHandler;
};

export type Plugin = WebhookPlugin;

/** A plugin's settings it cannot run with. The message starts with the field, `<field>: <why>`. */
export class SettingsError extends Error {
  readonly field: string;
  readonly why: string;

  constructor(field: string, why: string) {
    super(`${field}: ${why}`);
    this.name = "SettingsError";
    this.field = field;
    this.why = why;
  }
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Throws for the first field of `settings` that is not one of `known`. */
export function onlyKnown(settings: Record<string, unknown>, known: readonly string[]): void {
  for (const field of Object.keys(settings)) {
    if (!known.includes(field)) throw new SettingsError(field, "not a field of this plugin");
  }
}

/** The key in a file: what is left of its content without the white space around it. */
export function readKey(field: string, path: unknown, env: PluginEnv): string {
  if (typeof path !== "string" || path === "") throw new SettingsError(field, "the path of a file is required");
  let text: string;
  try {
    text = env.readFile(path);
  } catch (error) {
    throw new SettingsError(field, `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const key = text.trim();
  if (key === "") throw new SettingsError(field, `${path} is empty`);
  return key;
}
