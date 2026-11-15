// Who sent an A2A call (ADR-0010, ADR-0018, docs/a2a.md): a check of the
// call's headers says which ServiceAccount it is, and the allow-list, shared by
// every check, says whether that one is a sender and by what name.
import type http from "node:http";

import { SEGMENT } from "../envelope.ts";

/**
 * What one check makes of a call: the ServiceAccount it is
 * (`system:serviceaccount:<namespace>:<name>`), refused, or no answer to be had
 * (the API server or gated's keys out of reach). Only the first lets it in.
 */
export type Verdict = { kind: "subject"; subject: string } | { kind: "refused"; reason: string } | { kind: "unavailable"; reason: string };

/** Who a call is from: a sender by name, or not let in, and why (for the log, never the caller). */
export type Who = { kind: "sender"; name: string } | { kind: "refused"; reason: string } | { kind: "unavailable"; reason: string };

/**
 * One way of checking a sender, chosen by the settings. A call is decided by
 * the check whose header it carries; when it carries more than one, by the
 * check with the lowest `precedence`.
 */
export interface SenderCheck {
  readonly name: string;
  readonly precedence: number;
  carries(headers: http.IncomingHttpHeaders): boolean;
  check(headers: http.IncomingHttpHeaders): Promise<Verdict>;
}

const PREFIX = "system:serviceaccount:";

/**
 * The allow-list: ServiceAccounts as `<namespace>/<name>`. A sender is named
 * by its ServiceAccount's name, which is its stream under /sources/a2a/, so
 * no two may share one.
 */
export class Senders {
  private readonly bySubject = new Map<string, string>();

  constructor(entries: readonly string[]) {
    const names = new Set<string>();
    for (const entry of entries) {
      const match = /^([a-z0-9][a-z0-9-]*)\/([^/]+)$/.exec(entry);
      if (!match) throw new Error(`a sender is <namespace>/<name> of its ServiceAccount, not ${JSON.stringify(entry)}`);
      const [, namespace, name] = match as unknown as [string, string, string];
      if (!SEGMENT.test(name)) throw new Error(`the ServiceAccount name ${JSON.stringify(name)} cannot name a sender`);
      if (names.has(name)) throw new Error(`the name ${name} is there twice: a sender is known by its ServiceAccount's name`);
      names.add(name);
      this.bySubject.set(`${PREFIX}${namespace}:${name}`, name);
    }
  }

  get size(): number {
    return this.bySubject.size;
  }

  /** The sender's name of a ServiceAccount, or undefined when it is not on the list. */
  nameOf(subject: string): string | undefined {
    return this.bySubject.get(subject);
  }
}

/** Who a call is from, by the check whose header it carries. No check, no sender. */
export async function whoIs(checks: readonly SenderCheck[], senders: Senders, headers: http.IncomingHttpHeaders): Promise<Who> {
  const check = [...checks].sort((a, b) => a.precedence - b.precedence).find((each) => each.carries(headers));
  if (check === undefined) return { kind: "refused", reason: "no credential any check reads" };
  const verdict = await check.check(headers);
  if (verdict.kind !== "subject") return { ...verdict, reason: `${check.name}: ${verdict.reason}` };
  const name = senders.nameOf(verdict.subject);
  return name === undefined ? { kind: "refused", reason: `${check.name}: ${verdict.subject} is not a sender` } : { kind: "sender", name };
}

/** The token of `Authorization: Bearer <token>`, or undefined. */
export function bearerOf(headers: http.IncomingHttpHeaders): string | undefined {
  return /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(headers.authorization ?? "")?.[1];
}
