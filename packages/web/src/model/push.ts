// The notices of the replies, on this browser's side (ADR-0027): the
// service worker at /sw.js, the Push API's subscription made with the
// deployment's VAPID key, and the backend told of it. The browser's parts
// come through a platform that the tests replace.
import type { PushSubscriptionRequest } from "@penelope/contract";

import type { Api } from "./api.ts";

/** Where the service worker is, over the whole site. */
export const SERVICE_WORKER = "/sw.js";

/** The parts of a `PushSubscription` the UI uses. */
export type PushSubscriptionLike = {
  readonly endpoint: string;
  readonly options: { readonly applicationServerKey: ArrayBuffer | null };
  toJSON(): PushSubscriptionJSON;
  unsubscribe(): Promise<boolean>;
};

/** The browser's service worker, Push API and permission to notify. */
export type PushPlatform = {
  /** Whether the browser has them all. Safari on an iPhone has them only on the home screen. */
  supported(): boolean;
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  /** The subscription the service worker has. */
  current(): Promise<PushSubscriptionLike | null>;
  /** Registers the service worker and subscribes with the key. */
  subscribe(applicationServerKey: Uint8Array<ArrayBuffer>): Promise<PushSubscriptionLike>;
};

/**
 * What the owner sees of the notices: on or off; why they cannot be had
 * (the deployment has no key, the browser cannot, the owner declined them
 * in the browser); or that a change is under way or failed.
 */
export type PushState = "unknown" | "unavailable" | "unsupported" | "denied" | "off" | "on" | "busy" | "failed";

export function browserPush(): PushPlatform {
  const supported = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  return {
    supported,
    permission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    current: async () => (await (await navigator.serviceWorker.getRegistration("/"))?.pushManager.getSubscription()) ?? null,
    subscribe: async (applicationServerKey) => {
      await navigator.serviceWorker.register(SERVICE_WORKER, { scope: "/" });
      const registration = await navigator.serviceWorker.ready;
      return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
    },
  };
}

/** Where the notices stand when the UI opens. A subscription the browser has is told to the backend again, made again if its key is old. */
export async function checkPush(api: Api, platform: PushPlatform): Promise<{ state: PushState; key?: Uint8Array<ArrayBuffer> }> {
  const { web_push: webPush } = await api.push();
  if (webPush === undefined) return { state: "unavailable" };
  if (!platform.supported()) return { state: "unsupported" };
  const key = bytesOf(webPush.public_key);
  const permission = platform.permission();
  if (permission === "denied") return { state: "denied", key };
  let subscription = await platform.current();
  if (subscription === null || permission !== "granted") return { state: "off", key };
  if (!sameKey(subscription.options.applicationServerKey, key)) {
    // A push service refuses what is sent to a subscription of another key.
    await subscription.unsubscribe();
    subscription = await platform.subscribe(key);
  }
  await api.subscribePush(requestOf(subscription));
  return { state: "on", key };
}

/** Asks the owner, subscribes and tells the backend. */
export async function turnOn(api: Api, platform: PushPlatform, key: Uint8Array<ArrayBuffer>): Promise<PushState> {
  const permission = await platform.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  const subscription = await platform.subscribe(key);
  await api.subscribePush(requestOf(subscription));
  return "on";
}

/** Ends the subscription in the browser and at the backend. */
export async function turnOff(api: Api, platform: PushPlatform): Promise<PushState> {
  const subscription = await platform.current();
  if (subscription !== null) {
    await subscription.unsubscribe();
    await api.unsubscribePush(subscription.endpoint);
  }
  return "off";
}

function requestOf(subscription: PushSubscriptionLike): PushSubscriptionRequest {
  const { endpoint, keys } = subscription.toJSON();
  return { kind: "web-push", endpoint: endpoint ?? subscription.endpoint, keys: { p256dh: keys?.p256dh ?? "", auth: keys?.auth ?? "" } };
}

function sameKey(held: ArrayBuffer | null, key: Uint8Array): boolean {
  if (held === null || held.byteLength !== key.length) return false;
  const bytes = new Uint8Array(held);
  return key.every((byte, index) => byte === bytes[index]);
}

/** base64url, as the backend gives the key, to the bytes the Push API takes. */
export function bytesOf(base64url: string): Uint8Array<ArrayBuffer> {
  const text = atob(base64url.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(text, (character) => character.charCodeAt(0));
}
