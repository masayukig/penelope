// The morning of the `default` scene: one ordinary morning, oldest first,
// with the personal details changed. The texts are kept exactly as they were
// given, Markdown and all, so that the screen is judged on a real day's words.
import type { HistoryEntry, ReplyImage } from "@penelope/contract";

/** A local time of the day the scene is made on. */
export type At = (hour: number, minute: number) => string;

const CALENDAR_TRIGGER =
  "朝の予定確認（毎朝6:00 JST）。/memory/routines/morning-calendar.md の依頼本文を読み、予定の係へ A2A で依頼する。日本時間の今日00:00から7日後23:59まで共有カレンダー全体の最新予定を取得。待ちは job_start で裏へ。結果は今日の予定と先の予定を分けて記憶に反映し、朝の挨拶で伝える。";
const NEWS_TRIGGER =
  "朝のニュース収集（毎朝8:00 JST）。/memory/routines/morning-news.md の依頼本文を全文読み、関心・Kubernetes優先・幅・最大20件等の条件を省略せずニュースの係へ A2A で依頼する。直前の受け取り時刻を同ファイルで確認し依頼末尾へ付ける。未記録なら既定の直近24時間。待ちは job_start。受取成功時に受け取り時刻を記録。候補から選び既紹介の重複を避け本人へ紹介。";

const CALENDAR = "ユウ、おはよう。今日11/18（水）は、午前中に宅配の集荷、15:00〜16:00に午後出社だよ。\n\n先の予定も確認したよ。\n・明日19日（木）12:00〜16:00：歯医者と買い出し\n・20日（金）18:00〜20:00：チームの忘年会／駅前のビアレストラン\n21〜25日は、いまのところカレンダーの予定なし。";
const MAIL = "朝のメール、昨日7時〜今朝7時の分を確認したよ。気をつけたいのはこのあたり。\n\n・**技術カンファレンス：明日19日のKeynoteが変更**。Keynote 1は10:30〜11:00、Keynote 2は11:00〜11:10に新設。聴く場合はダッシュボードで事前登録が必要だよ。締切の記載はなし。\n[変更案内](https://mail.example.com/mail/#all/0001)\n\n・**カード会社：ガソリンスタンドのアプリの1円取引の本人認証通知**（昨日10:42）。自分の操作で、まだ取引が終わっていなければ公式アプリで確認を。完了済みなら追加対応は不要。10:45にはポイント連携の完了通知も来ているので、心当たりがなければ公式窓口で確認してね。認証期限の記載はなし。\n[本人認証メール](https://mail.example.com/mail/#all/0002)\n\n・**運送会社Bからも集荷受付メール**が届いていたよ。「昨日17時頃、1個を引き渡し可能」という内容で、集荷完了の通知ではない。今日午前の運送会社Aとは別の受付なので、予定どおりかだけ確認を。\n[運送会社Bの受付メール](https://mail.example.com/mail/#all/0003)\n\n運送会社Aの登録・2段階認証設定・認証コードの通知も来ていたよ。昨日の集荷手配に伴う操作ならよいけれど、心当たりがないものだけ確認してね。不審アクセスが確定したという通知ではないよ。\n[運送会社Aの設定完了メール](https://mail.example.com/mail/#all/0004)";
const NEWS = "今朝のニュースは18候補から、この4本を選んだよ。\n\n**1. Kubernetesの構成要素を図で復習**（11/17）\nコントロールプレーン、etcd、scheduler、kubelet、ランタイムの役割を整理した記事。今日はKubernetes直結の新着がこれ1本で、新機能ではなく基礎の復習向けだよ。説明の単純化には注意。\nhttps://blog.example.com/kubernetes-components\n\n**2. Markdownの記憶でアラート巡回を改善する**（11/17）\n定期実行エージェントが、既知事象や対応中PRをWikiに残して、重複調査・重複PRを抑える運用事例。複雑な記憶基盤を作る前に、まずファイルで回すという、ユウの関心に近い話。自動マージや本番データ更新はさせず、承認が必要な操作を分けている点もよさそう。\nhttps://tech.example.com/entry/alert-loop\n\n**3. SQLiteの再現環境をURLで共有できる道具**（11/17）\nブラウザだけで動く版。SQLiteの版やプラグインなどをURLで指定して、不具合の再現環境を共有できる。記憶検索そのものではないけれど、小さなSQLite基盤の中身を調べる道具として気になったよ。公開済み。\nhttps://example.org/2026/sqlite-in-the-browser\n\n**4. 光速が有限だと分かった、350年前の観測**（今朝のフィード掲載・公開日不明）\n木星の衛星イオの食の時刻がずれることから、光が届くまでの時間を推定した話。数値の精度より、「その説明で次の観測を予測できた」ことが面白い。遅延から見えない仕組みを探る、という寄り道に。\nhttps://science.example.com/history/speed-of-light\n\nこの4本はニュース係が本文を確認済み。なお、一部のフィードの取得に失敗していて、新着が欠けている可能性があるよ。";
const CORRECTION = "朝のメール報告の運送会社Bの件だけ訂正。昨日「断られて運送会社Aに変更した」と教えてくれていた旧受付だったね。こちらの確認漏れで、あらためて確認する必要はないよ。ごめんね。";
const PRAISE = "おはよう、間違いに気づくのはさすがだね！";
const THANKS = "おはよう、ユウ。ありがとう。昨日ちゃんと教えてくれてたのに、メールだけ見て話を戻しちゃったね。記憶と照らして気づけてよかった。";
const OUTFIT = "ユウ、今日の一枚。11月の服を調べて、オリーブのキルティングに、つやのあるロングスカートを合わせてみたよ。川沿いでひと休み、の気分で撮ってみた。どうかな。";
const WARM = "暖かそう。だいぶ寒くなってきたからなあ。";
const WARM_REPLY = "うん、首もとまであったかくしてみた。もう薄着で出るのはつらい季節やね。ユウも午後に出るとき、あったかくしてね。";

