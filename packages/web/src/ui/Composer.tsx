// The field the owner writes in, with the files to send along
// (docs/design/README.md, 5). Above it, the notice of a dropped line and, on
// the phone, the strip of what she is doing.
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { ChatComposer, ChatComposerDrawer, ChatSendButton } from "@astryxdesign/core/Chat";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Thumbnail } from "@astryxdesign/core/Thumbnail";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { AttachIcon, ReconnectIcon } from "./icons.tsx";
import { sizeOf, words } from "./words.ts";

export type ComposerProps = {
  offline: boolean;
  strip?: ReactNode;
  /** The files to send along: kept by the conversation, which also takes the ones dropped on it. */
  files: File[];
  onFilesChange: (change: (files: File[]) => File[]) => void;
  onSend: (text: string, files: File[]) => void;
};

export function Composer({ offline, strip, files, onFilesChange: setFiles, onSend }: ComposerProps) {
  const [text, setText] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const canSend = text.trim() !== "" || files.length > 0;

  const send = () => {
    if (!canSend) return;
    onSend(text.trim(), files);
    setText("");
    setFiles(() => []);
  };

  return (
    <div className="composer-stack">
      {offline ? <Banner status="warning" title={words.offline} icon={<Icon icon={ReconnectIcon} />} /> : null}
      {strip}
      <ChatComposer
        value={text}
        onChange={setText}
        onSubmit={send}
        placeholder={words.inputPlaceholder}
        density="spacious"
        {...(files.length > 0 ? { drawer: <Attachments files={files} onRemove={(file) => setFiles((list) => list.filter((f) => f !== file))} /> } : {})}
        footerActions={
          <>
            <IconButton icon={<Icon icon={AttachIcon} />} label={words.attach} variant="ghost" onClick={() => picker.current?.click()} />
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              aria-label={words.attach}
              onChange={(event) => {
                const chosen = [...(event.currentTarget.files ?? [])];
                if (chosen.length > 0) setFiles((list) => [...list, ...chosen]);
                event.currentTarget.value = "";
              }}
            />
          </>
        }
        sendButton={<ChatSendButton isDisabled={!canSend} onSend={send} />}
      />
    </div>
  );
}

function Attachments({ files, onRemove }: { files: File[]; onRemove: (file: File) => void }) {
  return (
    <ChatComposerDrawer label={words.attachments}>
      <div className="composer-files">
        {files.map((file, index) => (
          <Attachment key={`${file.name}-${index}`} file={file} onRemove={() => onRemove(file)} />
        ))}
      </div>
    </ChatComposerDrawer>
  );
}

function Attachment({ file, onRemove }: { file: File; onRemove: () => void }) {
  const url = useMemo(() => (file.type.startsWith("image/") && typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : undefined), [file]);
  useEffect(() => () => (url ? URL.revokeObjectURL(url) : undefined), [url]);
  if (url) return <Thumbnail src={url} alt={file.name} label={file.name} onRemove={onRemove} showRemoveOn="always" />;
  return (
    <span className="composer-file">
      <Badge label={`${file.name} ・ ${sizeOf(file.size)}`} />
      <IconButton icon="close" label={words.removeFile(file.name)} size="sm" variant="ghost" onClick={onRemove} />
    </span>
  );
}
