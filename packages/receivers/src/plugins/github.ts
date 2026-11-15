// GitHub's webhook (ADR-0024, docs/receivers.md "GitHub のプラグイン"): a
// request for a review and a dismissed review are each one event, made from
// the one delivery alone.
import { createHmac, timingSafeEqual } from "node:crypto";

import {
  isObject,
  onlyKnown,
  type PluginEvent,
  readKey,
  SettingsError,
  type WebhookOutcome,
  type WebhookPlugin,
  type WebhookRequest,
} from "../plugin.ts";
import { streamOf, summaryLine } from "./text.ts";

/** The action read of each event read. */
const READ: Readonly<Record<string, string>> = { pull_request: "review_requested", pull_request_review: "dismissed" };

const SIGNATURE = /^sha256=([0-9a-f]{64})$/i;

export const github: WebhookPlugin = {
  name: "github",
  kind: "webhook",
  create(settings, env) {
    onlyKnown(settings, ["secret_file", "authors", "reviewers"]);
    const secret = readKey("secret_file", settings.secret_file, env);
    const authors = logins("authors", settings.authors);
    const reviewers = logins("reviewers", settings.reviewers);

    return (request: WebhookRequest): WebhookOutcome => {
      if (!signed(header(request, "x-hub-signature-256"), request.body, secret)) return { kind: "refuse", status: 401 };
      const event = header(request, "x-github-event");
      if (event === undefined) return { kind: "refuse", status: 400, reason: "X-GitHub-Event is missing" };
      const action = READ[event];
      if (action === undefined) return { kind: "accept", events: [], dropped: 0, notes: [] };

      const body = parseJson(request.body);
      if (!isObject(body)) return { kind: "refuse", status: 400, reason: "the body is not a JSON object" };
      if (typeof body.action !== "string") return { kind: "refuse", status: 400, reason: "action: must be a string" };
      if (body.action !== action) return { kind: "accept", events: [], dropped: 0, notes: [] };

      const delivery = header(request, "x-github-delivery");
      if (delivery === undefined) return { kind: "refuse", status: 400, reason: "X-GitHub-Delivery is missing" };
      const read = readBody(body, action);
      if (typeof read === "string") return { kind: "refuse", status: 400, reason: read };
      if (read.reviewer === undefined || !reviewers.has(read.reviewer.toLowerCase()) || !authors.has(read.author.toLowerCase())) {
        return { kind: "accept", events: [], dropped: 1, notes: [] };
      }
      return { kind: "accept", events: [eventOf(event, action, delivery, { ...read, reviewer: read.reviewer }, request.receivedAt)], dropped: 0, notes: [] };
    };
  },
};

/** The logins of a list, in lower case: one or more non-empty strings, none twice in any case. */
function logins(field: string, value: unknown): Set<string> {
  if (!Array.isArray(value) || value.length === 0) throw new SettingsError(field, "must be a list of one or more logins");
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item === "") throw new SettingsError(`${field}[${index}]`, "must be a non-empty string");
    const login = item.toLowerCase();
    if (seen.has(login)) throw new SettingsError(`${field}[${index}]`, "is given twice (logins are matched in any case)");
    seen.add(login);
  }
  return seen;
}

/** A header's value, or nothing when it is missing or empty. */
function header(request: WebhookRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * `sha256=<hex>` of the body's HMAC-SHA256 with the secret. The hex is turned
 * back into 32 bytes and compared in a time that does not depend on how much
 * of it matched; a missing or misshapen header is compared too, so that every
 * refusal costs the same.
 */
function signed(signature: string | undefined, body: Uint8Array, secret: string): boolean {
  const hex = signature === undefined ? undefined : SIGNATURE.exec(signature)?.[1];
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = hex === undefined ? Buffer.alloc(expected.length) : Buffer.from(hex, "hex");
  return timingSafeEqual(given, expected) && hex !== undefined;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

/** What an event is made of; `reviewer` is missing for a request to a team. */
type Read = {
  repository: string;
  number: number;
  title: string;
  url: string;
  author: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  reviewer: string | undefined;
};

/** The fields the plugin reads (docs/receivers.md, "body"), or the first that is not of its shape. */
function readBody(body: Record<string, unknown>, action: string): Read | string {
  const at = new Fields(body);
  const pull = "pull_request";
  const number = at.get(`${pull}.number`, (value) => (Number.isInteger(value) && (value as number) > 0 ? (value as number) : undefined), "must be a positive integer");
  const title = at.string(`${pull}.title`);
  const url = at.string(`${pull}.html_url`);
  const author = at.login(`${pull}.user.login`);
  const headSha = at.login(`${pull}.head.sha`);
  const headRef = at.string(`${pull}.head.ref`);
  const baseRef = at.string(`${pull}.base.ref`);
  const repository = at.get(`${pull}.base.repo.full_name`, (value) => (typeof value === "string" && /^[^/]+\/[^/]+$/.test(value) ? value : undefined), "must be <owner>/<name>");
  let reviewer: string | undefined;
  if (action === "review_requested") {
    // A request to a team has no requested_reviewer, or has it null.
    const requested = body.requested_reviewer;
    if (requested !== undefined && requested !== null) {
      if (!isObject(requested)) at.fail("requested_reviewer", "must be an object or null");
      else reviewer = at.login("requested_reviewer.login");
    }
  } else {
    reviewer = at.login("review.user.login");
  }
  if (at.error !== undefined) return at.error;
  return { repository: repository!, number: number!, title: title!, url: url!, author: author!, headSha: headSha!, headRef: headRef!, baseRef: baseRef!, reviewer };
}

/** Reads fields by their dotted paths, keeping the first that is not of its shape. The reason names the field, never its value. */
class Fields {
  error: string | undefined;
  private readonly body: Record<string, unknown>;

  constructor(body: Record<string, unknown>) {
    this.body = body;
  }

  fail(path: string, why: string): undefined {
    this.error ??= `${path}: ${why}`;
    return undefined;
  }

  get<T>(path: string, take: (value: unknown) => T | undefined, why: string): T | undefined {
    const keys = path.split(".");
    let at: Record<string, unknown> = this.body;
    for (const [index, key] of keys.slice(0, -1).entries()) {
      const next = at[key];
      if (!isObject(next)) return this.fail(keys.slice(0, index + 1).join("."), "must be an object");
      at = next;
    }
    const value = take(at[keys.at(-1)!]);
    return value === undefined ? this.fail(path, why) : value;
  }

  string(path: string): string | undefined {
    return this.get(path, (value) => (typeof value === "string" ? value : undefined), "must be a string");
  }

  login(path: string): string | undefined {
    return this.get(path, (value) => (typeof value === "string" && value !== "" ? value : undefined), "must be a non-empty string");
  }
}

function eventOf(event: string, action: string, delivery: string, read: Read & { reviewer: string }, receivedAt: Date): PluginEvent {
  const what = action === "review_requested" ? "review requested" : "review dismissed";
  return {
    id: delivery,
    occurred_at: receivedAt.toISOString(),
    summary: summaryLine(`[${what}] ${read.repository}#${read.number}: ${read.title}`),
    // A full name is `<owner>/<name>`, never empty, so there is always a stream.
    stream: streamOf(read.repository.replace("/", "."))!,
    delivery: "batch",
    payload: {
      event,
      action,
      delivery,
      repository: read.repository,
      number: read.number,
      title: read.title,
      url: read.url,
      author: read.author,
      head_sha: read.headSha,
      head_ref: read.headRef,
      base_ref: read.baseRef,
      reviewer: read.reviewer,
    },
  };
}
