// The sub-agents the main agent started, one frame each, in the order they
// were started (docs/design/README.md, 11). A frame shows the latest line of
// its turn and opens, in place, to the whole of it; one at a time. Nothing
// here acts on them: the owner only looks.
import { Badge } from "@astryxdesign/core/Badge";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Icon } from "@astryxdesign/core/Icon";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { useState } from "react";

import type { SubAgentView } from "../model/store.ts";
import { PauseIcon } from "./icons.tsx";
import { FlowLine } from "./Now.tsx";
import { Dots } from "./Timeline.tsx";
import { sinceOf, subAgentWord, subCountWord, words } from "./words.ts";

export function SubAgents({ agents }: { agents: SubAgentView[] }) {
  const [openName, setOpenName] = useState<string | undefined>(undefined);
  if (agents.length === 0) return null;
  const waiting = agents.filter((a) => a.status.kind === "waiting").length;
  return (
    <section className="subs" aria-label={words.subAgents}>
      <div className="subs-head">
        <h2>{words.subAgents}</h2>
        <span>{subCountWord(agents.length - waiting, waiting)}</span>
      </div>
      <ul className="subs-list">
        {agents.map((agent) => (
          <li key={agent.agent} className="sub">
            <Collapsible
              isOpen={openName === agent.agent}
              onOpenChange={(open) => setOpenName(open ? agent.agent : undefined)}
              trigger={<SubAgentHead agent={agent} open={openName === agent.agent} />}
            >
              <SubAgentFlow agent={agent} />
            </Collapsible>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Its purpose is cut to one line while closed, and shown in full once opened. */
function SubAgentHead({ agent, open }: { agent: SubAgentView; open: boolean }) {
  const running = agent.status.kind !== "waiting";
  const word = subAgentWord(agent.status);
  return (
    <span className="sub-head">
      <span className="sub-line">
        {running ? <StatusDot variant="accent" label={word} /> : <Icon icon={PauseIcon} size="sm" />}
        <span className="sub-name">{agent.agent}</span>
        <span className="sub-state">{word}</span>
      </span>
      <span className={open ? "sub-purpose open" : "sub-purpose"}>{agent.purpose}</span>
      {running ? (
        agent.latest ? (
          <span className="sub-latest">{agent.latest.kind === "tool_call" ? agent.latest.text : `${agent.latest.kind === "thinking" ? words.thought : words.message}: ${agent.latest.text}`}</span>
        ) : null
      ) : (
        <span className="sub-since">{sinceOf(agent.stateSince)}</span>
      )}
    </span>
  );
}

function SubAgentFlow({ agent }: { agent: SubAgentView }) {
  // A waiting one has no turn under way: its frame holds only what its head says.
  if (agent.status.kind === "waiting") return null;
  return (
    <ol className="flow sub-flow">
      {agent.flow.map((item, index) => (
        <FlowLine key={index} item={item} all={agent.flow} />
      ))}
      <li className="flow-block">
        <Dots label={words.writingDots} />
      </li>
    </ol>
  );
}

/** The count of the sub-agents, running and waiting, for where the panel is closed. None when there are none. */
export function SubAgentCount({ agents }: { agents: SubAgentView[] }) {
  if (agents.length === 0) return null;
  return (
    <span className="sub-count">
      <Badge label={words.subCount(agents.length)} />
    </span>
  );
}
