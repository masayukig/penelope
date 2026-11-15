// The PC's screen (docs/design/README.md, 3): the places on the left, the
// conversation in the middle, the agent now on the right.
import { AppShell } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Layout, LayoutPanel } from "@astryxdesign/core/Layout";
import { SideNav } from "@astryxdesign/core/SideNav";
import { useState } from "react";

import type { FlowItem, Status, SubAgentView } from "../model/store.ts";
import { AgentAvatar, useAgent } from "./agent.tsx";
import { StatusLabel } from "./Now.tsx";
import { LogoutIcon } from "./icons.tsx";
import { AgentNow } from "./Panel.tsx";
import { SubAgentCount } from "./SubAgents.tsx";
import { type Place, PlaceItems, Placeholder } from "./places.tsx";
import { Talk, type TalkProps } from "./Talk.tsx";
import { words } from "./words.ts";

export type ScreenProps = TalkProps & { status: Status; flow: FlowItem[]; subAgents: SubAgentView[]; expression: string | undefined; onLogout: () => void };

export function Desktop(props: ScreenProps) {
  const agent = useAgent();
  const [place, setPlace] = useState<Place>("talk");
  const [open, setOpen] = useState(true);
  // The rail starts folded to its icons, to leave the width to the conversation.
  const [folded, setFolded] = useState(true);
  const logout = folded ? (
    <IconButton icon={<Icon icon={LogoutIcon} />} label={words.logout} variant="ghost" size="sm" onClick={props.onLogout} />
  ) : (
    <Button label={words.logout} variant="ghost" size="sm" onClick={props.onLogout} />
  );
  const nav = (
    <SideNav aria-label="場所" collapsible={{ isCollapsed: folded, onCollapsedChange: setFolded }} footer={logout}>
      <PlaceItems place={place} onChange={setPlace} />
    </SideNav>
  );
  const main = (
    <div className="desktop-main">
      <header className="desktop-header">
        <button type="button" className="agent-toggle" aria-expanded={open} aria-label={words.togglePanel} onClick={() => setOpen(!open)}>
          <StatusLabel status={props.status} />
          {/* Where the panel would show them. */}
          {open ? null : <SubAgentCount agents={props.subAgents} />}
          <span className="agent-toggle-name">{agent.name}</span>
          <AgentAvatar size={36} expression={props.expression} />
        </button>
      </header>
      {place === "talk" ? <Talk {...props} /> : <Placeholder place={place} />}
    </div>
  );
  return (
    <AppShell sideNav={nav} mobileNav={false}>
      <Layout
        content={main}
        end={
          open ? (
            <LayoutPanel label={words.panel} role="complementary" width={400} hasDivider>
              <AgentNow status={props.status} flow={props.flow} subAgents={props.subAgents} expression={props.expression} avatarSize={128} />
            </LayoutPanel>
          ) : null
        }
      />
    </AppShell>
  );
}
