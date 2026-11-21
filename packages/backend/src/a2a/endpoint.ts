// The A2A way in (ADR-0018, docs/a2a.md): the Agent Card without a token,
// and SendMessage and GetTask over JSON-RPC under /a2a/ of the TCP listener,
// in the version and the SDK the senders speak (A2A 1.0). Who calls is the
// sender checks' to say; what is asked is the inbox's to keep. This only
// writes the tasks in A2A's shape.
import { randomUUID } from "node:crypto";
import type http from "node:http";

import { AgentCard, Role, TaskState, type Message, type Part, type Task } from "@a2a-js/sdk";
import { ContentTypeNotSupportedError, PushNotificationNotSupportedError, RequestMalformedError, TaskNotFoundError, UnsupportedOperationError } from "@a2a-js/sdk/errors";
import { JsonRpcTransportHandler, ServerCallContext, validateVersion, type A2ARequestHandler, type User } from "@a2a-js/sdk/server";
import type { A2ATaskState } from "@penelope/contract";

import { type Handler, HttpError, readBody, sendError, sendJson } from "../http.ts";
import { InboxRefusal, type Inbox, type TaskMessage, type TaskView } from "./inbox.ts";
import { whoIs, type SenderCheck, type Senders } from "./senders.ts";

export const A2A_PATH = "/a2a";
const CARD_PATH = "/.well-known/agent-card.json";
const LEGACY_CARD_PATH = `${A2A_PATH}${CARD_PATH}`;
/** A call's body at most: room for 1 MiB of text however JSON writes it. The inbox holds the text to 1 MiB. */
export const MAX_A2A_BODY_BYTES = 2 * 1024 * 1024;
const VERSION_HEADER = "a2a-version";
/** The calls that would stream: refused before the SDK, so that the answer is one JSON body. */
const STREAMING_METHODS = new Set(["SendStreamingMessage", "SubscribeToTask"]);

export type CardSettings = { name: string; description: string; /** Where the senders call, ending in /a2a/. */ url: string };

export type A2AOptions = {
  inbox: Inbox;
  checks: readonly SenderCheck[];
  senders: Senders;
  card: CardSettings;
  log?: (line: string) => void;
};

/** Whether a path is the way in's. */
export const isA2APath = (pathname: string) => pathname === CARD_PATH || pathname === A2A_PATH || pathname.startsWith(`${A2A_PATH}/`);

