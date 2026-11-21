// ADR-0048: send and wait in the same runner job, using the image's a2a-cli.
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";

const usage = `Usage: ask-agent <name> '<message>' [--image <path>]...
       ask-agent <name> --task <id> '<answer>' [--image <path>]...
       ask-agent <name> --wait <id>`;
const quote = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`;
const jobStart = (args: string[], cwd?: string) =>
  `job_start ${JSON.stringify({ command: ["ask-agent", ...args.map(quote)].join(" "), ...(cwd ? { cwd } : {}) })}`;
const validId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_][A-Za-z0-9._-]{0,199}$/.test(id);
const oneLine = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, " ");

function request([name, first, ...rest]: string[]) {
  if (!name || !first) return;
  const taskId = first === "--task" || first === "--wait" ? rest.shift() : undefined;
  if ((first === "--task" || first === "--wait") && !validId(taskId)) return;
  const text = first === "--wait" ? undefined : first === "--task" ? rest.shift() : first;
  if (first === "--wait" ? rest.length !== 0 : !text?.trim() || rest.length % 2 !== 0 || rest.length > 8) return;
  const images: string[] = [];
  for (let i = 0; i < rest.length; i += 2) {
    const image = rest[i + 1];
    if (rest[i] !== "--image" || !image || /^[a-z][a-z0-9+.-]*:\/\//i.test(image)) return;
    images.push(resolve(image));
  }
  return { name, taskId, text, images };
}

type Entry = Partial<Record<"name" | "label" | "url" | "token", unknown>>;

async function destinations(dir: string) {
  const entries: Entry[] = [];
  let incomplete = false;
  for (const file of (await readdir(dir)).sort()) {
    if (file.startsWith(".") || !file.endsWith(".md")) continue;
    try {
      const path = join(dir, file);
      if (!(await stat(path)).isFile()) continue;
      const source = await readFile(path, "utf8");
      if (!/^---[ \t]*\r?\n/.test(source)) continue;
      const header = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*\r?$/m.exec(source);
      if (!header) throw new Error();
      const data = parse(header[1]!);
      if (data?.a2a === undefined) continue;
      if (!Array.isArray(data.a2a)) throw new Error();
      for (const entry of data.a2a) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) incomplete = true;
        else entries.push(entry);
      }
    } catch {
      incomplete = true;
    }
  }
  return { entries, incomplete };
}

function agentUrl(raw: unknown) {
  if (typeof raw !== "string" || !/^https?:\/\//i.test(raw)) return;
  const url = URL.parse(raw);
  if (!url || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return;
  return url.href;
}

function envToken(key: unknown) {
  if (typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return;
  const value = process.env[key];
  return value && /^[a-zA-Z0-9._~+\/-]+=*$/.test(value) ? value : undefined;
}

type Parts = { parts?: { text?: string }[] };
type Task = { id?: string; status?: { state?: string; message?: Parts }; artifacts?: Parts[] };
type Event = { task?: Task; error?: { message?: string }; message?: Parts };
const textOf = (message?: Parts) => message?.parts?.map((part) => part.text).filter(Boolean).join("\n") ?? "";

function callA2a(args: string[], auth: string[], cwd: string) {
  // Private cwd and HOME keep a2a's discovered config and credential helpers
  // from changing the selected destination or auth. Keep the network settings.
  const env: NodeJS.ProcessEnv = { HOME: cwd };
  for (const key of ["PATH", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"]) {
    env[key] = process.env[key];
  }
  const result = spawnSync("a2a", [...args.slice(0, -1), ...auth, "--", args.at(-1)!], {
    cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  let event: Event | undefined;
  try { event = JSON.parse(result.stdout ?? ""); } catch { /* No structured response. */ }
  return {
    event,
    code: result.status ?? 1,
    problem: result.error ? "Could not run a2a or read its result." : event?.error?.message ?? `a2a exited with code ${result.status ?? 1}.`,
  };
}

async function directory(path: string) {
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  // Reject symlinks; a2a gets a fresh, empty child to avoid overwriting existing files.
  if (!(await lstat(path)).isDirectory()) throw new Error("Not a directory");
  return path;
}

async function main(args: string[]) {
  const req = request(args);
  if (!req) { console.error(usage); return 2; }
  if (!process.env.PENELOPE_JOB_ID) {
    console.log(`ask-agent must run in a background job. Use:\n${jobStart(args, process.cwd())}`);
    return 2;
  }
  const dir = process.env.PENELOPE_CONNECTORS_DIR || "/etc/penelope/connectors";
  const { entries, incomplete } = await destinations(dir).catch(() => ({ entries: [], incomplete: true }));
  const matches = entries.filter((entry) => entry.name === req.name || entry.label === req.name);
  const entry = matches.length === 1 ? matches[0] : undefined;
  const token = envToken(entry?.token);
  const url = agentUrl(entry?.url);
  if (incomplete || !entry || typeof entry.name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(entry.name)
      || typeof entry.label !== "string" || !entry.label.trim() || entry.label.length > 100 || !token || !url) {
    const names = entries.map(({ name }) => typeof name === "string" ? oneLine(name) : "").filter(Boolean);
    console.error(`No request sent: ${incomplete ? "could not read all A2A connector settings" : matches.length > 1 ? "agent name is ambiguous" : "agent is not configured with a name, label, URL and token"}. Candidates: ${names.join(", ") || "(none)"}`);
    return 2;
  }
  for (const path of req.images) {
    if (!(await stat(path).catch(() => undefined))?.isFile()) {
      console.error("No request sent: each --image must be a local file.");
      return 2;
    }
  }

  const { name, label } = entry;
  const emit = (text: string) => console.log(text.replaceAll(token, "[redacted]"));
  let id = req.taskId;
  function report(state: string, reply = "", files: string[] = [], reason?: string, next?: string) {
    emit(`Reply:\n${reply || "(none)"}\nAgent: ${oneLine(label)} (${name})\nState: ${state}\nTask ID: ${id ?? "(none)"}\nImages: ${JSON.stringify(files)}`);
    if (reason) emit(`Reason: ${oneLine(reason).slice(0, 600)}`);
    if (next) emit(`Next: ${next}`);
  }

  const cwd = await mkdtemp(join(tmpdir(), "ask-agent-"));
  const auth = ["-a", url, "--auth", `Bearer ${token}`, "--output", "json"];
  try {
    // The CLI looks for .env in parent directories if the working directory has none.
    await writeFile(join(cwd, ".env"), "");
    if (req.text !== undefined) {
      const sent = callA2a(["send", "--async", ...(id ? ["--task-id", id] : []), ...req.images.flatMap((path) => ["--file-part", path]), req.text], auth, cwd);
      if (sent.code !== 0) { report("error", "", [], sent.problem); return 1; }
      const received = sent.event?.task?.id;
      if (!validId(received) || (id && id !== received)) {
        report("error", textOf(sent.event?.message), [], "Send did not return the expected Task ID; no retry was made.");
        return 1;
      }
      id = received;
    }
    if (!id) throw new Error("Missing Task ID");
    // Leave the ID in the job log even if the runner stops us before a2a times out.
    emit(`Waiting for ${name}, Task ID: ${id}`);
    const waitAgain = jobStart([name, "--wait", id]);
    let filesDir: string;
    try {
      const root = await directory(join(homedir(), "a2a"));
      filesDir = await mkdtemp(join(await directory(join(root, id)), "result-"));
    } catch {
      report("error", "", [], "Could not create the Task's image directory under HOME.");
      return 1;
    }
    const got = callA2a(["task", "get", "--wait", "--poll-interval", "30s", "--timeout", "2h", "--save-fileparts", filesDir, id], auth, cwd);
    const files = (await readdir(filesDir)).sort().map((file) => join(filesDir, file));
    if (!files.length) await rm(filesDir, { recursive: true });
    if (got.code === 5) { report("timed-out", "", files, "The remote Task was not canceled.", waitAgain); return 5; }
    if (got.code !== 0) { report("error", "", files, got.problem); return 1; }

    const task = got.event?.task;
    const state = task?.id === id ? task?.status?.state?.replace(/^TASK_STATE_/, "").toLowerCase().replaceAll("_", "-") : undefined;
    const reply = [textOf(task?.status?.message), ...(task?.artifacts ?? []).map(textOf)].filter(Boolean).join("\n");
    switch (state) {
      case "input-required": report(state, reply, files, undefined, jobStart([name, "--task", id, "<answer>"])); return 0;
      case "completed": report(state, reply, files); return 0;
      case "failed": case "rejected": case "canceled": case "auth-required":
        report(state, reply, files, textOf(task?.status?.message) || `The remote Task is ${state}.`);
        return 1;
      default: report("error", "", files, "GetTask did not return the expected Task in a terminal or interrupted state."); return 1;
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch {
  // Don't dump exceptions that could contain command arguments or a remote response.
  console.error("ask-agent could not finish. Check the job log for a Task ID before sending again.");
  process.exitCode = 1;
}
