// A stand-in for the browser's service worker, Push API and notification
// permission, as the Web UI's push model takes them.
import type { PushPlatform, PushSubscriptionLike } from "../src/model/push.ts";

export class FakeSubscription implements PushSubscriptionLike {
  readonly endpoint: string;
  readonly options: { applicationServerKey: ArrayBuffer | null };
  ended = false;
  private readonly push: FakePush;

  constructor(push: FakePush, endpoint: string, key: Uint8Array) {
    this.push = push;
    this.endpoint = endpoint;
    this.options = { applicationServerKey: new Uint8Array(key).buffer };
  }

  toJSON() {
    return { endpoint: this.endpoint, expirationTime: null, keys: { p256dh: "BrowserP256dh", auth: "BrowserAuth" } };
  }

  async unsubscribe(): Promise<boolean> {
    this.ended = true;
    if (this.push.subscription === this) this.push.subscription = null;
    return true;
  }
}

export class FakePush implements PushPlatform {
  /** Whether the browser has a service worker, the Push API and notifications. */
  has = true;
  granted: NotificationPermission = "default";
  /** What the owner answers when asked. */
  answer: NotificationPermission = "granted";
  subscription: FakeSubscription | null = null;
  /** The keys it was asked to subscribe with, in base64url. */
  readonly subscribedWith: string[] = [];
  private made = 0;

  supported(): boolean {
    return this.has;
  }

  permission(): NotificationPermission {
    return this.granted;
  }

  async requestPermission(): Promise<NotificationPermission> {
    this.granted = this.answer;
    return this.granted;
  }

  async current(): Promise<FakeSubscription | null> {
    return this.subscription;
  }

  async subscribe(key: Uint8Array): Promise<FakeSubscription> {
    this.subscribedWith.push(Buffer.from(key).toString("base64url"));
    this.subscription = new FakeSubscription(this, `https://push.example.com/send/${++this.made}`, key);
    return this.subscription;
  }

  /** A subscription the browser kept from before, made with `key` (base64url). */
  had(key: string): FakeSubscription {
    this.granted = "granted";
    this.subscription = new FakeSubscription(this, `https://push.example.com/send/old`, Buffer.from(key, "base64url"));
    return this.subscription;
  }
}
