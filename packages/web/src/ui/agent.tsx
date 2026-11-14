// Who the agent is, as the settings say (GET /api/agent), and her avatar.
// Nothing here names her: the name and the icon are the deployment's
// (ADR-0001).
import { Avatar } from "@astryxdesign/core/Avatar";
import { Badge } from "@astryxdesign/core/Badge";
import { createContext, useContext } from "react";

import type { AgentResponse } from "@penelope/contract";

/** The icon the build carries, for when the settings have none. */
export const BUILT_ICON = "/icon.svg";

export const AgentContext = createContext<AgentResponse>({ name: "" });

export function useAgent(): AgentResponse {
  return useContext(AgentContext);
}

/** The sizes the avatar is drawn at, the nearest Astryx has to the design's. */
export type AvatarSize = 24 | 32 | 36 | 72 | 96 | 128;

/**
 * The avatar: for now a fixed icon, with the expression as a badge under it.
 * It takes only the expression and the size, so that what is drawn (a
 * picture per face, a 3D model) can change here alone.
 */
export function AgentAvatar({ expression, size }: { expression?: string | undefined; size: AvatarSize }) {
  const agent = useAgent();
  const avatar = <Avatar src={agent.icon ?? BUILT_ICON} fallbackSrc={BUILT_ICON} name={agent.name} size={size} tooltip={false} />;
  if (expression === undefined) return avatar;
  return (
    <span className="agent-avatar">
      {avatar}
      <Badge label={expression} />
    </span>
  );
}
