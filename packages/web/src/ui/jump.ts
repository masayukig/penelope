// Going to one of her replies from the activity record ("会話でこの返事を見る").
import { useEffect, useRef } from "react";

import type { TimelineItem } from "../model/store.ts";

/**
 * Shows the reply the activity record pointed at, once for each pointing:
 * the page of the history that starts with it is read when the timeline
 * does not hold it yet. The pages between are read as she scrolls up.
 */
export function useJump(items: TimelineItem[], jump: { id: string; before: string } | undefined, onJump: ((before: string) => Promise<void>) | undefined) {
  const done = useRef<string | undefined>(undefined);
  const asked = useRef<string | undefined>(undefined);
  const key = jump === undefined ? undefined : `${jump.id}\n${jump.before}`;
  const held = jump !== undefined && items.some((item) => item.id === jump.id);
  const pointed = useRef(jump);
  pointed.current = jump;
  useEffect(() => {
    const jump = pointed.current;
    if (jump === undefined || key === undefined || done.current === key) return;
    if (!held) {
      if (asked.current !== key && onJump !== undefined) {
        asked.current = key;
        void onJump(jump.before).catch(() => {});
      }
      return;
    }
    done.current = key;
    // The list takes its first place at the bottom once it has laid out what
    // it holds, after a frame or more: the reply is put in sight again until
    // the list has settled, for half a second at most.
    let frames = 0;
    let frame = 0;
    const show = () => {
      const element = document.querySelector(`[data-reply="${CSS.escape(jump.id)}"]`);
      element?.scrollIntoView?.({ block: "center" });
      if (frames === 0) element?.closest(".astryx-chat-message")?.setAttribute("data-pointed", "");
      if (++frames < 30) frame = requestAnimationFrame(show);
    };
    frame = requestAnimationFrame(show);
    return () => cancelAnimationFrame(frame);
  }, [key, held, onJump]);
}