export function a2aHandler(options: A2AOptions): Handler {
  const { inbox, checks, senders } = options;
  const log = (line: string) => options.log?.(`a2a: ${line}`);
  const card = buildCard(options.card);
  const cardBody = cardJson(card);
  const transport = new JsonRpcTransportHandler(new Requests(inbox, card));

  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://a2a");
    if (request.method === "GET" && (url.pathname === CARD_PATH || url.pathname === LEGACY_CARD_PATH)) {
      sendJson(response, 200, cardBody, { "cache-control": "public, max-age=300" });
      return;
    }
    if (url.pathname !== `${A2A_PATH}/` && url.pathname !== A2A_PATH) throw new HttpError(404, "no such path");
    if (request.method !== "POST") throw new HttpError(405, "only POST");

    const who = await whoIs(checks, senders, request.headers);
    if (who.kind !== "sender") {
      log(`a call was not let in (${who.reason})`);
      response.setHeader("connection", "close");
      // The same answer however the check failed; only an answer that could not be had differs, so the sender tries again.
      if (who.kind === "unavailable") sendError(response, 503, "the sender cannot be checked now");
      else sendError(response, 401, "unauthorized");
      return;
    }

    let body: Buffer;
    try {
      body = await readBody(request, MAX_A2A_BODY_BYTES);
    } catch (error) {
      if (error instanceof HttpError && error.status === 413) response.setHeader("connection", "close");
      throw error;
    }
    let call: Record<string, unknown>;
    try {
      const parsed = JSON.parse(body.toString("utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      call = parsed as Record<string, unknown>;
    } catch {
      sendJson(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON payload." } });
      return;
    }
    const id = call.id ?? null;
    const failure = (error: unknown) => ({ jsonrpc: "2.0", id, error: JsonRpcTransportHandler.mapToJSONRPCError(error) });
    if (typeof call.method === "string" && STREAMING_METHODS.has(call.method)) {
      sendJson(response, 200, failure(new UnsupportedOperationError("this agent does not stream; send the message and get the task")));
      return;
    }
    const version = request.headers[VERSION_HEADER];
    const context = new ServerCallContext({ user: new Sender(who.name), ...(typeof version === "string" && version ? { requestedVersion: version } : {}) });
    try {
      validateVersion(context.requestedVersion, card, "JSONRPC");
      sendJson(response, 200, await transport.handle(call, context));
    } catch (error) {
      const answer = failure(error);
      log(`a call of ${who.name} failed (${answer.error.code})`);
      sendJson(response, answer.error.code === -32603 ? 500 : 200, answer);
    }
  };
}

class Sender implements User {
  private readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  get isAuthenticated(): boolean {
    return true;
  }
  get userName(): string {
    return this.name;
  }
}

/** The calls served, onto the inbox; the rest are refused as not supported. */
class Requests implements A2ARequestHandler {
  private readonly inbox: Inbox;
  private readonly card: AgentCard;

  constructor(inbox: Inbox, card: AgentCard) {
    this.inbox = inbox;
    this.card = card;
  }

  async getAgentCard(): Promise<AgentCard> {
    return this.card;
  }

  async sendMessage(params: Parameters<A2ARequestHandler["sendMessage"]>[0], context: ServerCallContext): Promise<Message | Task> {
    const message = params.message;
    if (!message) throw new RequestMalformedError("the request has no message");
    // Text only: a file or data would have to be judged before it is put where she reads.
    if (message.parts.length === 0 || message.parts.some((part) => part.content?.$case !== "text")) {
      throw new ContentTypeNotSupportedError("only text parts are taken");
    }
    const text = message.parts.map((part) => (part.content?.$case === "text" ? part.content.value : "")).join("\n");
    let task: TaskView;
    try {
      task = this.inbox.receive(context.user!.userName, {
        text,
        messageId: message.messageId || randomUUID(),
        ...(message.contextId ? { contextId: message.contextId } : {}),
        ...(message.taskId ? { taskId: message.taskId } : {}),
      });
    } catch (error) {
      throw refusal(error);
    }
    return toTask(task, params.configuration?.historyLength);
  }

  async getTask(params: Parameters<A2ARequestHandler["getTask"]>[0], context: ServerCallContext): Promise<Task> {
    const task = this.inbox.task(context.user!.userName, params.id);
    if (!task) throw new TaskNotFoundError("no such task");
    return toTask(task, params.historyLength);
  }

  async getAuthenticatedExtendedAgentCard(): Promise<AgentCard> {
    throw new UnsupportedOperationError("there is no extended card");
  }
  async *sendMessageStream(): AsyncGenerator<never, void, undefined> {
    throw new UnsupportedOperationError("this agent does not stream");
  }
  async cancelTask(): Promise<Task> {
    throw new UnsupportedOperationError("a task is closed by her reply or its deadline, not cancelled");
  }
  async createTaskPushNotificationConfig(): Promise<never> {
    throw new PushNotificationNotSupportedError();
  }
  async getTaskPushNotificationConfig(): Promise<never> {
    throw new PushNotificationNotSupportedError();
  }
  async listTaskPushNotificationConfigs(): Promise<never> {
    throw new PushNotificationNotSupportedError();
  }
  async deleteTaskPushNotificationConfig(): Promise<void> {
    throw new PushNotificationNotSupportedError();
  }
  async *resubscribe(): AsyncGenerator<never, void, undefined> {
    throw new UnsupportedOperationError("this agent does not stream");
  }
  async listTasks(): Promise<never> {
    throw new UnsupportedOperationError("tasks are not listed");
  }
}

/** A refusal of the inbox as A2A's error for it; anything else is the backend's own failure, for the sender to try again. */
function refusal(error: unknown): unknown {
  if (!(error instanceof InboxRefusal)) return error;
  switch (error.kind) {
    case "not-found":
      return new TaskNotFoundError(error.message);
    case "not-waiting":
    case "closed":
      return new UnsupportedOperationError(error.message);
    default:
      return new RequestMalformedError(error.message);
  }
}

const STATES: Record<A2ATaskState, TaskState> = {
  working: TaskState.TASK_STATE_WORKING,
  "input-required": TaskState.TASK_STATE_INPUT_REQUIRED,
  completed: TaskState.TASK_STATE_COMPLETED,
  failed: TaskState.TASK_STATE_FAILED,
  rejected: TaskState.TASK_STATE_REJECTED,
};

/**
 * A task as A2A writes it: her question as the status's message while she
 * asks, the reason while it failed or was rejected, and her closing words as
 * the artifact `response`, as the agents of fraction-agents hand theirs back.
 * A task closed without words has no artifact. The history is every message,
 * or the last `historyLength`.
 */
function toTask(task: TaskView, historyLength: number | undefined): Task {
  const last = task.messages.at(-1);
  const hers = last?.role === "agent" ? last : undefined;
  const said =
    task.state === "input-required" && hers
      ? toMessage(task, hers)
      : (task.state === "failed" || task.state === "rejected") && task.reason
        ? toMessage(task, { role: "agent", messageId: `${task.taskId}-status`, text: task.reason, atMs: task.updatedMs })
        : undefined;
  const history = task.messages.map((message) => toMessage(task, message));
  return {
    id: task.taskId,
    contextId: task.contextId,
    status: { state: STATES[task.state], message: said, timestamp: new Date(task.updatedMs).toISOString() },
    artifacts:
      task.state === "completed" && hers
        ? [{ artifactId: `${task.taskId}-response`, name: "response", description: "", parts: [textPart(hers.text)], metadata: undefined, extensions: [] }]
        : [],
    history: historyLength === undefined ? history : historyLength > 0 ? history.slice(-historyLength) : [],
    metadata: undefined,
  };
}

function toMessage(task: TaskView, message: TaskMessage): Message {
  return {
    messageId: message.messageId,
    contextId: task.contextId,
    taskId: task.taskId,
    role: message.role === "agent" ? Role.ROLE_AGENT : Role.ROLE_USER,
    parts: [textPart(message.text)],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

function textPart(text: string): Part {
  return { content: { $case: "text", value: text }, metadata: undefined, filename: "", mediaType: "text/plain" };
}

/** The card: who she is from the settings, JSON-RPC of A2A 1.0 at the public URL, a bearer as the way in, and text only. */
function buildCard(settings: CardSettings): AgentCard {
  return {
    name: settings.name,
    description: settings.description,
    version: "1",
    provider: undefined,
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false, extensions: [] },
    supportedInterfaces: [{ url: settings.url, protocolBinding: "JSONRPC", protocolVersion: "1.0", tenant: "" }],
    securitySchemes: {
      bearer: {
        scheme: {
          $case: "httpAuthSecurityScheme",
          value: { scheme: "Bearer", bearerFormat: "", description: "The sender's Kubernetes ServiceAccount token." },
        },
      },
    },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [],
    signatures: [],
  };
}

/**
 * The card as served. The SDK's own form writes unions with `$case`, so it is
 * converted; the scopes of a requirement are a plain list, which a2a-cli reads
 * and the SDK accepts (as natsumi and fraction-agents serve theirs).
 */
function cardJson(card: AgentCard): Record<string, unknown> {
  return {
    ...(AgentCard.toJSON(card) as Record<string, unknown>),
    securityRequirements: card.securityRequirements.map((requirement) => ({
      schemes: Object.fromEntries(Object.entries(requirement.schemes).map(([name, scopes]) => [name, scopes.list])),
    })),
  };
}
