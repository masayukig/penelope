// A consistent copy of the backend's SQLite (PENELOPE_DATABASE), taken
// without stopping the backend, with SQLite's online backup (what sqlite3's
// .backup does). Copying the file as it is can lose what is half written or
// still in the WAL.
//
//   node sqlite-backup.mjs <source> <destination>
import { backup, DatabaseSync } from 'node:sqlite';
import { rename } from 'node:fs/promises';

const [source, destination] = process.argv.slice(2);
if (!source || !destination) {
  console.error('usage: node sqlite-backup.mjs <source> <destination>');
  process.exit(2);
}

// Wait for the backend's lock rather than fail.
const db = new DatabaseSync(source, { timeout: 30000 });
try {
  const partial = `${destination}.partial`;
  const pages = await backup(db, partial);
  // The copy is in WAL mode like the source; turn it back into one file, and
  // check it before giving it the final name.
  const check = new DatabaseSync(partial);
  check.exec('PRAGMA journal_mode = DELETE');
  const [{ integrity_check: integrity }] = check.prepare('PRAGMA integrity_check').all();
  const { user_version: version } = check.prepare('PRAGMA user_version').get();
  check.close();
  if (integrity !== 'ok') throw new Error(`integrity_check: ${integrity}`);
  await rename(partial, destination);
  console.log(`sqlite backup: ${pages} pages, user_version ${version}, integrity ok -> ${destination}`);
} finally {
  db.close();
}
