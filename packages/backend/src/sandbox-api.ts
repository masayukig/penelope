// The backend's API for the sandbox (docs/sandbox-api.md). It listens only
// on a Unix socket that the backend and the Sentinel mount; the Sentinel
// puts the real token in place of the sandbox's surrogate (ADR-0014).
import { createHash, timingSafeEqual } from "node:crypto";
import type http from "node:http";

import { type Activity, type AgentId, type DeliveredEvent, isSubAgentName, type ScheduleWhen } from "@penelope/contract";

import { type Inbox, InboxRefusal } from "./a2a/inbox.ts";
import type { SubAgents } from "./agents.ts";
import type { Conversation } from "./conversation.ts";
import { isTime } from "./envelope.ts";
import { type Handler, HttpError, readJson, sendEmpty, sendJson } from "./http.ts";
import type { Memory } from "./memory.ts";
import type { Queue } from "./queue.ts";
import { ScheduleError, type Schedules } from "./schedules.ts";
import { iso } from "./time.ts";

/** The longest a poll waits. */
export const MAX_WAIT_SECONDS = 60;
/** Replies and activity carry tool output, so the limit is generous. */
export const DEFAULT_SANDBOX_BYTES = 16 * 1024 * 1024;

export type SandboxOptions = {
  /** The real token. Without one, every request is refused. */
  token: string | undefined;
  queue: Queue;
  conversation: Conversation;
  /** What the runner said of each sub-agent. */
  agents: SubAgents;
  schedules: Schedules;
  memory: Memory;
  /** The tasks other agents sent over A2A, which her replies close or ask in. */
  inbox: Inbox;
  now: () => number;
  maxBytes?: number;
  log?: (line: string) => void;
};

