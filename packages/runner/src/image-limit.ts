// The provider's limit applies to the projection after folding, not to the
// transcript. Unconfigured providers get the same context as before.

import { readFile } from "node:fs/promises";

import type { ImageContent } from "@earendil-works/pi-ai";
import type { ContextEvent, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { TurnLine } from "@penelope/contract";

type Message = ContextEvent["messages"][number];

export async function readImageLimits(path: string): Promise<ReadonlyMap<string, number>> {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  // Match Pi's models.json: a BOM, line comments and trailing commas are
  // accepted. The quoted strings (including URLs) are left alone.
  const json = source.replace(/^\uFEFF/, "")
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => match.startsWith('"') ? match : "")
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail: string | undefined) => tail ?? match);
  let config: { providers?: Record<string, { maxImagesPerRequest?: unknown } | null> } | null;
  try {
    config = JSON.parse(json);
  } catch {
    throw new Error("Could not parse models.json to read provider image limits");
  }
  const limits = new Map<string, number>();
  for (const [provider, entry] of Object.entries(config?.providers ?? {})) {
    const limit = entry?.maxImagesPerRequest;
    if (limit === undefined) continue;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0) {
      throw new Error(`models.json: providers[${JSON.stringify(provider)}].maxImagesPerRequest must be a non-negative integer`);
    }
    limits.set(provider, limit);
  }
  return limits;
}

function imageBlocks(message: Message) {
  if (message.role !== "user" && message.role !== "toolResult" && message.role !== "custom") return [];
  return Array.isArray(message.content) ? message.content.filter((part) => part.type === "image") : [];
}

/** Attachment paths are already in the event text. Only pair them up when none are ambiguous. */
function attachmentPaths(message: Extract<Message, { role: "user" }>, images: ImageContent[]): string[] {
  if (!Array.isArray(message.content)) return [];
  const text = message.content.find((part) => part.type === "text")?.text;
  const events = /^<events>\n([\s\S]*?)\n<\/events>(?:\n|$)/.exec(text ?? "")?.[1];
  if (!events) return [];
  try {
    const lines = events.split("\n").map((line) => JSON.parse(line) as TurnLine);
    // A drawn batch can have inline images whose paths are not listed in the input.
    if (lines.some((line) => "kind" in line && "text" in line)) return [];
    const groups = lines.flatMap((line) => {
      if ("kind" in line || !("text" in line)) return [];
      const attachments = line.attachments?.filter((a) => images.some((image) => image.mimeType === a.mime_type));
      return attachments?.length ? [attachments] : [];
    });
    // Image order across events need not match the order of the formatted lines.
    const [attachments] = groups;
    if (groups.length === 1 && attachments?.length === images.length &&
        attachments.every((a, i) => a.mime_type === images[i]!.mimeType)) {
      return attachments.map(({ path }) => path);
    }
  } catch {
    // Not a runner event input. The omission still gets a marker.
  }
  return [];
}

function limitImages(messages: Message[], limit: number): Message[] | undefined {
  let omit = -limit;
  for (const message of messages) omit += imageBlocks(message).length;
  if (omit <= 0) return undefined;

  const readPaths = new Map<string, string>();
  return messages.map((message) => {
    if (omit === 0) return message;
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall" && block.name === "read" && typeof block.arguments.path === "string") {
          readPaths.set(block.id, block.arguments.path);
        }
      }
      return message;
    }
    if (message.role !== "user" && message.role !== "toolResult" && message.role !== "custom") return message;
    const images = imageBlocks(message);
    if (images.length === 0 || !Array.isArray(message.content)) return message;
    const paths = message.role === "user" ? attachmentPaths(message, images) : [];
    let index = 0;
    const content = message.content.map((part) => {
      if (part.type !== "image" || omit === 0) return part;
      omit--;
      const path = message.role === "toolResult" ? readPaths.get(message.toolCallId) : paths[index++];
      return { type: "text" as const, text: `Image omitted from the model request.${path ? ` Read ${JSON.stringify(path)} to see it again.` : " Read the original file again if available."}` };
    });
    return { ...message, content };
  });
}

export function imageLimitExtension(limits: ReadonlyMap<string, number>): ExtensionFactory {
  return (pi) => {
    pi.on("context", (event, ctx) => {
      const limit = ctx.model && limits.get(ctx.model.provider);
      if (limit === undefined) return;
      const messages = limitImages(event.messages, limit);
      return messages && { messages };
    });
  };
}
