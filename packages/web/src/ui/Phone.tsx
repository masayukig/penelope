// The phone's screen (docs/design/README.md, 4): no header bar; the avatar
// floats at the top, the menu at the top left, the strip of what she is
// doing above the field, and the agent now in a sheet from below.
import { BottomSheet } from "@astryxdesign/core/BottomSheet";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { MobileNav } from "@astryxdesign/core/MobileNav";
import { useState } from "react";

import { AgentAvatar, useAgent } from "./agent.tsx";
import type { ScreenProps } from "./Desktop.tsx";
import { ChevronUpIcon, MenuIcon } from "./icons.tsx";
import { StatusLabel } from "./Now.tsx";
import { AgentNow } from "./Panel.tsx";
import { SubAgentCount } from "./SubAgents.tsx";
import { type Place, PlaceItems, Placeholder } from "./places.tsx";
import { Talk } from "./Talk.tsx";
import { words } from "./words.ts";

export function Phone(props: ScreenProps) {
  const agent = useAgent();
  const [place, setPlace] = useState<Place>("talk");
  const [menu, setMenu] = useState(false);
  const [sheet, setSheet] = useState(false);
  const strip = props.offline ? null : (
    <button type="button" className="status-strip" onClick={() => setSheet(true)} aria-label={words.openSheet}>
      <StatusLabel status={props.status} />
      {props.status.kind === "tool" ? (
        <span className="status-strip-detail">
          {props.status.tool.name}: {props.status.tool.detail}
        </span>
      ) : (
        <span className="status-strip-detail" />
      )}
      <SubAgentCount agents={props.subAgents} />
      <Icon icon={ChevronUpIcon} size="sm" />
    </button>
  );
  return (
    <div className="phone">
      <div className="phone-float">
        <IconButton icon={<Icon icon={MenuIcon} />} label={words.menu} elevation="low" onClick={() => setMenu(true)} />
        <button type="button" className="phone-avatar" aria-label={`${words.openSheet}（${agent.name}）`} onClick={() => setSheet(true)}>
          <AgentAvatar size={72} expression={props.expression} />
        </button>
        <span />
      </div>
      {place === "talk" ? <Talk {...props} strip={strip} topInset density="compact" /> : <Placeholder place={place} />}
      <MobileNav isOpen={menu} onOpenChange={setMenu} header={agent.name} side="start">
        <PlaceItems
          place={place}
          onChange={(next) => {
            setPlace(next);
            setMenu(false);
          }}
        />
        <Button label={words.logout} variant="ghost" onClick={props.onLogout} />
      </MobileNav>
      <BottomSheet isOpen={sheet} onOpenChange={setSheet} label={words.panel} height="tall" snapPoints={[0.5]}>
        <AgentNow status={props.status} flow={props.flow} subAgents={props.subAgents} expression={props.expression} avatarSize={96} />
      </BottomSheet>
    </div>
  );
}
