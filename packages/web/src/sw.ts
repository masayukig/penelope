// The service worker (ADR-0027), served at /sw.js over the whole site. It
// shows the notice of each reply and opens the conversation when one is
// pressed. Only the parts of the worker's scope it uses are typed here,
// since the page's DOM types and the worker's do not go together.
import type { AgentResponse, Notice } from "@penelope/contract";

import { notificationOf, openConversation, type WindowLike } from "./sw/notice.ts";

type ExtendableEvent = Event & { waitUntil(promise: Promise<unknown>): void };
type PushEvent = ExtendableEvent & { readonly data: { json(): unknown } | null };
type NotificationEvent = ExtendableEvent & { readonly notification: Notification };
type Scope = {
  readonly registration: ServiceWorkerRegistration;
  readonly clients: {
    matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<readonly WindowLike[]>;
    openWindow(url: string): Promise<unknown>;
    claim(): Promise<void>;
  };
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: "push", listener: (event: PushEvent) => void): void;
  addEventListener(type: "notificationclick", listener: (event: NotificationEvent) => void): void;
};

const scope = globalThis as unknown as Scope;

scope.addEventListener("install", (event) => event.waitUntil(scope.skipWaiting()));
scope.addEventListener("activate", (event) => event.waitUntil(scope.clients.claim()));

scope.addEventListener("push", (event) => {
  event.waitUntil(show(event));
});

scope.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    scope.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => openConversation(windows, (url) => scope.clients.openWindow(url))),
  );
});

async function show(event: PushEvent): Promise<void> {
  let notice: Notice;
  try {
    notice = event.data?.json() as Notice;
  } catch {
    return;
  }
  if (typeof notice?.agent !== "string" || typeof notice.text !== "string") return;
  const [agent, windows] = await Promise.all([agentOf(notice.agent), scope.clients.matchAll({ type: "window", includeUncontrolled: true })]);
  const { title, options } = notificationOf(notice, agent, { focused: windows.some((window) => window.focused) });
  await scope.registration.showNotification(title, options);
}

/** Her faces, read without a login (docs/ui-api.md, "エージェント"); none if they cannot be read. */
async function agentOf(name: string): Promise<AgentResponse> {
  try {
    const response = await fetch("/api/agent");
    if (response.ok) return (await response.json()) as AgentResponse;
  } catch {
    // Shown with the built icon.
  }
  return { name };
}
