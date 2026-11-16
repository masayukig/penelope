// The words of the screens (docs/design/README.md) and how times and
// sources are written. Kept in one place so that they change together.
import type { Source } from "@penelope/contract";

import type { Status } from "../model/store.ts";

export const words = {
  places: { talk: "会話", log: "活動の記録", memory: "記憶", events: "出来事", settings: "設定" },
  placeholderTitle: "まだありません",
  placeholderBody: "この場所は、これから作ります。",
  emptyTitle: "まだ会話はありません",
  emptyBody: "下の欄から話しかけてください。",
  offline: "接続が切れました。つなぎ直しています。書いたものは、つながってから送られます。",
  inputLabel: "メッセージ",
  inputPlaceholder: "メッセージを書く",
  attach: "画像やファイルを添付",
  attachments: "添付",
  removeFile: (name: string) => `${name} を外す`,
  openImage: (name: string) => `${name} を大きく見る`,
  duringTurn: "考えている最中に届きました",
  thinkingDots: "考えている",
  writingDots: "書いている途中",
  panel: "いまのエージェント",
  togglePanel: "いまのエージェントを開く・閉じる",
  openSheet: "いまのエージェントを開く",
  menu: "メニュー",
  approvals: "承認待ち",
  approvalsNone: "いまはありません",
  main: "本体",
  subAgents: "サブエージェント",
  subCount: (n: number) => `サブ ${n}`,
  idle: "いまは何もしていません。次の出来事を待っています。",
  turnStart: "ターンの始まり",
  trigger: "きっかけ",
  thought: "思考",
  thoughtOpen: "全文を開く",
  thoughtClose: "畳む",
  tool: "ツール",
  result: "結果",
  resultError: "結果（失敗）",
  message: "返答",
  interrupt: "割り込み",
  ownerMessage: "オーナーのメッセージ",
  writing: "思考（途中）",
  login: "GitHub でログイン",
  loginNote: "オーナーだけが入れます。",
  logout: "ログアウト",
  push: {
    off: "通知を受ける",
    on: "通知を止める",
    busy: "通知を設定しています",
    failed: "通知を受けられませんでした。もう一度試す",
    denied: "通知はブラウザで止められています",
    unsupported: "このブラウザでは通知を受けられません（iPhone はホーム画面に置いてから）",
    unavailable: "この配置では通知を使えません",
  },
  schedules: "予約",
  schedulesNone: "予約はありません",
  schedulesNoneBody: "エージェントが予約を足すと、ここに並びます。",
  schedulesFailed: "予約を読めませんでした。",
  scheduleOnce: "1 回",
  scheduleNext: "次は",
  scheduleRemove: "取り消す",
  scheduleKeep: "やめる",
  scheduleConfirm: "この予約を取り消しますか？",
  scheduleConfirmBody: (reason: string) => `「${reason}」の予約を消します。エージェントには知らせません。`,
  scheduleRemoveFailed: "取り消せませんでした。もう一度試してください。",
  today: "今日",
  yesterday: "昨日",
  tomorrow: "明日",
} as const;

export function statusWord(status: Status): string {
  switch (status.kind) {
    case "offline":
      return "接続なし";
    case "waiting":
      return "待っている";
    case "thinking":
      return "考えている";
    case "tool":
      return "ツールを使っている";
  }
}

/** The state of a sub-agent: it waits stopped until the main agent speaks to it. */
export function subAgentWord(status: Status): string {
  return status.kind === "waiting" ? "止まって待っている" : statusWord(status);
}

/** How many sub-agents run and wait, as the head of their column says it. */
export function subCountWord(running: number, waiting: number): string {
  return waiting > 0 ? `走っている ${running} ・ 待っている ${waiting}` : `走っている ${running}`;
}

/** Since when a sub-agent has waited: the time today, else the day too. */
export function sinceOf(at: string, now: number = Date.now()): string {
  const day = dayOf(at, now);
  if (day === words.today) return `${timeOf(at)} から`;
  if (day === words.yesterday) return `${day} ${timeOf(at)} から`;
  return `${day}から`;
}

/** The words of the faces of an avatar (ADR-0016). One it does not know is read as neutral. */
const FACES: Partial<Record<string, string>> = {
  neutral: "いつもどおり",
  happy: "うれしい",
  laughing: "笑っている",
  surprised: "驚いた",
  thinking: "考え中",
  worried: "心配",
  sad: "悲しい",
  sleepy: "眠い",
  angry: "怒っている",
};

export function faceWord(expression: string): string {
  return FACES[expression] ?? FACES.neutral!;
}

const SOURCES: Partial<Record<string, string>> = { cron: "予約", self: "自分から", a2a: "A2A", control: "制御", ui: "オーナー" };

export function sourceWord(source: Source): string {
  return SOURCES[source] ?? source;
}

export function timeOf(at: string): string {
  return new Date(at).toLocaleTimeString("ja-JP", { hour: "numeric", minute: "2-digit" });
}

/** The label of the day a line falls on: today, yesterday, or its date. */
export function dayOf(at: string, now: number = Date.now()): string {
  const day = new Date(at);
  const today = new Date(now);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(day)) / 86_400_000);
  if (diff === 0) return words.today;
  if (diff === 1) return words.yesterday;
  return day.toLocaleDateString("ja-JP", { year: day.getFullYear() === today.getFullYear() ? undefined : "numeric", month: "long", day: "numeric", weekday: "short" });
}

/** When a schedule comes due: today, tomorrow or its date, and the time. */
export function dueOf(at: string, now: number = Date.now()): string {
  const day = new Date(at);
  const today = new Date(now);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const label = Math.round((startOf(day) - startOf(today)) / 86_400_000) === 1 ? words.tomorrow : dayOf(at, now);
  return `${label} ${timeOf(at)}`;
}

export function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
