// The tools that reach the backend: the reply to the owner, her schedules and
// events to herself. Each only calls the backend's API (docs/sandbox-api.md);
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
      expression: Type.Optional(Type.String({ description: "The expression of your face as you say it." })),
      in_reply_to: Type.Optional(Type.Integer({ description: "The seq of the event this answers." })),
    }),
    async execute(_id, params) {
      const { id } = await backend.reply(params);
      return text(`Sent (id ${id}).`);
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

  return [reply, scheduleAdd, scheduleList, scheduleRemove, selfEvent] as ToolDefinition[];
}
