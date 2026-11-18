// Who the agent is, as the settings say (GET /api/agent), and her avatar.
// Nothing here names her: the name and the icon are the deployment's
// (ADR-0001).
import { Avatar } from "@astryxdesign/core/Avatar";
import { Badge } from "@astryxdesign/core/Badge";
import { createContext, useContext } from "react";

import type { AgentResponse } from "@penelope/contract";

import { faceWord } from "./words.ts";

/** The icon the build carries, for when the settings have none. */
export const BUILT_ICON = "/icon.svg";

export const AgentContext = createContext<AgentResponse>({ name: "" });

export function useAgent(): AgentResponse {
  return useContext(AgentContext);
}

/** The sizes the avatar is drawn at, the nearest Astryx has to the design's. */
export type AvatarSize = 24 | 32 | 36 | 72 | 96 | 128;

/** The face drawn when there is no expression, or none the avatar has a face for. */
export const NEUTRAL = "neutral";
/** From this size up, the avatar carries the word of its face under it. */
const LABELLED = 72;

/**
 * The avatar: the face of the expression, from the avatar the settings
 * chose (ADR-0016), with the word of the face under it when it is drawn
 * large. It takes only the expression and the size, so that how it is drawn
 * (a 3D model, say) can change here alone.
 */
export function AgentAvatar({ expression, size, shape = "circle" }: { expression?: string | undefined; size: AvatarSize; shape?: "circle" | "rounded" }) {
  const agent = useAgent();
  const face = expression !== undefined && agent.icons?.[expression] !== undefined ? expression : NEUTRAL;
  const src = agent.icons?.[face] ?? BUILT_ICON;
  const avatar = <Avatar src={src} fallbackSrc={BUILT_ICON} name={agent.name} size={size} shape={shape} tooltip={false} />;
  if (size < LABELLED) return avatar;
  return (
    <span className="agent-avatar">
      {avatar}
      <Badge label={faceWord(face)} />
    </span>
  );
}
