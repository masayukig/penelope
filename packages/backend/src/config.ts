// The backend's settings, from environment variables (docs/backend.md).
// Secrets are read from files, named by the variables, so that their values
// never sit in the environment.
import type { Delivery } from "@penelope/contract";

import { cronOf } from "./schedules.ts";
import { AwakeHours } from "./time.ts";
import { CALLBACK_PATH, type GitHubSettings } from "./login/github.ts";

/** A setting that cannot be used. The backend does not start. */
export class ConfigError extends Error {}

export type Config = {
  databasePath: string;
  sourcesDir: string;
  memoryDir: string;
  intakeSocket: string;
  sandboxSocket: string;
  listen: { host: string; port: number };
  publicUrl: string | undefined;
  sandboxToken: string | undefined;
  github: GitHubSettings | undefined;
  timeZone: string;
  awakeHours: string;
  nightly: string;
  batch: { quietMs: number; maxMs: number };
  redeliverMs: number;
  builtinDelivery: Record<"ui" | "cron" | "a2a" | "self", Delivery>;
  inline: Set<string>;
  gitAuthor: { name: string; email: string };
};

type Env = Readonly<Record<string, string | undefined>>;

const MINUTE = 60_000;

export function loadConfig(env: Env, readFile: (file: string) => string): Config {
  const get = (name: string) => {
    const value = env[name]?.trim();
    return value === undefined || value === "" ? undefined : value;
  };
  const secret = (name: string) => {
    const file = get(name);
    if (file === undefined) return undefined;
    let value: string;
    try {
      value = readFile(file).trim();
    } catch (error) {
      throw new ConfigError(`${name}: ${file} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (value === "") throw new ConfigError(`${name}: ${file} is empty`);
    return value;
  };
  const minutes = (name: string, fallback: number) => {
    const value = get(name);
    if (value === undefined) return fallback * MINUTE;
    if (!/^\d+$/.test(value) || Number(value) <= 0) throw new ConfigError(`${name} must be a whole number of minutes above 0`);
    return Number(value) * MINUTE;
  };
  const delivery = (name: string): Delivery => {
    const value = get(name) ?? "now";
    if (value !== "now" && value !== "batch") throw new ConfigError(`${name} must be now or batch`);
    return value;
  };

  const timeZone = get("PENELOPE_TIME_ZONE") ?? get("TZ") ?? "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    throw new ConfigError(`PENELOPE_TIME_ZONE: ${timeZone} is not a time zone`);
  }
  const awakeHours = get("PENELOPE_AWAKE_HOURS") ?? "07:00-23:00";
  try {
    new AwakeHours(awakeHours, timeZone);
  } catch (error) {
    throw new ConfigError(`PENELOPE_AWAKE_HOURS: ${error instanceof Error ? error.message : String(error)}`);
  }
  const nightly = get("PENELOPE_NIGHTLY_CRON") ?? "0 4 * * *";
  try {
    cronOf(nightly, timeZone);
  } catch (error) {
    throw new ConfigError(`PENELOPE_NIGHTLY_CRON: ${error instanceof Error ? error.message : String(error)}`);
  }

  let publicUrl = get("PENELOPE_PUBLIC_URL");
  if (publicUrl !== undefined) {
    if (!URL.canParse(publicUrl) || !/^https?:$/.test(new URL(publicUrl).protocol)) {
      throw new ConfigError("PENELOPE_PUBLIC_URL must be an http or https URL");
    }
    publicUrl = publicUrl.replace(/\/+$/, "");
  }

  const ownerText = get("PENELOPE_OWNER_GITHUB_ID");
  if (ownerText !== undefined && !/^[1-9]\d*$/.test(ownerText)) {
    throw new ConfigError("PENELOPE_OWNER_GITHUB_ID must be the owner's numeric GitHub user ID");
  }
  // The login is set up with all of these, or left off with none of them.
  const login = {
    PENELOPE_GITHUB_CLIENT_ID: get("PENELOPE_GITHUB_CLIENT_ID"),
    PENELOPE_GITHUB_CLIENT_SECRET_FILE: secret("PENELOPE_GITHUB_CLIENT_SECRET_FILE"),
    PENELOPE_OWNER_GITHUB_ID: ownerText,
  };
  let github: GitHubSettings | undefined;
  if (Object.values(login).some((value) => value !== undefined)) {
    const missing = Object.entries({ ...login, PENELOPE_PUBLIC_URL: publicUrl })
      .filter(([, value]) => value === undefined)
      .map(([name]) => name);
    if (missing.length > 0) throw new ConfigError(`the GitHub login is half set up: ${missing.join(", ")} missing`);
    github = {
      clientId: login.PENELOPE_GITHUB_CLIENT_ID!,
      clientSecret: login.PENELOPE_GITHUB_CLIENT_SECRET_FILE!,
      ownerId: Number(ownerText),
      callbackUrl: `${publicUrl}${CALLBACK_PATH}`,
    };
  }

  return {
    databasePath: get("PENELOPE_DATABASE") ?? "/var/lib/penelope/backend.sqlite",
    sourcesDir: get("PENELOPE_SOURCES_DIR") ?? "/sources",
    memoryDir: get("PENELOPE_MEMORY_DIR") ?? "/memory",
    intakeSocket: get("PENELOPE_INTAKE_SOCKET") ?? "/run/penelope/intake/backend.sock",
    sandboxSocket: get("PENELOPE_SANDBOX_SOCKET") ?? "/run/penelope/sandbox/backend.sock",
    listen: listenOf(get("PENELOPE_LISTEN") ?? "0.0.0.0:8080"),
    publicUrl,
    sandboxToken: secret("PENELOPE_SANDBOX_TOKEN_FILE"),
    github,
    timeZone,
    awakeHours,
    nightly,
    batch: { quietMs: minutes("PENELOPE_BATCH_QUIET_MINUTES", 5), maxMs: minutes("PENELOPE_BATCH_MAX_MINUTES", 30) },
    redeliverMs: minutes("PENELOPE_REDELIVER_MINUTES", 5),
    builtinDelivery: {
      ui: delivery("PENELOPE_DELIVERY_UI"),
      cron: delivery("PENELOPE_DELIVERY_CRON"),
      a2a: delivery("PENELOPE_DELIVERY_A2A"),
      self: delivery("PENELOPE_DELIVERY_SELF"),
    },
    inline: new Set([
      ...(get("PENELOPE_INLINE_SOURCES") ?? "ui")
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== ""),
      "control",
    ]),
    gitAuthor: {
      name: get("PENELOPE_GIT_AUTHOR_NAME") ?? "penelope-backend",
      email: get("PENELOPE_GIT_AUTHOR_EMAIL") ?? "backend@penelope.invalid",
    },
  };
}

/** `host:port`, the host in brackets when it is IPv6. */
function listenOf(value: string): { host: string; port: number } {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(value);
  const port = Number(match?.[3]);
  if (!match || port > 65535) throw new ConfigError("PENELOPE_LISTEN must be host:port");
  return { host: match[1] ?? match[2]!, port };
}
