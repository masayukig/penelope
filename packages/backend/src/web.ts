// The Web UI's files (packages/web, built into its dist/) and the manifest
// that puts it on a home screen. Served for every path outside /api/ and
// /auth/ (docs/ui-api.md). The manifest is written here rather than built,
// because the name on the home screen is the deployment's (ADR-0001).
import { readFile } from "node:fs/promises";
import path from "node:path";

import { ICON_TYPES } from "@penelope/avatar";

import type { AgentSettings } from "./avatar.ts";
import { type Handler, sendError } from "./http.ts";

/** Where each face of the avatar is served, by expression (docs/ui-api.md). */
export const AGENT_ICONS_PATH = "/api/agent/icons/";
/** The face the home screen shows. */
const HOME_FACE = "neutral";
/** The icon the build carries, for when the settings have none. */
const BUILT_ICON = "/icon.svg";

const TYPES: Readonly<Record<string, string>> = {
  ...ICON_TYPES,
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export function webHandler({ dir, agent }: { dir: string; agent: () => AgentSettings }): Handler {
  const root = path.resolve(dir);
  return async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendError(response, 405, "only GET");
      return;
    }
    const { pathname } = new URL(request.url ?? "/", "http://ui");
    if (pathname === "/manifest.webmanifest") {
      const body = JSON.stringify(manifestOf(agent()));
      response.writeHead(200, { "content-type": "application/manifest+json", "cache-control": "no-cache" });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }

    let relative: string;
    try {
      relative = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
    } catch {
      sendError(response, 400, "the path is not well formed");
      return;
    }
    const file = path.resolve(root, `.${relative}`);
    if (!file.startsWith(`${root}${path.sep}`)) {
      sendError(response, 404, "no such file");
      return;
    }
    let body: Buffer;
    try {
      body = await readFile(file);
    } catch {
      sendError(response, 404, "no such file");
      return;
    }
    response.writeHead(200, {
      "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "content-length": body.length,
      // The build names what is under assets/ by its content, so it never changes.
      "cache-control": relative.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  };
}

function manifestOf(agent: AgentSettings) {
  const face = agent.icons[HOME_FACE] === undefined ? Object.keys(agent.icons)[0] : HOME_FACE;
  const file = face === undefined ? undefined : agent.icons[face];
  const icon =
    face === undefined || file === undefined
      ? { src: BUILT_ICON, type: "image/svg+xml", sizes: "any" }
      : { src: `${AGENT_ICONS_PATH}${face}`, type: ICON_TYPES[path.extname(file).toLowerCase()], sizes: "any" };
  return {
    name: agent.name,
    short_name: agent.name,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f1f1f1",
    theme_color: "#f1f1f1",
    icons: [icon],
  };
}
