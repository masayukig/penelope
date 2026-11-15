// "The agent now": her avatar and face, what waits for the owner's answer,
// the sub-agents she started, and what she is doing. The right panel on a PC, the sheet on a phone
// (docs/design/README.md, 3 and 4).
import type { FlowItem, Status, SubAgentView } from "../model/store.ts";
import { AgentAvatar, type AvatarSize } from "./agent.tsx";
import { Now } from "./Now.tsx";
import { SubAgents } from "./SubAgents.tsx";
import { words } from "./words.ts";

export type AgentNowProps = { status: Status; flow: FlowItem[]; subAgents: SubAgentView[]; expression: string | undefined; avatarSize: AvatarSize };

export function AgentNow({ status, flow, subAgents, expression, avatarSize }: AgentNowProps) {
  return (
    <div className="agent-now">
      <div className="stage">
        <AgentAvatar size={avatarSize} expression={expression} />
      </div>
      {/* Approvals come in a later wave (ADR-0005); this is their place. */}
      <section className="approvals" aria-label={words.approvals}>
        <h2>{words.approvals}</h2>
        <p className="muted">{words.approvalsNone}</p>
      </section>
      {/* Above the main agent's now, whose flow grows downwards. */}
      <SubAgents agents={subAgents} />
      <Now status={status} flow={flow} />
    </div>
  );
}
