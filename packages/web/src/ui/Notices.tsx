// The switch of the notices (ADR-0027), small, beside the logout: in the
// rail's footer on the PC, in the menu on a phone. When they cannot be had,
// it says why and cannot be pressed.
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Api } from "../model/api.ts";
import { checkPush, type PushPlatform, type PushState, turnOff, turnOn } from "../model/push.ts";
import { BellIcon, BellOffIcon } from "./icons.tsx";
import { words } from "./words.ts";

export type Notices = { state: PushState; toggle: () => void };

/** Where the notices stand, checked once the owner is signed in. */
export function useNotices(api: Api, platform: PushPlatform, signedIn: boolean): Notices {
  const [state, setState] = useState<PushState>("unknown");
  const key = useRef<Uint8Array<ArrayBuffer> | undefined>(undefined);

  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    checkPush(api, platform).then(
      (checked) => {
        key.current = checked.key;
        if (live) setState(checked.state);
      },
      () => {
        if (live) setState("failed");
      },
    );
    return () => {
      live = false;
    };
  }, [api, platform, signedIn]);

  const toggle = useCallback(() => {
    const was = state;
    if (key.current === undefined || (was !== "off" && was !== "on" && was !== "failed")) return;
    setState("busy");
    const change = was === "on" ? turnOff(api, platform) : turnOn(api, platform, key.current);
    change.then(setState, () => setState(was === "on" ? "on" : "failed"));
  }, [api, platform, state]);

  return { state, toggle };
}

const PRESSABLE: ReadonlySet<PushState> = new Set(["off", "on", "failed"]);

export function NoticesButton({ notices, compact = false }: { notices: Notices; compact?: boolean }) {
  if (notices.state === "unknown") return null;
  const label = words.push[notices.state];
  const disabled = !PRESSABLE.has(notices.state);
  if (compact) {
    return (
      <IconButton
        icon={<Icon icon={notices.state === "on" ? BellIcon : BellOffIcon} />}
        label={label}
        variant="ghost"
        size="sm"
        isDisabled={disabled}
        onClick={notices.toggle}
      />
    );
  }
  return <Button label={label} variant="ghost" size="sm" isDisabled={disabled} onClick={notices.toggle} />;
}
