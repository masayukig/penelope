// The tools that reach the backend: the reply to the owner, the answer to an
// agent that asked over A2A, her schedules and events to herself. Each only calls the backend's API (docs/sandbox-api.md);
// their descriptions state what they do (ADR-0008).

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { Backend } from "./backend.ts";

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
