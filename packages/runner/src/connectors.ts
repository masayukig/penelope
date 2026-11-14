// The connectors' documents (ADR-0020, docs/sentinel-config.md "コネクタの文書").
// The deployment puts one <name>.md for each connector into a directory; the
// runner lists their front matter in her system prompt, and she reads the
// rest when she needs it.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface Connector {
  name: string;
  description: string;
  /** The names of the Sentinel's registrations it uses. */
  hosts: string[];
  /** Its document. */
  path: string;
}

export interface Skipped {
  path: string;
  reason: string;
}

/** The connectors in `dir`, by name. A directory that is not there has none. */
export async function readConnectors(dir: string): Promise<{ connectors: Connector[]; skipped: Skipped[] }> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { connectors: [], skipped: [] };
  }
  const connectors: Connector[] = [];
  const skipped: Skipped[] = [];
  for (const file of names.sort()) {
    if (file.startsWith(".") || !file.endsWith(".md")) continue;
    const path = join(dir, file);
    try {
      if (!(await stat(path)).isFile()) continue;
    } catch {
      continue;
    }
    const read = await connector(path, file.slice(0, -".md".length));
    if ("reason" in read) skipped.push(read);
    else connectors.push(read);
  }
  return { connectors, skipped };
}

async function connector(path: string, expected: string): Promise<Connector | Skipped> {
  let frontmatter: Record<string, unknown>;
  try {
    ({ frontmatter } = parseFrontmatter<Record<string, unknown>>(await readFile(path, "utf8")));
  } catch (error) {
    return { path, reason: `cannot be read: ${(error as Error).message}` };
  }
  const { name, description, hosts } = frontmatter;
  if (typeof name !== "string" || name === "") return { path, reason: "has no name in its front matter" };
  if (name !== expected) return { path, reason: `is named ${name}, not ${expected} as its file is` };
  if (typeof description !== "string" || description.trim() === "") return { path, reason: "has no description in its front matter" };
  if (!Array.isArray(hosts) || hosts.length === 0 || !hosts.every((host) => typeof host === "string" && host !== "")) {
    return { path, reason: "has no hosts, a list of host names, in its front matter" };
  }
  return { name, description: description.trim(), hosts, path };
}
