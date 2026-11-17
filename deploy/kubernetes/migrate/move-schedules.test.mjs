// The tool that moves natsumi's own schedules (self_checks) into penelope's
// (docs/migrate-from-natsumi.md). The SQLite is a made-up one in natsumi's
// shape, and the backend a small fake on loopback. What they keep:
// - only the pending schedules move, repeating ones as cron and one-off ones
//   as at;
// - the reasons, which are hers like her memory, never reach the terminal;
// - a run that stopped half way, run again, puts in only what is left.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const TOOL = new URL('./move-schedules.mjs', import.meta.url).pathname;
const TOKEN = 'surrogate-test-0000000000';

// natsumi's self_checks since its migration 25 (src/server/migrations.ts).
function natsumiState(dir) {
  const path = join(dir, 'state.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE self_checks (check_id TEXT PRIMARY KEY, reason TEXT NOT NULL, cron TEXT, due_at TEXT NOT NULL,
      state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;`);
  const insert = db.prepare("INSERT INTO self_checks VALUES (?, ?, ?, ?, ?, 'x', 'x')");
  insert.run('c1', 'SECRET-daily', '0 9 * * *', '2099-01-01T00:00:00.000Z', 'pending');
  insert.run('c2', 'SECRET-later', null, '2099-01-02T03:04:05.000Z', 'pending');
  insert.run('c3', 'SECRET-past', null, '2000-01-01T00:00:00.000Z', 'pending');
  insert.run('c4', 'SECRET-done', null, '2099-01-01T00:00:00.000Z', 'delivered');
  insert.run('c5', 'SECRET-gone', '0 8 * * *', '2099-01-01T00:00:00.000Z', 'cancelled');
  return { path, db };
}

function run(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--no-warnings', TOOL, ...args], { env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, output: stdout + stderr });
    });
  });
}

// A fake backend: keeps the bodies of POST /v1/schedules, and refuses with 500
// every one after the first `accept`.
async function backend(t, { accept = Infinity, posted = [] } = {}) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const reply = (code, value) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { error: 'unauthorized' });
      if (req.method === 'GET') return reply(200, { schedules: posted.map((_, i) => ({ id: String(i) })) });
      if (posted.length >= accept) return reply(500, { error: 'boom' });
      posted.push(JSON.parse(body));
      reply(201, { id: 'x' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = { PENELOPE_BACKEND_URL: `http://127.0.0.1:${server.address().port}`, PENELOPE_BACKEND_TOKEN: TOKEN };
  return { env, posted };
}

const readJSON = (path) => JSON.parse(readFileSync(path, 'utf8'));
const scratch = () => mkdtempSync(join(tmpdir(), 'move-schedules-'));

test('export writes the pending schedules only, repeating ones as cron and one-off ones as at', async () => {
  const dir = scratch();
  const { path, db } = natsumiState(dir);
  db.close();
  const out = join(dir, 'out.json');

  const { code, output } = await run(['export', path, out]);

  assert.equal(code, 0);
  assert.equal(output.trim(), 'pending: 3 (repeating: 1, one-off: 2, one-off past due: 1)');
  assert.deepEqual(readJSON(out), [
    { reason: 'SECRET-past', at: '2000-01-01T00:00:00.000Z' },
    { reason: 'SECRET-daily', cron: '0 9 * * *' },
    { reason: 'SECRET-later', at: '2099-01-02T03:04:05.000Z' },
  ]);
  assert.equal(statSync(out).mode & 0o777, 0o600);
});

// natsumi is stopped right before the copy, so what it wrote last may still be
// in the WAL only.
test('export reads what is still in the WAL', async () => {
  const dir = scratch();
  const { path, db } = natsumiState(dir);
  db.exec('PRAGMA wal_autocheckpoint = 0');
  db.prepare("INSERT INTO self_checks VALUES ('c6', 'SECRET-wal', '*/30 * * * *', '2099-01-01T00:00:00.000Z', 'pending', 'x', 'x')").run();
  // Left open: closing would checkpoint the WAL into the file.
  assert.ok(statSync(`${path}-wal`).size > 0);

  const { output } = await run(['export', path, join(dir, 'out.json')]);

  assert.equal(output.trim(), 'pending: 4 (repeating: 2, one-off: 2, one-off past due: 1)');
  db.close();
});

test('post puts them in as the main agent, drops the past one-off with --past-due skip, and removes the file', async (t) => {
  const dir = scratch();
  const out = join(dir, 'out.json');
  writeFileSync(out, JSON.stringify([
    { reason: 'SECRET-past', at: '2000-01-01T00:00:00.000Z' },
    { reason: 'SECRET-daily', cron: '0 9 * * *' },
    { reason: 'SECRET-later', at: '2099-01-02T03:04:05.000Z' },
  ]));
  const { env, posted } = await backend(t);

  const { code, output } = await run(['post', out, '--past-due', 'skip'], env);

  assert.equal(code, 0);
  assert.equal(output.trim(), 'posted: 2\nskipped past due: 1\nschedules before: 0, after: 2');
  assert.deepEqual(posted, [
    { agent: 'main', reason: 'SECRET-daily', cron: '0 9 * * *' },
    { agent: 'main', reason: 'SECRET-later', at: '2099-01-02T03:04:05.000Z' },
  ]);
  assert.equal(existsSync(out), false);
});

test('post --past-due now puts the past one-off in at a time still to come', async (t) => {
  const dir = scratch();
  const out = join(dir, 'out.json');
  writeFileSync(out, JSON.stringify([{ reason: 'SECRET-past', at: '2000-01-01T00:00:00.000Z' }]));
  const { env, posted } = await backend(t);

  const { code } = await run(['post', out, '--past-due', 'now'], env);

  assert.equal(code, 0);
  assert.equal(posted.length, 1);
  assert.ok(Date.parse(posted[0].at) > Date.now());
});

// What to do with the one-offs that have passed is the owner's to decide.
test('post without --past-due puts nothing in', async (t) => {
  const dir = scratch();
  const out = join(dir, 'out.json');
  writeFileSync(out, JSON.stringify([{ reason: 'SECRET-daily', cron: '0 9 * * *' }]));
  const { env, posted } = await backend(t);

  const { code } = await run(['post', out], env);

  assert.equal(code, 2);
  assert.deepEqual(posted, []);
});

test('post run again after a refusal puts in only what was left', async (t) => {
  const dir = scratch();
  const out = join(dir, 'out.json');
  writeFileSync(out, JSON.stringify([
    { reason: 'SECRET-daily', cron: '0 9 * * *' },
    { reason: 'SECRET-later', at: '2099-01-02T03:04:05.000Z' },
  ]));
  const first = await backend(t, { accept: 1 });

  const refused = await run(['post', out, '--past-due', 'skip'], first.env);

  assert.equal(refused.code, 1);
  assert.match(refused.output, /^failed: 1 \(500\)/m);
  const second = await backend(t);
  await run(['post', out, '--past-due', 'skip'], second.env);
  assert.deepEqual(
    [...first.posted, ...second.posted].map((s) => s.reason),
    ['SECRET-daily', 'SECRET-later'],
  );
});

test('neither export nor a refused post prints a reason or what the backend said', async (t) => {
  const dir = scratch();
  const { path, db } = natsumiState(dir);
  db.close();
  const out = join(dir, 'out.json');
  const { env } = await backend(t, { accept: 0 });

  const exported = await run(['export', path, out]);
  const refused = await run(['post', out, '--past-due', 'now'], env);

  for (const { output } of [exported, refused]) {
    assert.doesNotMatch(output, /SECRET|boom/);
  }
});