export function sandboxHandler(options: SandboxOptions): Handler {
  const { queue, conversation, agents, schedules, memory, inbox, now } = options;
  const log = options.log ?? console.error;
  const maxBytes = options.maxBytes ?? DEFAULT_SANDBOX_BYTES;
  const expected = options.token === undefined || options.token === "" ? undefined : digest(options.token);

  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://sandbox");
    if (!authorized(request, expected)) throw new HttpError(401, "the token is not the backend's");
    const route = `${request.method} ${url.pathname}`;
    const body = () => readJson(request, maxBytes).then(object);

    if (url.pathname === "/v1/events") {
      if (request.method !== "GET") throw new HttpError(405, "only GET");
      mainOnly(agentOf(url.searchParams.get("agent")), "takes events");
      const after = integer(url.searchParams.get("after") ?? "0", "after");
      const wait = Math.min(integer(url.searchParams.get("wait") ?? "0", "wait"), MAX_WAIT_SECONDS);
      const events = await poll(queue, after, wait * 1000, response, now);
      sendJson(response, 200, { events });
      return;
    }

    switch (route) {
      case "POST /v1/events/ack": {
        const { seqs } = withAgent(await body());
        if (!Array.isArray(seqs) || !seqs.every((seq) => Number.isSafeInteger(seq))) {
          throw new HttpError(400, "seqs must be a list of integers");
        }
        queue.ack(seqs as number[]);
        sendEmpty(response, 204);
        return;
      }
      case "POST /v1/self-events": {
        const request = withAgent(await body());
        const { id, summary, payload } = request;
        if (typeof id !== "string" || id === "") throw new HttpError(400, "id must be a non-empty string");
        if (typeof summary !== "string") throw new HttpError(400, "summary must be a string");
        if (!("payload" in request)) throw new HttpError(400, "payload is required");
        // A sub-agent's events go under its own stream, /sources/self/<name>/.
        const stream = request.agent === "main" ? {} : { stream: request.agent };
        queue.accept({ source: "self", id, ...stream, occurred_at: iso(now()), summary, payload }, { builtin: true });
        sendEmpty(response, 202);
        return;
      }
      case "POST /v1/replies": {
        const { agent, text, expression, in_reply_to } = withAgent(await body());
        mainOnly(agent, "replies to the owner");
        if (typeof text !== "string") throw new HttpError(400, "text must be a string");
        if (expression !== undefined && typeof expression !== "string") throw new HttpError(400, "expression must be a string");
        if (in_reply_to !== undefined && !Number.isSafeInteger(in_reply_to)) throw new HttpError(400, "in_reply_to must be a seq");
        const reply = conversation.reply({
          agent,
          text,
          ...(expression === undefined ? {} : { expression: expression as string }),
          ...(in_reply_to === undefined ? {} : { in_reply_to: in_reply_to as number }),
        });
        sendJson(response, 201, reply);
        return;
      }
      case "POST /v1/a2a/replies": {
        const { agent, in_reply_to, state, text } = withAgent(await body());
        mainOnly(agent, "answers A2A tasks");
        if (!Number.isSafeInteger(in_reply_to)) throw new HttpError(400, "in_reply_to must be the seq of an a2a event");
        if (state !== "completed" && state !== "input-required") throw new HttpError(400, "state must be completed or input-required");
        if (text !== undefined && typeof text !== "string") throw new HttpError(400, "text must be a string");
        try {
          sendJson(response, 200, inbox.reply({ in_reply_to: in_reply_to as number, state, ...(text === undefined ? {} : { text }) }));
        } catch (error) {
          if (!(error instanceof InboxRefusal)) throw error;
          throw new HttpError(error.kind === "no-such-event" ? 404 : error.kind === "closed" ? 409 : 400, error.message);
        }
        return;
      }
      case "POST /v1/activity": {
        const { agent, activities } = withAgent(await body());
        if (!Array.isArray(activities)) throw new HttpError(400, "activities must be a list");
        conversation.activities(agent, activities.map(activity));
        sendEmpty(response, 204);
        return;
      }
      case "POST /v1/turns/end": {
        const { agent, turn_id } = withAgent(await body());
        if (typeof turn_id !== "string" || turn_id === "") throw new HttpError(400, "turn_id must be a non-empty string");
        conversation.turnEnded(agent);
        try {
          await memory.commit({ agent, turnId: turn_id });
        } catch (error) {
          log(`memory: turn ${turn_id} not committed: ${error instanceof Error ? error.message : String(error)}`);
          throw new HttpError(500, "/memory could not be committed");
        }
        sendEmpty(response, 204);
        return;
      }
      case "POST /v1/agents": {
        const { agent, purpose, closed } = withAgent(await body());
        if (agent === "main") throw new HttpError(400, "agent must be a sub-agent's name, not main");
        if (typeof purpose !== "string") throw new HttpError(400, "purpose must be a string");
        if (typeof closed !== "boolean") throw new HttpError(400, "closed must be a boolean");
        agents.record({ agent, purpose, closed });
        sendEmpty(response, 204);
        return;
      }
      case "GET /v1/schedules": {
        const agent = mainOnly(agentOf(url.searchParams.get("agent")), "has schedules");
        sendJson(response, 200, { schedules: schedules.list(agent) });
        return;
      }
      case "POST /v1/schedules": {
        const { agent, reason, cron, at } = withAgent(await body());
        mainOnly(agent, "has schedules");
        if (typeof reason !== "string") throw new HttpError(400, "reason must be a string");
        let when: ScheduleWhen;
        if (typeof cron === "string" && at === undefined) when = { cron };
        else if (typeof at === "string" && cron === undefined) when = { at };
        else throw new HttpError(400, "a schedule has either cron or at, as a string");
        try {
          sendJson(response, 201, schedules.create({ agent, reason, ...when }));
        } catch (error) {
          if (error instanceof ScheduleError) throw new HttpError(400, error.message);
          throw error;
        }
        return;
      }
      case "POST /v1/sessions/rotated": {
        const { agent } = withAgent(await body());
        conversation.sessionRotated(agent);
        log(`session: ${agent} switched to a new session`);
        sendEmpty(response, 204);
        return;
      }
    }

    const scheduleId = /^\/v1\/schedules\/([^/]+)$/.exec(url.pathname)?.[1];
    if (scheduleId !== undefined) {
      if (request.method !== "DELETE") throw new HttpError(405, "only DELETE");
      mainOnly(agentOf(url.searchParams.get("agent")), "has schedules");
      if (!schedules.remove(decodeURIComponent(scheduleId))) throw new HttpError(404, "no such schedule");
      sendEmpty(response, 204);
      return;
    }
    const known = ["/v1/events/ack", "/v1/self-events", "/v1/agents", "/v1/replies", "/v1/a2a/replies", "/v1/activity", "/v1/turns/end", "/v1/schedules", "/v1/sessions/rotated"];
    if (known.includes(url.pathname)) throw new HttpError(405, "not this method");
    throw new HttpError(404, "no such path");
  };
}

