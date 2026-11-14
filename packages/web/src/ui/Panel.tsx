// "The agent now": her avatar and face, what waits for the owner's answer,
// and what she is doing. The right panel on a PC, the sheet on a phone
// (docs/design/README.md, 3 and 4).
import type { FlowItem, Status } from "../model/store.ts";
import { AgentAvatar, type AvatarSize } from "./agent.tsx";
import { Now } from "./Now.tsx";
import { words } from "./words.ts";

export function AgentNow({ status, flow, expression, avatarSize }: { status: Status; flow: FlowItem[]; expression: string | undefined; avatarSize: AvatarSize }) {
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
      <Now status={status} flow={flow} />
    </div>
  );
}
