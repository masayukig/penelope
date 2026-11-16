// The Slack plugin (ADR-0028, docs/receivers.md "Slack のプラグイン"): it
// opens a Socket Mode connection to each workspace of its settings, makes an
// event of each thing that happens there, and acknowledges an envelope only
// once the intake took what it made. On each (re)connection it fetches the
// recent messages again; the backend drops what it already has.
import { isObject, onlyKnown, readKey, SettingsError, type ConnectionPlugin } from "../../plugin.ts";
import { describeFailure, WebApi } from "./api.ts";
import { socketMode } from "./socket.ts";
import { Workspace } from "./workspace.ts";

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MIB = 1024 * 1024;
const MAX_FILE_BYTES = 60 * MIB;
const DEFAULT_FILE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"];

export type SlackPluginOptions = {
  /** The Web API, ending in `/`. */
  apiUrl?: string;
};

type WorkspaceSettings = { name: string; appToken: string; botToken: string; nowChannels: string[] };

function token(field: string, path: unknown, env: Parameters<ConnectionPlugin["create"]>[1], prefix: string, what: string): string {
  const key = readKey(field, path, env);
  if (!key.startsWith(prefix)) throw new SettingsError(field, `${path as string} does not hold ${what} (${prefix})`);
  return key;
}

function workspacesOf(value: unknown, env: Parameters<ConnectionPlugin["create"]>[1]): WorkspaceSettings[] {
  if (!Array.isArray(value) || value.length === 0) throw new SettingsError("workspaces", "must be a list of one or more workspaces");
  const names = new Set<string>();
  return value.map((item, index) => {
    const at = `workspaces[${index}]`;
    if (!isObject(item)) throw new SettingsError(at, "must be an object");
    for (const field of Object.keys(item)) {
      if (!["name", "app_token_file", "bot_token_file", "now_channels"].includes(field)) throw new SettingsError(`${at}.${field}`, "not a field of a workspace");
    }
    const { name } = item;
    if (typeof name !== "string" || !NAME.test(name)) throw new SettingsError(`${at}.name`, "must be 1 to 32 lower-case letters, digits and '-', not starting with '-'");
    if (names.has(name)) throw new SettingsError(`${at}.name`, `${name} is given twice`);
    names.add(name);
    const nowChannels = item.now_channels ?? [];
    if (!Array.isArray(nowChannels) || !nowChannels.every((channel) => typeof channel === "string" && channel !== "")) {
      throw new SettingsError(`${at}.now_channels`, "must be a list of channel names or IDs");
    }
    return {
      name,
      appToken: token(`${at}.app_token_file`, item.app_token_file, env, "xapp-", "an app-level token"),
      botToken: token(`${at}.bot_token_file`, item.bot_token_file, env, "xoxb-", "a bot token"),
      nowChannels: nowChannels.map((channel: string) => channel.replace(/^#/, "")),
    };
  });
}

export function slackPlugin(options: SlackPluginOptions = {}): ConnectionPlugin {
  const apiUrl = options.apiUrl ?? "https://slack.com/api/";
  return {
    name: "slack",
    kind: "connection",
    create(settings, env) {
      onlyKnown(settings, ["workspaces", "backfill_hours", "max_file_bytes", "file_types"]);
      const workspaces = workspacesOf(settings.workspaces, env);
      const hours = settings.backfill_hours ?? 24;
      if (typeof hours !== "number" || !Number.isInteger(hours) || hours < 0) throw new SettingsError("backfill_hours", "must be an integer of 0 or more");
      const maxFileBytes = settings.max_file_bytes ?? 20 * MIB;
      if (typeof maxFileBytes !== "number" || !Number.isInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > MAX_FILE_BYTES) {
        throw new SettingsError("max_file_bytes", `must be an integer from 1 to ${MAX_FILE_BYTES}`);
      }
      const fileTypes = settings.file_types ?? DEFAULT_FILE_TYPES;
      if (!Array.isArray(fileTypes) || !fileTypes.every((type) => typeof type === "string" && /^[^/\s]+\/[^/\s]+$/.test(type))) {
        throw new SettingsError("file_types", "must be a list of MIME types");
      }

      return {
        start(io) {
          const running = workspaces.map((settings) => {
            const api = new WebApi({ apiUrl, appToken: settings.appToken, botToken: settings.botToken });
            const workspace = new Workspace({
              name: settings.name,
              api,
              nowChannels: settings.nowChannels,
              fileTypes: new Set(fileTypes as string[]),
              maxFileBytes,
              backfillSeconds: hours * 3600,
              log: io.log,
              now: io.now,
            });
            const log = (line: string) => io.log(`workspace=${settings.name} ${line}`);
            let stopped = false;
            /** One fill-in at a time; a connection during one asks for another after it. */
            let filling: Promise<void> | undefined;
            let again = false;
            const fill = () => {
              if (filling) {
                again = true;
                return;
              }
              filling = (async () => {
                do {
                  again = false;
                  try {
                    const filled = await workspace.backfill(io.deliver, () => stopped);
                    log(`filled in conversations=${filled.conversations} events=${filled.events} failed=${filled.failed}${filled.stopped ? " stopped" : ""}`);
                  } catch (error) {
                    log(`cannot fill in (${describeFailure(error)})`);
                  }
                } while (again && !stopped);
                filling = undefined;
              })();
            };
            const socket = socketMode({
              open: async () => {
                await workspace.identify();
                return api.openConnection();
              },
              hello: () => {
                workspace.forget();
                fill();
              },
              handle: async (envelope) => {
                if (envelope.type !== "events_api" || !isObject(envelope.payload)) {
                  log(`envelope=${typeof envelope.type === "string" ? envelope.type.replace(/[^a-z_]/g, "") : "unknown"} passed over`);
                  return true;
                }
                const { events, dropped } = await workspace.fromCallback(envelope.payload);
                const taken = events.length === 0 || (await io.deliver(events));
                log(`envelope=events_api events=${events.length} dropped=${dropped} taken=${taken}`);
                return taken;
              },
              log,
            });
            return {
              stop: async () => {
                stopped = true;
                await socket.stop();
                await filling;
              },
            };
          });
          return { stop: async () => void (await Promise.all(running.map((item) => item.stop()))) };
        },
      };
    },
  };
}

export const slack = slackPlugin();
