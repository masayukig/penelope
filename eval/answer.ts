import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, type ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { ThinkingLevel } from "../packages/runner/src/config.ts";
import { lastAssistant } from "../packages/runner/src/pi.ts";
import { questions } from "./scenario.ts";

// Snapshot only Markdown, never follow symlinks or expose Git history. The model
// sees names from this map, and its reads are lookups, not filesystem access.
async function snapshot(dir: string, prefix = ""): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      for (const [key, value] of await snapshot(path, `${name}/`)) files.set(key, value);
    } else if (entry.isFile() && name.endsWith(".md")) {
      files.set(name, await readFile(path, "utf8"));
    }
  }
  return files;
}

export async function answer(runtime: ModelRuntime, ref: { provider: string; id: string }, thinking: ThinkingLevel, memory: string, cwd: string, agentDir: string) {
  const files = await snapshot(memory);
  const model = runtime.getModel(ref.provider, ref.id);
  if (!model) throw new Error("Answer model not registered");
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    systemPrompt: "You answer tomorrow's questions for a fictional sample-crate depot. The only evidence available is the depot's current memory, accessible through the memory tools. Answer from that memory; use null for facts you cannot establish. Cite only the document or receipt IDs supported by the memory.",
  });
  await resourceLoader.reload();
  const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
  const { session } = await createAgentSession({
    cwd, agentDir, modelRuntime: runtime, model, thinkingLevel: thinking, settingsManager, resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    tools: ["list_memory", "read_memory"],
    customTools: [
      {
        name: "list_memory", label: "List memory", description: "List the current memory's Markdown files.", parameters: Type.Object({}),
        execute: async () => reply([...files.keys()].sort().join("\n")),
      },
      {
        name: "read_memory", label: "Read memory", description: "Read a listed file from current memory.", parameters: Type.Object({ path: Type.String() }),
        execute: async (_id, { path }) => reply(files.get(path) ?? "No such memory file."),
      },
    ],
  });
  try {
    const format = Object.fromEntries(questions.map(({ id, fields }) => [id, {
      ...Object.fromEntries(Object.keys(fields).map((field) => [field, null])), evidence: [],
    }]));
    const input = questions.map(({ id, ask }) => `${id}: ${ask}`).join("\n");
    await session.prompt(`${input}\n\nReturn only a JSON object shaped like this: ${JSON.stringify(format)}. Use uppercase for codes, names and materials, HH:MM for times, and exact document IDs in evidence arrays.`);
    const last = lastAssistant(session.messages);
    if (last?.stopReason !== "stop") throw new Error(`Answer did not finish: ${last?.stopReason ?? "no response"}`);
    return last.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
  } finally {
    session.dispose();
  }
}
