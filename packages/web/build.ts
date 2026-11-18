// Builds the Web UI into dist/: index.html, icon.svg and the service worker
// (sw.js) at the top, and the script and styles under assets/, named by their
// content so that they can be cached for good (the backend serves them,
// docs/ui-api.md). The service worker keeps its name: the browser finds it
// by it, and checks it again on each visit.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { build } from "esbuild";

const here = import.meta.dirname;

/**
 * How a build differs: `npm run build` makes what the backend serves; the
 * development server (dev.ts) skips the minifying, so that a rebuild is quick
 * and React's warnings are left in.
 */
export type BuildOptions = { minify: boolean; nodeEnv: "production" | "development" };

export async function buildUi(dist: string, { minify, nodeEnv }: BuildOptions): Promise<void> {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });

  const result = await build({
    entryPoints: [path.join(here, "src/main.tsx")],
    bundle: true,
    format: "esm",
    target: "es2022",
    jsx: "automatic",
    minify,
    sourcemap: true,
    outdir: path.join(dist, "assets"),
    entryNames: "app-[hash]",
    assetNames: "[name]-[hash]",
    loader: { ".woff": "file", ".woff2": "file", ".svg": "file", ".png": "file" },
    define: { "process.env.NODE_ENV": JSON.stringify(nodeEnv) },
    metafile: true,
    logLevel: "warning",
  });

  const outputs = Object.keys(result.metafile.outputs).map((file) => path.basename(file));
  const js = outputs.find((file) => file.startsWith("app-") && file.endsWith(".js"));
  const css = outputs.find((file) => file.startsWith("app-") && file.endsWith(".css"));
  if (!js || !css) throw new Error(`the build made no script or no styles: ${outputs.join(", ")}`);

  const page = readFileSync(path.join(here, "public/index.html"), "utf8").replace("{{js}}", js).replace("{{css}}", css);
  writeFileSync(path.join(dist, "index.html"), page);
  copyFileSync(path.join(here, "public/icon.svg"), path.join(dist, "icon.svg"));

  await build({
    entryPoints: [path.join(here, "src/sw.ts")],
    bundle: true,
    // A classic script: registered without type "module", which older Safari does not take.
    format: "iife",
    target: "es2022",
    minify,
    outfile: path.join(dist, "sw.js"),
    logLevel: "warning",
  });
}

if (import.meta.main) await buildUi(path.join(here, "dist"), { minify: true, nodeEnv: "production" });
