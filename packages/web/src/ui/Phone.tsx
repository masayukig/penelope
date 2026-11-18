// The phone's screen (docs/design/README.md, 4): no header bar; the avatar
// floats at the top, the menu at the top left, the strip of what she is
// doing above the field, and the agent now in a sheet from below.
import { Badge } from "@astryxdesign/core/Badge";
import { BottomSheet } from "@astryxdesign/core/BottomSheet";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { MobileNav } from "@astryxdesign/core/MobileNav";
import { useState } from "react";

import { callText } from "../model/store.ts";
import { AgentAvatar, useAgent } from "./agent.tsx";
import { PlaceBody, type ScreenProps } from "./Desktop.tsx";
import { ChevronUpIcon, MenuIcon } from "./icons.tsx";
import { NoticesButton } from "./Notices.tsx";
import { StatusLabel } from "./Now.tsx";
import { AgentNow } from "./Panel.tsx";
import { type Route, useRoute } from "./route.ts";
import { SubAgentCount } from "./SubAgents.tsx";
import { PlaceItems } from "./places.tsx";
import { Talk } from "./Talk.tsx";
import { words } from "./words.ts";

export function Phone(props: ScreenProps) {
  const agent = useAgent();
  const [route, go] = useRoute();
  // Not counted while she is in the activity record: she sees them there.
  const unseen = route.place === "log" ? 0 : props.unseen;
  const [menu, setMenu] = useState(false);
  const [sheet, setSheet] = useState(false);
  const strip = props.offline ? null : (
    <button type="button" className="status-strip" onClick={() => setSheet(true)} aria-label={words.openSheet}>
      <StatusLabel status={props.status} />
      {props.status.kind === "tool" ? (
        <span className="status-strip-detail">
          {callText(props.status.tool.name, props.status.tool.detail)}
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
        <span className="phone-menu">
          <IconButton icon={<Icon icon={MenuIcon} />} label={unseen > 0 ? words.record.menuLabel(unseen) : words.menu} elevation="low" onClick={() => setMenu(true)} />
          {unseen > 0 ? (
            <span className="phone-menu-count" aria-hidden>
              <Badge variant="error" label={unseen > 99 ? "99+" : String(unseen)} />
            </span>
          ) : null}
        </span>
        <button type="button" className="phone-avatar" aria-label={`${words.openSheet}（${agent.name}）`} onClick={() => setSheet(true)}>
          <AgentAvatar size={72} expression={props.expression} />
        </button>
        <span />
      </div>
      {route.place === "talk" ? <Talk {...props} strip={strip} topInset density="compact" jump={route.reply} /> : <PlaceBody route={route} props={props} topInset />}
      <MobileNav isOpen={menu} onOpenChange={setMenu} header={agent.name} side="start">
        <PlaceItems
          place={route.place}
          unseen={unseen}
          onChange={(place) => {
            go({ place } as Route);
            setMenu(false);
          }}
        />
        <NoticesButton notices={props.notices} />
        <Button label={words.logout} variant="ghost" onClick={props.onLogout} />
      </MobileNav>
      <BottomSheet isOpen={sheet} onOpenChange={setSheet} label={words.panel} height="tall" snapPoints={[0.5]}>
        <AgentNow status={props.status} flow={props.flow} subAgents={props.subAgents} expression={props.expression} avatarSize={96} />
      </BottomSheet>
    </div>
  );
}
