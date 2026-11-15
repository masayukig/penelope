// The tools that only the main agent has: those that reach the backend (the
// reply to the owner, the answer to an agent that asked over A2A, her
// schedules and events to herself), each only calling the backend's API
// (docs/sandbox-api.md), and those that start and talk to her sub-agents
// (ADR-0022). Their descriptions state what they do (ADR-0008).

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { Backend } from "./backend.ts";
import type { SubAgents } from "./subagents.ts";

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }], details: undefined };
}

export function backendTools(backend: Backend): ToolDefinition[] {
  const reply = defineTool({
    name: "reply",
    label: "Reply",
    description:
      "Send a message to your owner. It is the only way your words reach them; the text of your turn is not shown to anyone.",
    parameters: Type.Object({
      text: Type.String({ description: "The message." }),
      expression: Type.Optional(
        Type.String({
          description:
            "The expression of your face as you say it. The owner's screen has a face for each of: neutral, happy, laughing, surprised, thinking, worried, sad, sleepy, angry.",
        }),
      ),
      in_reply_to: Type.Optional(Type.Integer({ description: "The seq of the event this answers." })),
    }),
    async execute(_id, params) {
      const { id } = await backend.reply(params);
      return text(`Sent (id ${id}).`);
    },
  });

  const replyToAgent = defineTool({
    name: "reply_to_agent",
    label: "Reply to an agent",
    description:
      "Answer another agent in the A2A task of an `a2a` event. The event's stream is the agent's name, and its payload has the agent's text and the task. `completed` closes the task, with the text as its answer when you give one. `input-required` asks the agent the text and keeps the task open; the agent's answer comes as another `a2a` event of the same task. The agent fetches what you send from its task; your owner does not see it. A task the agent has not written to within the backend's deadline fails, and can no longer be answered.",
    parameters: Type.Object({
      in_reply_to: Type.Integer({ description: "The seq of an `a2a` event of the task." }),
      state: Type.Union([Type.Literal("completed"), Type.Literal("input-required")], {
        description: "completed: close the task. input-required: ask the agent, and wait for its answer.",
      }),
      text: Type.Optional(Type.String({ description: "The answer, or the question. Needed for input-required." })),
    }),
    async execute(_id, params) {
      const task = await backend.a2aReply(params);
      return text(`Sent: the task is ${task.state}.`);
    },
  });

  const scheduleAdd = defineTool({
    name: "schedule_add",
    label: "Add a schedule",
    description:
      "Schedule an event to yourself: at a time (RFC 3339), or repeatedly by a cron expression. When it comes due, a `cron` event with the reason reaches you.",
    parameters: Type.Object({
      reason: Type.String({ description: "What the event is for. It comes back as the event's summary." }),
      cron: Type.Optional(Type.String({ description: "A cron expression with five fields." })),
      at: Type.Optional(Type.String({ description: "One time, RFC 3339." })),
    }),
    async execute(_id, params) {
      if ((params.cron === undefined) === (params.at === undefined)) {
        throw new Error("give either cron or at");
      }
      const schedule = await backend.createSchedule(
        params.cron !== undefined ? { reason: params.reason, cron: params.cron } : { reason: params.reason, at: params.at! },
      );
      return text(JSON.stringify(schedule));
    },
  });

  const scheduleList = defineTool({
    name: "schedule_list",
    label: "List schedules",
    description: "List your schedules.",
    parameters: Type.Object({}),
    async execute() {
      return text(JSON.stringify(await backend.listSchedules()));
    },
  });

  const scheduleRemove = defineTool({
    name: "schedule_remove",
    label: "Remove a schedule",
    description: "Remove one of your schedules by its id.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params) {
      await backend.deleteSchedule(params.id);
      return text(`Removed ${params.id}.`);
    },
  });

  const selfEvent = defineTool({
    name: "self_event",
    label: "Event to yourself",
    description:
      "Put an event to yourself into your queue, as a `self` event. It reaches you like any other event. An id that was used before is dropped as a duplicate.",
    parameters: Type.Object({
      id: Type.String({ description: "Unique among your own events." }),
      summary: Type.String({ description: "One line." }),
      payload: Type.Optional(Type.Unknown({ description: "Any JSON, written to /sources/self/." })),
    }),
    async execute(_id, params) {
      await backend.selfEvent({ id: params.id, summary: params.summary, payload: params.payload ?? null });
      return text(`Queued ${params.id}.`);
    },
  });

  return [reply, replyToAgent, scheduleAdd, scheduleList, scheduleRemove, selfEvent] as ToolDefinition[];
}

export function subAgentTools(agents: SubAgents): ToolDefinition[] {
  const start = defineTool({
    name: "subagent_start",
    label: "Start a sub-agent",
    description:
      "Start a sub-agent: another Pi session, run by the runner in this sandbox, with Pi's tools and the shell but none of reply, reply_to_agent, the schedules, self_event or the subagent_ tools. It returns as soon as the sub-agent has started, and the sub-agent runs in the background. Each time it stops, a `self` event reaches you with its name as the stream; the payload has why it stopped (`stopped`, `failed`, or `interrupted` when the runner stopped during its run), its purpose, and the whole text of its last answer. Its system prompt says it is your sub-agent, its purpose and working directory, the sandbox, the connectors and the skills, followed by the body of /memory/agents/<role>.md, or of /memory/agents/default.md when no role is given. It is not given your personality or your memory files. A name is used once, and is not used again after the sub-agent is closed.",
    parameters: Type.Object({
      name: Type.String({
        description:
          "Its name: lowercase letters, digits and -, starting with a letter or a digit, at most 63 characters, not main. The stream of its events, and its working directory ~/agents/<name>/ when none is given.",
      }),
      purpose: Type.String({ description: "One line on what it is for, shown by subagent_list and on your owner's screen." }),
      prompt: Type.String({ description: "The first request, given to it as it is." }),
      role: Type.Optional(Type.String({ description: "A role: the file /memory/agents/<role>.md." })),
      cwd: Type.Optional(Type.String({ description: "Its working directory, which must exist. Left out, ~/agents/<name>/ is made." })),
    }),
    async execute(_id, params) {
      return text(await agents.start(params));
    },
  });

  const send = defineTool({
    name: "subagent_send",
    label: "Send to a sub-agent",
    description:
      "Send more words to a sub-agent that has stopped and is waiting. It goes on in the same session, in the background, and another `self` event reaches you when it stops again. A running sub-agent takes no words.",
    parameters: Type.Object({
      name: Type.String({ description: "The sub-agent's name." }),
      text: Type.String({ description: "The words, given to it as they are." }),
    }),
    async execute(_id, params) {
      return text(await agents.send(params.name, params.text));
    },
  });

  const list = defineTool({
    name: "subagent_list",
    label: "List sub-agents",
    description:
      "List the sub-agents that are not closed, as JSON: each one's name, state (running, or waiting after it stopped), purpose and working directory. Sub-agents stay until they are closed, across nights.",
    parameters: Type.Object({}),
    async execute() {
      return text(JSON.stringify(agents.list()));
    },
  });

  const close = defineTool({
    name: "subagent_close",
    label: "Close a sub-agent",
    description:
      "Close a sub-agent. A run it is in is cancelled, with no event for it. A closed sub-agent takes no more words. Its working directory and the record of its session are kept.",
    parameters: Type.Object({ name: Type.String({ description: "The sub-agent's name." }) }),
    async execute(_id, params) {
      return text(await agents.close(params.name));
    },
  });

  return [start, send, list, close] as ToolDefinition[];
}
