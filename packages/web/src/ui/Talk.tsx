// The conversation: the timeline above, the field to write in docked below.
import { ChatLayout } from "@astryxdesign/core/Chat";
import type { ReactNode } from "react";

import type { TimelineItem } from "../model/store.ts";
import { Composer } from "./Composer.tsx";
import { EmptyTimeline, Timeline } from "./Timeline.tsx";

export type TalkProps = {
  items: TimelineItem[];
  busy: boolean;
  offline: boolean;
  onSend: (text: string, files: File[]) => void;
  onOlder: (() => Promise<void>) | undefined;
  strip?: ReactNode;
};

export function Talk({ items, busy, offline, onSend, onOlder, strip }: TalkProps) {
  return (
    <div className="talk">
      <ChatLayout density="spacious" composer={<Composer offline={offline} strip={strip} onSend={onSend} />} emptyState={<EmptyTimeline />}>
        {items.length > 0 || busy ? <Timeline items={items} busy={busy} onOlder={onOlder} /> : null}
      </ChatLayout>
    </div>
  );
}