/**
 * Long-polls the queue: the events due now, or the first ones to come within
 * `waitMs`, or none. It wakes for a new event, for a batch falling due and
 * for an ack falling overdue, and stops when the caller goes away.
 */
async function poll(
  queue: Queue,
  after: number,
  waitMs: number,
  response: http.ServerResponse,
  now: () => number,
): Promise<DeliveredEvent[]> {
  const deadline = now() + waitMs;
  let gone = false;
  response.once("close", () => (gone = true));
  for (;;) {
    if (gone) return [];
    const events = queue.take({ after });
    const left = deadline - now();
    if (events.length > 0 || left <= 0) return events;
    const wake = queue.nextWakeAt();
    // At least a little sleep, so that a wake time already past cannot spin.
    const sleep = wake === undefined ? left : Math.min(left, Math.max(100, wake - now()));
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        stop();
        response.off("close", done);
        resolve();
      };
      const timer = setTimeout(done, sleep);
      const stop = queue.onChange(done);
      response.once("close", done);
    });
  }
}

const digest = (value: string) => createHash("sha256").update(value).digest();

function authorized(request: http.IncomingMessage, expected: Buffer | undefined): boolean {
  if (expected === undefined) return false;
  const match = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "");
  return match !== null && timingSafeEqual(digest(match[1]!), expected);
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HttpError(400, "the body must be a JSON object");
  return value as Record<string, unknown>;
}

/** `main`, or a sub-agent's name of the shape of the contract: it may become a directory under /sources. */
function agentOf(value: unknown): AgentId {
  if (value !== "main" && !isSubAgentName(value)) {
    throw new HttpError(400, "agent must be main or a sub-agent's name: lower-case letters, digits and '-', up to 63");
  }
  return value;
}

/** Sub-agents talk only to the main agent: what it alone does is refused to them (ADR-0022). */
function mainOnly(agent: AgentId, what: string): AgentId {
  if (agent !== "main") throw new HttpError(400, `only main ${what}, not the sub-agent ${agent}`);
  return agent;
}

function withAgent(body: Record<string, unknown>): Record<string, unknown> & { agent: AgentId } {
  return { ...body, agent: agentOf(body.agent) };
}

function integer(value: string, name: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new HttpError(400, `${name} must be a whole number`);
  return Number(value);
}

/** One block of a turn, checked to be one of the kinds of the contract. */
function activity(value: unknown): Activity {
  const block = object(value);
  const { kind, at, turn_id } = block;
  const bad = (why: string) => new HttpError(400, `an activity ${why}`);
  if (!isTime(at)) throw bad("needs at as an RFC 3339 time");
  if (typeof turn_id !== "string" || turn_id === "") throw bad("needs a turn_id");
  const text = (field: string) => {
    if (typeof block[field] !== "string") throw bad(`of kind ${String(kind)} needs ${field} as a string`);
    return block[field];
  };
  const base = { at, turn_id };
  switch (kind) {
    case "turn_start":
    case "turn_end":
      return { ...base, kind };
    case "thinking":
    case "message":
      return { ...base, kind, text: text("text") };
    case "tool_call":
      if (!("arguments" in block)) throw bad("of kind tool_call needs arguments");
      return { ...base, kind, call_id: text("call_id"), name: text("name"), arguments: block.arguments };
    case "tool_result":
      if (typeof block.is_error !== "boolean") throw bad("of kind tool_result needs is_error as a boolean");
      return { ...base, kind, call_id: text("call_id"), is_error: block.is_error, output: text("output") };
    default:
      throw bad("kind must be turn_start, thinking, tool_call, tool_result, message or turn_end");
  }
}
