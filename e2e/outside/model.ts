// The model's API, as an OpenAI-compatible chat completions endpoint that
// Pi's `openai-completions` speaks. It answers from a script keyed on markers
// the test puts in its messages, so that every turn of the test goes one way.

/** One message of a chat completions request, as far as the script reads it. */
export type ChatMessage = {
  role: string;
  content?: unknown;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

export type Answer = { text?: string; calls?: { name: string; args: Record<string, unknown> }[] };

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

/** The system prompt and the last input, with how many tool results came after it. */
export function where(messages: readonly ChatMessage[]): { system: string; input: string; steps: number } {
  const system = messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => textOf(message.content))
    .join("\n");
  let last = -1;
  messages.forEach((message, index) => {
    if (message.role === "user") last = index;
  });
  const input = last < 0 ? "" : textOf(messages[last]!.content);
  const steps = messages.slice(last + 1).filter((message) => message.role === "tool").length;
  return { system, input, steps };
}

const write = (path: string, content: string) => ({ name: "write", args: { path, content } });
const reply = (text: string) => ({ name: "reply", args: { text } });
const subAgent = (name: string, args: Record<string, unknown>) => ({ name, args });

/** The seq of the input's `a2a` event: what `reply_to_agent` names (docs/events.md, "ターンに入る形"). */
function a2aSeq(input: string): number | undefined {
  for (const line of input.split("\n")) {
    if (!line.startsWith("{")) continue;
    const event = JSON.parse(line) as { source?: string; seq?: number };
    if (event.source === "a2a") return event.seq;
  }
  return undefined;
}
const replyToAgent = (input: string, state: string, text: string) => ({ name: "reply_to_agent", args: { in_reply_to: a2aSeq(input), state, text } });

/** What the model says next. Each turn ends with text of her own, so that no turn is asked before it is folded. */
export function script(messages: readonly ChatMessage[]): Answer {
  const { system, input, steps } = where(messages);
  const plan: Answer[] = (() => {
    // A sub-agent asks back on its first request, writing a note to the memory, and answers once it is told more.
    // It waits first, so that the main agent's turn that started it has ended and the note is committed as its own.
    if (system.includes("You are a sub-agent")) {
      if (input.includes("E2E-SUB-MORE")) return [{ text: "E2E-SUB-RESULT: the build is fixed." }];
      return [
        { calls: [{ name: "bash", args: { command: "sleep 3" } }] },
        { calls: [write("/memory/notes/e2e-sub.md", "# Sub-agent\n\nWritten by a sub-agent.\n")] },
        { text: "E2E-SUB-QUESTION: which branch?" },
      ];
    }
    if (input.includes("E2E-SUB-START")) {
      return [{ calls: [subAgent("subagent_start", { name: "e2e-sub", purpose: "E2E-SUB-PURPOSE", prompt: "E2E-SUB-FIRST fix the build" })] }, { text: "Started." }];
    }
    if (input.includes("E2E-SUB-QUESTION")) return [{ calls: [subAgent("subagent_send", { name: "e2e-sub", text: "E2E-SUB-MORE main" })] }, { text: "Answered it." }];
    if (input.includes("E2E-SUB-RESULT")) {
      return [{ calls: [subAgent("subagent_close", { name: "e2e-sub" })] }, { calls: [reply("E2E-REPLY-SUB")] }, { text: "Closed it." }];
    }
    if (system.includes("You are the curator")) {
      return [{ calls: [write("/memory/INDEX.md", "# Index\n\n- notes/e2e.md: the end-to-end test's notes.\n")] }, { text: "Tidied." }];
    }
    if (input.includes("This session ends now")) {
      return [{ calls: [write("/memory/handoff.md", "E2E-HANDOFF: the next session starts from here.\n")] }, { text: "Handed off." }];
    }
    if (input.includes("E2E-TURN-1")) {
      return [
        { calls: [write("/memory/notes/e2e.md", "# E2E\n\nWritten in the first turn.\n")] },
        { calls: [{ name: "bash", args: { command: "echo E2E-BASH-$((40 + 2))" } }] },
        { calls: [reply("E2E-REPLY-1")] },
        { text: "E2E-TEXT-1" },
      ];
    }
    if (input.includes("E2E-A2A-ASK")) return [{ calls: [replyToAgent(input, "input-required", "E2E-A2A-QUESTION")] }, { text: "Asked." }];
    if (input.includes("E2E-A2A-ANSWER")) return [{ calls: [replyToAgent(input, "completed", "E2E-A2A-DONE")] }, { text: "Answered." }];
    if (input.includes("E2E-NOW")) return [{ calls: [reply("E2E-REPLY-EVENTS")] }, { text: "Seen." }];
    if (input.includes("E2E-ALERT")) return [{ calls: [reply("E2E-REPLY-ALERT")] }, { text: "Looked." }];
    const turn = /E2E-TURN-(\d+)/.exec(input)?.[1];
    if (turn) return [{ calls: [reply(`E2E-REPLY-${turn}`)] }, { text: `E2E-TEXT-${turn}` }];
    return [{ text: "ok" }];
  })();
  return plan[Math.min(steps, plan.length - 1)]!;
}

let counter = 0;

/** The answer as the chunks of a streamed chat completion, each a `data:` line. */
export function chunks(answer: Answer, model: string): string[] {
  const id = `chatcmpl-e2e-${++counter}`;
  const chunk = (choice: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, ...choice }], ...extra })}\n\n`;
  const out = [chunk({ delta: { role: "assistant", content: "" }, finish_reason: null })];
  if (answer.text) out.push(chunk({ delta: { content: answer.text }, finish_reason: null }));
  (answer.calls ?? []).forEach((call, index) => {
    out.push(
      chunk({
        delta: {
          tool_calls: [{ index, id: `call_${counter}_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }],
        },
        finish_reason: null,
      }),
    );
  });
  out.push(chunk({ delta: {}, finish_reason: answer.calls?.length ? "tool_calls" : "stop" }));
  out.push(
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
  );
  out.push("data: [DONE]\n\n");
  return out;
}

/** The answer as one chat completion, for a request that does not stream. */
export function completion(answer: Answer, model: string): unknown {
  const calls = (answer.calls ?? []).map((call, index) => ({
    id: `call_${++counter}_${index}`,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.args) },
  }));
  return {
    id: `chatcmpl-e2e-${++counter}`,
    object: "chat.completion",
    created: 0,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: answer.text ?? null, ...(calls.length ? { tool_calls: calls } : {}) },
        finish_reason: calls.length ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}
