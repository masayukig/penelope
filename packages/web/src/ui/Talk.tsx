// The conversation: the timeline above, the field to write in docked below.
// Files dragged onto any of it go into the field's attachments, as if chosen
// with its button (docs/design/README.md, 14).
import { ChatLayout } from "@astryxdesign/core/Chat";
import { Icon } from "@astryxdesign/core/Icon";
import { type DragEvent, type ReactNode, useEffect, useRef, useState } from "react";

import type { TimelineItem } from "../model/store.ts";
import { Composer } from "./Composer.tsx";
import { AttachIcon } from "./icons.tsx";
import { EmptyTimeline, Timeline } from "./Timeline.tsx";
import { words } from "./words.ts";

export type TalkProps = {
  items: TimelineItem[];
  busy: boolean;
  offline: boolean;
  onSend: (text: string, files: File[]) => void;
  onOlder: (() => Promise<void>) | undefined;
  strip?: ReactNode;
  /** Room at the top of the timeline for what floats over it (the phone's avatar). */
  topInset?: boolean;
  /** How tight the timeline is: the phone's narrow screen takes compact. */
  density?: "compact" | "spacious";
};

export function Talk({ items, busy, offline, onSend, onOlder, strip, topInset = false, density = "spacious" }: TalkProps) {
  const [files, setFiles] = useState<File[]>([]);
  const add = (more: File[]) => setFiles((list) => [...list, ...more]);
  const drop = useFileDrop(add);
  return (
    <div className="talk" {...drop.handlers}>
      <ChatLayout
        density="spacious"
        composer={<Composer offline={offline} strip={strip} files={files} onFilesChange={setFiles} onSend={onSend} />}
        emptyState={<EmptyTimeline />}
      >
        {items.length > 0 || busy ? <Timeline items={items} busy={busy} onOlder={onOlder} topInset={topInset} density={density} /> : null}
      </ChatLayout>
      {drop.over ? (
        <div className="drop-sign">
          <div className="drop-sign-body">
            <Icon icon={AttachIcon} size="lg" />
            <span>{words.dropHere}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Whether a drag carries files from outside the page: text, links and the page's own images do not count. */
function carriesFiles(event: { dataTransfer: DataTransfer | null }, fromPage: boolean): boolean {
  return !fromPage && [...(event.dataTransfer?.types ?? [])].includes("Files");
}

/**
 * Drops of files on the element: `over` while files are dragged over it.
 * Files dropped anywhere else on the page are not opened by the browser
 * either, so that a drop that misses never leaves the page.
 */
function useFileDrop(onFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false);
  // dragenter and dragleave come for each child the drag crosses.
  const depth = useRef(0);
  // A drag that starts on the page (its text, its images) carries no files of the owner's.
  const fromPage = useRef(false);

  useEffect(() => {
    const started = () => (fromPage.current = true);
    const ended = () => (fromPage.current = false);
    const keep = (event: globalThis.DragEvent) => {
      if (carriesFiles(event, fromPage.current)) event.preventDefault();
    };
    const reset = () => {
      depth.current = 0;
      setOver(false);
    };
    window.addEventListener("dragstart", started);
    window.addEventListener("dragend", ended);
    window.addEventListener("dragover", keep);
    window.addEventListener("drop", keep);
    window.addEventListener("drop", reset);
    window.addEventListener("dragend", reset);
    return () => {
      window.removeEventListener("dragstart", started);
      window.removeEventListener("dragend", ended);
      window.removeEventListener("dragover", keep);
      window.removeEventListener("drop", keep);
      window.removeEventListener("drop", reset);
      window.removeEventListener("dragend", reset);
    };
  }, []);

  const handlers = {
    onDragEnter: (event: DragEvent) => {
      if (!carriesFiles(event, fromPage.current)) return;
      event.preventDefault();
      depth.current += 1;
      setOver(true);
    },
    onDragOver: (event: DragEvent) => {
      if (!carriesFiles(event, fromPage.current)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (event: DragEvent) => {
      if (!carriesFiles(event, fromPage.current)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop: (event: DragEvent) => {
      if (!carriesFiles(event, fromPage.current)) return;
      event.preventDefault();
      depth.current = 0;
      setOver(false);
      const dropped = [...event.dataTransfer.files];
      if (dropped.length > 0) onFiles(dropped);
    },
  };
  return { over, handlers };
}
