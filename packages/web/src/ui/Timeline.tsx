// The conversation's timeline: the owner's messages and her replies, oldest
// first, with the day between them (docs/design/README.md, 5).
import { Badge } from "@astryxdesign/core/Badge";
import { ChatMessage, ChatMessageBubble, ChatMessageList, ChatMessageMetadata, ChatSystemMessage } from "@astryxdesign/core/Chat";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Lightbox } from "@astryxdesign/core/Lightbox";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Thumbnail } from "@astryxdesign/core/Thumbnail";
import { Fragment, useState } from "react";

import type { AgentItem, LocalFile, OwnerItem, TimelineItem } from "../model/store.ts";
import { AgentAvatar, useAgent } from "./agent.tsx";
import { dayOf, faceWord, sourceWord, timeOf, words } from "./words.ts";

export function Timeline({ items, busy, onOlder }: { items: TimelineItem[]; busy: boolean; onOlder?: (() => Promise<void>) | undefined }) {
  const [shown, setShown] = useState<LocalFile | undefined>(undefined);
  let lastDay: string | undefined;
  return (
    <>
      <ChatMessageList density="spacious" isStreaming={busy} {...(onOlder ? { scrollToTopAction: onOlder } : {})}>
        {items.map((item) => {
          const day = dayOf(item.at);
          const divider = day !== lastDay ? <ChatSystemMessage variant="divider">{day}</ChatSystemMessage> : null;
          lastDay = day;
          return (
            <Fragment key={item.key}>
              {divider}
              {item.kind === "agent" ? <Reply item={item} /> : <OwnerMessage item={item} onOpen={setShown} />}
            </Fragment>
          );
        })}
        {busy ? <Dots label={words.thinkingDots} /> : null}
      </ChatMessageList>
      {shown?.url ? (
        <Lightbox isOpen media={{ src: shown.url, alt: shown.name }} onOpenChange={(open) => (open ? undefined : setShown(undefined))} hasZoom />
      ) : null}
    </>
  );
}

export function EmptyTimeline() {
  return <EmptyState title={words.emptyTitle} description={words.emptyBody} headingLevel={2} />;
}

function Reply({ item }: { item: AgentItem }) {
  const agent = useAgent();
  // A reply to the owner's own message needs no word of what started it.
  const trigger = item.trigger !== undefined && item.trigger.source !== "ui" ? item.trigger : undefined;
  const name = (
    <span className="reply-name">
      <AgentAvatar size={24} expression={item.expression} />
      <strong>{agent.name}</strong>
      {item.expression !== undefined ? <span className="reply-expression">{faceWord(item.expression)}</span> : null}
      {trigger ? <Badge label={`${sourceWord(trigger.source)} ・ ${trigger.summary}`} /> : null}
    </span>
  );
  return (
    <ChatMessage sender="assistant">
      <ChatMessageBubble variant="ghost" name={name} metadata={<ChatMessageMetadata timestamp={timeOf(item.at)} />}>
        <Markdown>{item.text}</Markdown>
      </ChatMessageBubble>
    </ChatMessage>
  );
}

const DELIVERY = { sent: "sent", queued: "sending", sending: "sending", failed: "error" } as const;

function OwnerMessage({ item, onOpen }: { item: OwnerItem; onOpen: (file: LocalFile) => void }) {
  const metadata = (
    <ChatMessageMetadata
      timestamp={timeOf(item.at)}
      footer={item.duringTurn ? words.duringTurn : undefined}
      {...(item.delivery === "sent" ? {} : { status: DELIVERY[item.delivery] })}
    />
  );
  return (
    <ChatMessage sender="user">
      {item.files.length > 0 ? (
        <div className="owner-files">
          {item.files.map((file, index) =>
            file.url ? (
              <Thumbnail key={index} src={file.url} alt={file.name} label={words.openImage(file.name)} onClick={() => onOpen(file)} className="owner-image" />
            ) : (
              <Badge key={index} label={file.name} />
            ),
          )}
        </div>
      ) : null}
      {item.text !== "" ? (
        <ChatMessageBubble variant="filled" metadata={metadata}>
          <span className="owner-text">{item.text}</span>
        </ChatMessageBubble>
      ) : (
        metadata
      )}
    </ChatMessage>
  );
}

export function Dots({ label }: { label: string }) {
  return (
    <span className="dots" role="img" aria-label={label}>
      <span />
      <span />
      <span />
    </span>
  );
}
