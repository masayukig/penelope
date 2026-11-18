// The conversation's timeline: the owner's messages and her replies, oldest
// first, with the day between them (docs/design/README.md, 5).
import { Badge } from "@astryxdesign/core/Badge";
import { ChatMessage, ChatMessageBubble, ChatMessageList, ChatMessageMetadata, ChatSystemMessage } from "@astryxdesign/core/Chat";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Lightbox } from "@astryxdesign/core/Lightbox";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Thumbnail } from "@astryxdesign/core/Thumbnail";
import { Link } from "@astryxdesign/core/Link";
import { Fragment, useState } from "react";

import { assetUrl } from "../model/api.ts";
import type { AgentItem, LocalFile, OwnerItem, TimelineItem } from "../model/store.ts";
import { AgentAvatar } from "./agent.tsx";
import { Linked, markdownLinks } from "./links.tsx";
import { hashOf } from "./route.ts";
import { dayOf, sourceWord, timeOf, triggerWords, words } from "./words.ts";

export function Timeline({
  items,
  busy,
  onOlder,
  topInset = false,
  density = "spacious",
}: {
  items: TimelineItem[];
  busy: boolean;
  onOlder?: (() => Promise<void>) | undefined;
  topInset?: boolean;
  density?: "compact" | "spacious";
}) {
  // The image shown large: one the owner sent, or one of her replies'.
  const [shown, setShown] = useState<Shown | undefined>(undefined);
  const openFile = (file: LocalFile) => (file.url ? setShown({ url: file.url, name: file.name }) : undefined);
  // On a narrow screen her avatar is small and stands with the time under the reply, which keeps the whole width.
  const narrow = density === "compact";
  let lastDay: string | undefined;
  return (
    <>
      <ChatMessageList density={density} isStreaming={busy} {...(onOlder ? { scrollToTopAction: onOlder } : {})}>
        {/* Scrolled with the timeline, so that what floats over its top hides nothing until it is scrolled. */}
        {topInset ? <div className="timeline-inset" aria-hidden /> : null}
        {items.map((item) => {
          const day = dayOf(item.at);
          const divider = day !== lastDay ? <ChatSystemMessage variant="divider">{day}</ChatSystemMessage> : null;
          lastDay = day;
          return (
            <Fragment key={item.key}>
              {divider}
              {item.kind === "agent" ? (
                <>
                  <EventLine item={item} />
                  <Reply item={item} narrow={narrow} onOpen={setShown} />
                </>
              ) : (
                <OwnerMessage item={item} onOpen={openFile} />
              )}
            </Fragment>
          );
        })}
        {busy ? <Dots label={words.thinkingDots} /> : null}
      </ChatMessageList>
      {shown ? (
        <Lightbox isOpen media={{ src: shown.url, alt: shown.name }} onOpenChange={(open) => (open ? undefined : setShown(undefined))} hasZoom />
      ) : null}
    </>
  );
}

export function EmptyTimeline() {
  return <EmptyState title={words.emptyTitle} description={words.emptyBody} headingLevel={2} />;
}

type Shown = { url: string; name: string };

/** The images of a reply, small under its text; each opens large. */
function ReplyImages({ item, onOpen }: { item: AgentItem; onOpen: (shown: Shown) => void }) {
  if (!item.images || item.images.length === 0) return null;
  return (
    <div className="reply-images">
      {item.images.map((image) => {
        const url = assetUrl(image.id);
        return (
          <Thumbnail key={image.id} src={url} alt={image.name} label={image.name} onClick={() => onOpen({ url, name: image.name })} className="reply-image" />
        );
      })}
    </div>
  );
}

function Reply({ item, narrow, onOpen }: { item: AgentItem; narrow: boolean; onOpen: (shown: Shown) => void }) {
  const time =
    item.turn_id === undefined ? (
      timeOf(item.at)
    ) : (
      <Link
        href={hashOf({ place: "log", page: { kind: "turn", id: item.turn_id } })}
        label={words.record.seeTurn(timeOf(item.at))}
        type="inherit"
        color="secondary"
        className="reply-turn"
      >
        {timeOf(item.at)}
      </Link>
    );
  const metadata = (
    <ChatMessageMetadata
      timestamp={
        narrow ? (
          <span className="reply-foot">
            <AgentAvatar size={24} shape="rounded" expression={item.expression} />
            {time}
          </span>
        ) : (
          time
        )
      }
    />
  );
  // Her replies go without a bubble, beside her avatar; the owner's messages keep theirs, on the other side.
  return (
    <ChatMessage
      sender="assistant"
      {...(narrow
        ? {}
        : {
            avatar: (
              <span className="reply-avatar">
                <AgentAvatar size={36} shape="rounded" expression={item.expression} />
              </span>
            ),
          })}
    >
      <ChatMessageBubble variant="ghost" metadata={metadata} className="reply-bubble" data-reply={item.id}>
        <Markdown {...markdownLinks}>{item.text}</Markdown>
        <ReplyImages item={item} onOpen={onOpen} />
      </ChatMessageBubble>
    </ChatMessage>
  );
}

/**
 * What made her speak, as a line of its own in the flow before the reply
 * (docs/design/README.md, 13): in the middle, weaker than the day between
 * the messages, its kind whole and its words cut at the end by CSS alone, so
 * that the whole of them is read aloud. Nothing opens it; the turn's own
 * page shows it all. A reply to the owner's own message has none: the
 * message is right above it.
 */
function EventLine({ item }: { item: AgentItem }) {
  const trigger = item.trigger !== undefined && item.trigger.source !== "ui" ? item.trigger : undefined;
  if (!trigger) return null;
  return (
    <div className="timeline-event">
      <span className="reply-trigger">
        <span className="reply-trigger-kind">{sourceWord(trigger.source)}</span>
        <span className="reply-trigger-words">・ {triggerWords(trigger.summary)}</span>
      </span>
    </div>
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
          <span className="owner-text">
            <Linked text={item.text} />
          </span>
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
