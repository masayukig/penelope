// Moves natsumi's own schedules (schedule_self_check: the pending rows of the
// table self_checks in natsumi's .natsumi/state.sqlite) into penelope's
// (POST /v1/schedules of the sandbox API, docs/sandbox-api.md "予約").
// The steps are in docs/migrate-from-natsumi.md.
//
//   node --no-warnings move-schedules.mjs export <state.sqlite> <out.json>
//       Writes the pending rows as JSON ([{reason, cron}] or [{reason, at}]).
//       Run in the migrate Pod, over natsumi's volume mounted read-only: the
//       database is copied with its WAL into a temporary directory first, and
//       nothing is written next to it.
//   node --no-warnings move-schedules.mjs post <in.json> --past-due skip|now
//       Run in the new Pod's sandbox; puts them in as the main agent's, with
//       PENELOPE_BACKEND_URL and PENELOPE_BACKEND_TOKEN (a surrogate). A
//       one-off whose time has passed is dropped with skip, and put in a
//       minute from now with now; the owner decides, so it cannot be left out.
//       What went in is taken out of the JSON as it goes, so a run that stopped
//       half way, run again, puts in only the rest. The JSON is removed once
//       all of it is in.
//
// The reasons are hers, like her memory: neither stdout nor stderr ever has
// one. Only counts and status codes are printed. The exit code is 0 when all is
// done, 1 when some were refused, and 2 for a wrong use. Nothing but Node (the
// sandbox image's) is needed; --no-warnings keeps node:sqlite's warning that
// it is experimental out of the output.
import { copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const USAGE = 'usage: node move-schedules.mjs export <state.sqlite> <out.json> | post <in.json> --past-due skip|now';

function writeJSON(path, items) {
  const tmp = join(dirname(path), `.schedules.${process.pid}`);
  writeFileSync(tmp, JSON.stringify(items), { mode: 0o600 });
  renameSync(tmp, path);
}

function exportSchedules(database, out) {
  const work = mkdtempSync(join(tmpdir(), 'natsumi-state-'));
  let rows;
  try {
    const copy = join(work, 'state.sqlite');
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(database + suffix)) copyFileSync(database + suffix, copy + suffix);
    }
    const db = new DatabaseSync(copy);
    rows = db.prepare("SELECT reason, cron, due_at FROM self_checks WHERE state = 'pending' ORDER BY due_at, check_id").all();
    db.close();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const items = rows.map((r) => (r.cron !== null ? { reason: r.reason, cron: r.cron } : { reason: r.reason, at: r.due_at }));
  writeJSON(out, items);
  const oneOff = items.filter((i) => 'at' in i);
  const past = oneOff.filter((i) => Date.parse(i.at) <= Date.now());
  console.log(`pending: ${items.length} (repeating: ${items.length - oneOff.length}, one-off: ${oneOff.length}, one-off past due: ${past.length})`);
  return 0;
}

async function request(method, path, body) {
  const url = process.env.PENELOPE_BACKEND_URL.replace(/\/+$/, '') + path;
  try {
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${process.env.PENELOPE_BACKEND_TOKEN}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    return { status: res.status, body: res.ok ? await res.json() : undefined };
  } catch {
    return { status: 0 };
  }
}

async function count() {
  const { status, body } = await request('GET', '/v1/schedules?agent=main');
  return status === 200 ? body.schedules.length : `unknown (${status})`;
}

async function post(path, pastDue) {
  const items = JSON.parse(readFileSync(path, 'utf8'));
  const before = await count();
  const left = [];
  const failed = [];
  let posted = 0;
  let skipped = 0;
  for (const item of items) {
    const body = { agent: 'main', reason: item.reason };
    if ('cron' in item) body.cron = item.cron;
    else if (Date.parse(item.at) > Date.now()) body.at = item.at;
    else if (pastDue === 'skip') {
      skipped++;
      continue;
    } else body.at = new Date(Date.now() + 60_000).toISOString();
    const { status } = await request('POST', '/v1/schedules', body);
    if (status === 201) posted++;
    else {
      failed.push(status);
      left.push(item);
    }
  }
  if (left.length > 0) writeJSON(path, left);
  else rmSync(path);
  console.log(`posted: ${posted}`);
  console.log(`skipped past due: ${skipped}`);
  if (failed.length > 0) console.log(`failed: ${failed.length} (${failed.join(' ')}); left in ${path}`);
  console.log(`schedules before: ${before}, after: ${await count()}`);
  return failed.length > 0 ? 1 : 0;
}

const args = process.argv.slice(2);
let code;
if (args.length === 3 && args[0] === 'export') code = exportSchedules(args[1], args[2]);
else if (args.length === 4 && args[0] === 'post' && args[2] === '--past-due' && ['skip', 'now'].includes(args[3])) {
  code = await post(args[1], args[3]);
} else {
  console.error(USAGE);
  code = 2;
}
process.exitCode = code;
