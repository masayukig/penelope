// The owner's login sessions (ADR-0010, docs/backend.md). A token is 256
// random bits and only its SHA-256 is kept, so a copy of the database cannot
// be used as a session.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** A session ends this long after it was last used. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A use within this long of the last renewal writes nothing. */
export const SESSION_RENEW_MS = 60 * 60 * 1000;

/** What a session token looks like; anything else is not looked up. */
export const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export type Session = { sessionId: string; token: string; expiresMs: number };

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export class LoginSessions {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, { now }: { now: () => number }) {
    this.db = db;
    this.now = now;
  }

  create(githubUserId: number): Session {
    const now = this.now();
    const token = randomBytes(32).toString("base64url");
    const sessionId = randomUUID();
    const expiresMs = now + SESSION_TTL_MS;
    this.db.prepare("DELETE FROM login_sessions WHERE expires_ms <= ?").run(now);
    this.db
      .prepare("INSERT INTO login_sessions (session_id, token_hash, github_user_id, created_ms, expires_ms) VALUES (?, ?, ?, ?, ?)")
      .run(sessionId, hash(token), githubUserId, now, expiresMs);
    return { sessionId, token, expiresMs };
  }

  /**
   * The live session of `token` for the owner, its end moved on by this use;
   * undefined when it is unknown, revoked, ended, or not the owner's. With no
   * owner set, there is no session.
   */
  use(token: string, ownerId: number | undefined): Session | undefined {
    if (ownerId === undefined || !TOKEN.test(token)) return undefined;
    const now = this.now();
    const row = this.db
      .prepare("SELECT session_id, github_user_id, expires_ms, revoked_ms FROM login_sessions WHERE token_hash = ?")
      .get(hash(token)) as { session_id: string; github_user_id: number; expires_ms: number; revoked_ms: number | null } | undefined;
    if (!row || row.revoked_ms !== null || row.github_user_id !== ownerId || row.expires_ms <= now) return undefined;
    let expiresMs = row.expires_ms;
    if (expiresMs <= now + SESSION_TTL_MS - SESSION_RENEW_MS) {
      expiresMs = now + SESSION_TTL_MS;
      this.db.prepare("UPDATE login_sessions SET expires_ms = ? WHERE session_id = ?").run(expiresMs, row.session_id);
    }
    return { sessionId: row.session_id, token, expiresMs };
  }

  revoke(token: string): void {
    this.db.prepare("UPDATE login_sessions SET revoked_ms = ? WHERE token_hash = ? AND revoked_ms IS NULL").run(this.now(), hash(token));
  }
}
