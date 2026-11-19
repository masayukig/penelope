import { createHash } from "node:crypto";
import { readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import type { TurnResult } from "@penelope/contract";

export interface ExtensionNotice {
  kind: "load_error" | "handler_error" | "memory_extensions_disabled";
  path: string;
  reason: string;
}

interface Snapshot {
  key: string;
  hash?: string;
}

/** Check file metadata on each turn; only rehash memory when something changed. */
async function extensionSnapshot(path: string, previous?: Snapshot, hashContents = false): Promise<Snapshot | undefined> {
  const root = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (!root) return undefined;
  const entries = root.isDirectory() ? await readdir(path, { recursive: true, withFileTypes: true }) : [];
  const files = new Map([[path, root]]);
  for (const entry of entries) {
    const filename = join(entry.parentPath, entry.name);
    const info = await stat(filename).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (info) files.set(filename, info);
  }
  const names = [...files.keys()].sort();
  const key = JSON.stringify(names.map((name) => {
    const { mtimeMs, ctimeMs, size } = files.get(name)!;
    return [name, mtimeMs, ctimeMs, size];
  }));
  if (!hashContents) return { key };
  if (key === previous?.key) return previous;
  const hash = createHash("sha256");
  for (const name of names) {
    if (!files.get(name)!.isFile()) continue;
    const content = await readFile(name);
    hash.update(JSON.stringify([relative(path, name), content.length])).update(content);
  }
  return { key, hash: hash.digest("hex") };
}

interface TrialState {
  good?: string;
  pending?: string;
  rejected: Record<string, string>;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** A pending write precedes evaluation of memory code, so a restart can reject an interrupted trial. */
export class MemoryExtensionTrials {
  private state: TrialState = { rejected: {} };
  private unavailable?: string;
  private readonly file: string;
  private readonly log: (line: string) => void;

  constructor(file: string, log: (line: string) => void) {
    this.file = file;
    this.log = log;
  }

  async restore(): Promise<void> {
    try {
      this.state = JSON.parse(await readFile(this.file, "utf8")) as TrialState;
      if (!this.state?.rejected || typeof this.state.rejected !== "object") throw new Error("Invalid trial state");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.unavailable = `Could not read trial state: ${message(error)}`;
      return;
    }
    if (this.state.pending) await this.reject(this.state.pending, "The runner restarted before the first turn finished.");
  }

  /** Return a reason to omit this revision, or record its trial before it can run. */
  async blockReason(hash: string): Promise<string | undefined> {
    if (this.unavailable) return this.unavailable;
    const reason = this.state.rejected[hash];
    if (reason || hash === this.state.good || hash === this.state.pending) return reason;
    const next = { ...this.state, pending: hash };
    try {
      await this.write(next);
      this.state = next;
      return undefined;
    } catch (error) {
      return `Could not record the trial: ${message(error)}`;
    }
  }

  async finish(hash: string | undefined, result: TurnResult): Promise<string | undefined> {
    if (!hash || hash !== this.state.pending) return undefined;
    if (result !== "done") {
      const reason = `The first turn with this revision ended as ${result}.`;
      await this.reject(hash, reason);
      return reason;
    }
    const { rejected } = this.state;
    await this.settle({ good: hash, rejected });
    return undefined;
  }

  private async reject(hash: string, reason: string): Promise<void> {
    const { pending: _, ...state } = this.state;
    await this.settle({ ...state, rejected: { ...state.rejected, [hash]: reason } });
  }

  private async settle(state: TrialState): Promise<void> {
    this.state = state;
    try {
      await this.write(state);
    } catch (error) {
      // If the pending marker remains on disk, the next startup is conservative.
      this.log(`could not settle the extension trial: ${message(error)}`);
    }
  }

  private async write(state: TrialState): Promise<void> {
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await rename(temporary, this.file);
  }
}

/** The local sources and new diagnostics of one main session. Pi retains the paths array. */
export class SessionExtensions {
  readonly paths: string[] = [];
  private readonly owner?: string;
  private readonly memoryPath: string;
  private readonly trials: MemoryExtensionTrials;
  private readonly log: (line: string) => void;
  private memory: Snapshot | undefined;
  private activeHash: string | undefined;
  private readonly reported = new Set<string>();
  private notes: ExtensionNotice[] = [];

  constructor(owner: string | undefined, memoryPath: string, trials: MemoryExtensionTrials, log: (line: string) => void) {
    this.memoryPath = memoryPath;
    this.trials = trials;
    this.log = log;
    // Pi accepts package sources too; the deployment option is a local mount path only.
    if (owner && isAbsolute(owner)) this.owner = owner;
    else if (owner) this.report("load_error", owner, "The owner extension path must be absolute.");
  }

  async prepare(): Promise<string> {
    const owner = this.owner ? await this.scan(this.owner) : undefined;
    this.memory = await this.scan(this.memoryPath, this.memory, true);
    const hash = this.memory?.hash;
    const blocked = hash ? await this.trials.blockReason(hash) : undefined;
    if (hash && blocked) this.disabled(hash, blocked);
    this.activeHash = blocked ? undefined : hash;
    this.paths.length = 0;
    if (owner && this.owner) this.paths.push(this.owner);
    if (this.activeHash) this.paths.push(this.memoryPath);
    return JSON.stringify([owner?.key, this.activeHash]);
  }

  async finish(result: TurnResult): Promise<void> {
    const hash = this.activeHash;
    const reason = await this.trials.finish(hash, result);
    if (hash && reason) this.disabled(hash, reason);
  }

  report(kind: ExtensionNotice["kind"], path: string, reason: string): void {
    this.log(`extension ${kind}: ${path}: ${reason}`);
    this.notes.push({ kind, path, reason });
  }

  takeNotes(): ExtensionNotice[] {
    const notes = this.notes;
    this.notes = [];
    return notes;
  }

  private disabled(hash: string, reason: string): void {
    if (this.reported.has(hash)) return;
    this.reported.add(hash);
    this.report("memory_extensions_disabled", this.memoryPath, reason);
  }

  private async scan(path: string, previous?: Snapshot, hashContents = false): Promise<Snapshot | undefined> {
    try {
      return await extensionSnapshot(path, previous, hashContents);
    } catch (error) {
      this.report("load_error", path, message(error));
      return undefined;
    }
  }
}
