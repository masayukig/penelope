// The Web UI against a stand-in for the backend (dev/mock.ts), for working on
// the screens without a cluster, a backend or a login: `npm run dev`, then
// open the address it prints. ?scene=<name> picks the made-up world
// (dev/scenes.ts).
//
// It builds as `npm run build` does, but unminified and with React's
// development build, and builds again when src/ or public/ changes. The open
// pages are told to reload through a stream of their own, from a script put
// into index.html as it is served: the built index.html never has it.
import { existsSync, readFileSync, watch } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

import { buildUi } from "./build.ts";
import { handle, pageScene } from "./dev/mock.ts";
import { scenes } from "./dev/scenes.ts";

const here = import.meta.dirname;
const dist = path.join(here, "dist");
const port = Number(process.env.PORT ?? 5173);
const RELOAD = "/__dev/reload";
const RELOADER = `<script>new EventSource("${RELOAD}").addEventListener("reload", () => location.reload());</script>`;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const pages = new Set<import("node:http").ServerResponse>();

async function rebuild(): Promise<boolean> {
  const started = Date.now();
  try {
    await buildUi(dist, { minify: false, nodeEnv: "development" });
  } catch (error) {
    // esbuild has printed what is wrong; the pages keep what they have.
    console.error(`build failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    return false;
  }
  console.log(`built in ${Date.now() - started} ms`);
  return true;
}

await rebuild();

// Saving a file often writes it more than once: build once for the lot.
let pending: NodeJS.Timeout | undefined;
let building = Promise.resolve();
for (const dir of ["src", "public"]) {
  watch(path.join(here, dir), { recursive: true }, () => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      building = building.then(async () => {
        if (await rebuild()) for (const page of pages) page.write("event: reload\ndata: \n\n");
      });
    }, 100);
  });
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://dev");
  void (async () => {
    if (url.pathname === RELOAD) {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write(":\n\n");
      pages.add(response);
      response.on("close", () => pages.delete(response));
      return;
    }
    if (await handle(request, response, url)) return;
    const file = path.join(dist, path.normalize(decodeURIComponent(url.pathname)));
    // What the backend serves for any other path: the page itself (docs/ui-api.md).
    if (url.pathname === "/" || !file.startsWith(`${dist}${path.sep}`) || !existsSync(file) || file.endsWith(".html")) {
      const page = readFileSync(path.join(dist, "index.html"), "utf8").replace("</body>", `${RELOADER}\n  </body>`);
      response.writeHead(200, { "content-type": TYPES[".html"]!, "cache-control": "no-store", ...pageScene(url) });
      response.end(page);
      return;
    }
    response.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    response.end(readFileSync(file));
  })().catch((error: unknown) => {
    console.error(error);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});

server.listen(port, "127.0.0.1", () => {
  const origin = `http://127.0.0.1:${port}`;
  console.log(`\nThe Web UI over the mock backend: ${origin}/\n\nScenes (open ${origin}/?scene=<name>; kept per browser until another is picked):`);
  for (const [name, { about }] of Object.entries(scenes)) console.log(`  ${name.padEnd(10)} ${about}`);
  console.log("");
});