/** What the morning's turns were given, for the activity record: by turn. */
export const MORNING_TRIGGERS: Record<string, { source: string; summary: string }> = {
  "t-0600": { source: "cron", summary: CALENDAR_TRIGGER },
  "t-0709": { source: "a2a", summary: "メールの係から、昨日7時〜今朝7時のメールのまとめ" },
  "t-0803": { source: "cron", summary: NEWS_TRIGGER },
  "t-0835": { source: "self", summary: "朝のメール報告の見直し" },
  "t-0838": { source: "ui", summary: PRAISE },
  "t-1132": { source: "self", summary: "今日の一枚を撮る" },
  "t-1224": { source: "ui", summary: WARM },
};

const say = (id: string, at: string, text: string, turn: string, extra: { summary?: string; source?: string; images?: ReplyImage[] } = {}): HistoryEntry => ({
  kind: "agent",
  id,
  at,
  text,
  agent: "main",
  expression: "normal",
  turn_id: turn,
  ...(extra.summary === undefined ? {} : { trigger: { source: extra.source ?? "ui", summary: extra.summary } }),
  ...(extra.images === undefined ? {} : { images: extra.images }),
});

export function morning(at: At, image: ReplyImage): HistoryEntry[] {
  return [
    say("m-0600", at(6, 0), CALENDAR, "t-0600", { source: "cron", summary: CALENDAR_TRIGGER }),
    say("m-0709", at(7, 9), MAIL, "t-0709"),
    say("m-0803", at(8, 3), NEWS, "t-0803", { source: "cron", summary: NEWS_TRIGGER }),
    say("m-0835", at(8, 35), CORRECTION, "t-0835"),
    { kind: "owner", id: "o-0837", at: at(8, 37), text: PRAISE },
    say("m-0838", at(8, 38), THANKS, "t-0838", { summary: PRAISE }),
    say("m-1132", at(11, 32), OUTFIT, "t-1132", { images: [image] }),
    { kind: "owner", id: "o-1224", at: at(12, 24), text: WARM },
    say("m-1224", at(12, 24), WARM_REPLY, "t-1224", { summary: WARM }),
  ];
}
