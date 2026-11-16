// What the service worker makes of a push and of a click on its
// notification (docs/ui-api.md, "知らせ"). Kept apart from the worker's
// events so that the tests can read it.
import type { AgentResponse, Notice } from "@penelope/contract";

/** The icon the build carries, for when the settings have none. */
const BUILT_ICON = "/icon.svg";
const NEUTRAL = "neutral";
/** Where a notification opens: the conversation. */
export const CONVERSATION = "/";

export type NotificationParts = {
  title: string;
  options: { body: string; icon: string; tag: string; silent: boolean; data: { url: string } };
};

/**
 * The notification of a reply: her name, the head of the reply and her
 * face. Shown even while the conversation is in front of the owner (a
 * browser may stop the pushes of a site that shows none), but without a
 * sound then.
 */
export function notificationOf(notice: Notice, agent: AgentResponse, { focused }: { focused: boolean }): NotificationParts {
  const face = notice.expression !== undefined && agent.icons?.[notice.expression] !== undefined ? notice.expression : NEUTRAL;
  const images = notice.images === undefined || notice.images === 0 ? undefined : `（画像 ${notice.images} 枚）`;
  return {
    title: notice.agent,
    options: {
      body: [notice.text, images].filter((part) => part !== undefined && part !== "").join("\n"),
      icon: agent.icons?.[face] ?? BUILT_ICON,
      tag: notice.id,
      silent: focused,
      data: { url: CONVERSATION },
    },
  };
}

/** The parts of a window client the worker uses. */
export type WindowLike = { readonly url: string; readonly focused: boolean; focus(): Promise<WindowLike> };

/** Brings an open window of the site to the front, or opens the conversation. */
export async function openConversation(windows: readonly WindowLike[], open: (url: string) => Promise<unknown>): Promise<void> {
  const window = windows.find((client) => client.focused) ?? windows[0];
  if (window !== undefined) {
    await window.focus();
    return;
  }
  await open(CONVERSATION);
}
