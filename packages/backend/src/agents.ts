// The sub-agents (ADR-0022, docs/sandbox-api.md "サブエージェントの状態"): the
// last thing the runner said of each, kept so that the UI can list the ones
// that are not closed (docs/ui-api.md "サブエージェント"). The backend has no
// queue for them and does not run them.
import type { DatabaseSync } from "node:sqlite";

import type { AgentState, SubAgent, SubAgentStatus } from "@penelope/contract";

type States = { stateOf: (agent: string) => { state: AgentState; since?: string } };

import type { Feed } from "./feed.ts";
import { iso } from "./time.ts";

export class SubAgents {
  private readonly db: DatabaseSync;
  private readonly feed: Feed;
  private readonly states: States;
  private readonly now: () => number;

  constructor(db: DatabaseSync, feed: Feed, states: States, { now }: { now: () => number }) {
    this.db = db;
    this.feed = feed;
    this.states = states;
    this.now = now;
  }

  /** Keeps what the runner said of a sub-agent in place of what it said before, and sends it down the feed. */
  record(status: SubAgentStatus): void {
    const at = iso(this.now());
    this.db
      .prepare(
        `INSERT INTO sub_agents (agent, purpose, closed, started_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (agent) DO UPDATE SET purpose = excluded.purpose, closed = excluded.closed,
           started_at = coalesce(started_at, excluded.started_at), updated_at = excluded.updated_at`,
      )
      .run(status.agent, status.purpose, status.closed ? 1 : 0, status.closed ? null : at, at);
    this.feed.publish({ event: "agent", data: { agent: status.agent, purpose: status.purpose, closed: status.closed } });
  }

  /**
   * The sub-agents that are not closed, in the order they were first heard
   * of. One that has had no turn waits since it was started.
   */
  list(): SubAgent[] {
    const rows = this.db
      .prepare("SELECT agent, purpose, coalesce(started_at, updated_at) AS started_at FROM sub_agents WHERE closed = 0 ORDER BY rowid")
      .all() as Array<{ agent: string; purpose: string; started_at: string }>;
    return rows.map(({ agent, purpose, started_at }) => {
      const { state, since } = this.states.stateOf(agent);
      return { agent, purpose, state, started_at, state_since: since ?? started_at };
    });
  }
}
