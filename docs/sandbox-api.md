# sandbox 向けの口の仕様

sandbox の中の runner と道具が backend を呼ぶ口を決める。方針は
[ADR-0002](adr/0002-one-intake-and-a-runner-that-pulls-events.md)・[ADR-0006](adr/0006-memory-kept-compatible-without-checks-committed-outside.md)・[ADR-0007](adr/0007-one-session-switched-nightly-with-a-one-turn-curator.md)・[ADR-0013](adr/0013-event-contents-in-sources-and-summaries-in-turns.md) にある。
型は `packages/contract` の `src/sandbox.ts` が正である。出来事の封筒と `/sources` は [events.md](events.md) にある。

「未決」と書いた点は、実装の作業単位が決めて、この文書を直す。

## 道と認証

- sandbox からは、backend の内部の名前（例: `https://backend.example.com`。実際の名前は配置のリポジトリの設定）の HTTPS で呼ぶ。ほかの外向きと同じく Sentinel を通る（[ADR-0003](adr/0003-all-egress-through-the-sentinel-passthrough-by-default.md)）。Sentinel はこの名前の登録の上流として、backend が sandbox 向けの口を待ち受ける Unix socket につなぐ。backend はこの口を TCP では待ち受けない（[ADR-0014](adr/0014-sandbox-loopback-left-open-and-pod-ports-on-unix-sockets.md)、[pod.md](pod.md)）。
- 要求は `Authorization: Bearer <サロゲート>` を持つ。Sentinel がそのサロゲートを backend の本物の token に差し替える（[sentinel-config.md](sentinel-config.md)）。backend は本物の token だけを受け、ほかは `401` で断る。
- 要求と応答の body は JSON。失敗の応答の body は `{error}`。

### `agent` の欄

- **すべての要求が、呼んでいるエージェントの ID を `agent` に持つ。** POST は body の欄、GET は query の `agent`。
- 本体は `main`。サブエージェントは、親が付ける名前。最初の版は `main` だけである。
- 同じ UID で動くエージェントを、backend と UI が見分けるための欄である。確かめはしない（sandbox の中の名乗り）。

- サブエージェントが出来事を取るか（`agent` ごとに列を分けるか）は、サブエージェントを作るときの ADR で決める。それまで、`agent` が `main` でない `GET /v1/events` は `400` で断る。

## 口の一覧

| 口 | 中身 |
| --- | --- |
| `GET /v1/events?agent=&after=&wait=` | 出来事を取る（long-poll） |
| `POST /v1/events/ack` | 済んだ出来事を知らせる |
| `POST /v1/self-events` | 自分宛ての出来事を入れる |
| `POST /v1/replies` | オーナーへの返事 |
| `POST /v1/activity` | 途中経過 |
| `POST /v1/turns/end` | ターンの終わり |
| `GET /v1/schedules?agent=`・`POST /v1/schedules`・`DELETE /v1/schedules/<id>` | 予約 |
| `POST /v1/sessions/rotated` | セッションの切り替えの知らせ |

## 出来事を取る

- `after` より後の `seq` で、まだ済んでいない出来事を、`seq` の順に返す。無ければ `wait` 秒まで待ち、それでも無ければ空の一覧を返す。
- 返したものは「渡した」になる。渡したまま一定時間 ack の無いものは、次の poll でもう一度渡す。
- 返すのは、渡す時が来たものだけである。`batch` の待ちと起きている時間は backend が数える（[events.md](events.md) の「いつ渡すか」）。runner は受け取った分をターンに入れるだけである。ターンに入る形（`<events>` の 1 行 1 件の JSON）は [events.md](events.md) の「ターンに入る形」にある。
- ack の無いままもう一度渡す出来事は、`seq` が `after` 以下でも返す。runner は再起動の後、`after` を省いて（0 として）取り直す。
- まだ一度も渡していない出来事も、`seq` が `after` 以下でも返す。`batch` の出来事は、後に来た `now` の出来事より後に渡ることがあり、そのとき `seq` は runner が受け取った最大の `seq` より小さい。
- 一定時間は backend の設定で、既定は 5 分（[backend.md](backend.md) の `PENELOPE_REDELIVER_MINUTES`）。ターンがそれより長く続くと、そのターンに入れたまま ack していない出来事も、もう一度渡る。
- `wait` の上限は 60 秒で、それより長い値は 60 秒として扱う。一度に返すのは 100 件まで。
- 応答は `{events: [...]}`。1 件ごとに `seq`・`source`・`id`・`stream`・`occurred_at`・`received_at`・`summary`・`delivery`・足された場所（`appended`: `path` と `lines` の 1 始まり・両端を含む範囲）・添付（`attachments`）を持つ。inline の出来事だけが `inline: true` と `payload` を持つ。
- `attachments` の 1 件は、`/sources` に置いた場所（`path`）、MIME（`mime_type`）、大きさ（`size`、byte）を持つ。添付が無ければ欄ごと省く。`/sources` の行の `attachments` は、場所だけの一覧のままである（[events.md](events.md)）。
- `mime_type` は、PNG・JPEG・GIF・WebP なら中身の先頭の bytes から決める。ほかは送り手が付けた Content-Type で、それも無いか形が違えば `application/octet-stream`。送り手が画像の型を付けても、中身がその画像でなければ `application/octet-stream` にする。画像だと言われたものが画像であるようにするためである。
- runner はターンの最中も取り続ける。`now` の出来事をターンの途中に steer で入れるためである。
- runner は、扱っている最中か扱い済みの `seq` がもう一度渡されたら捨てる。重複は `after` ではなく `seq` で見る。ターンが失敗して ack しなかった出来事だけは、もう一度渡されたら取り直す。

## 済んだ出来事を知らせる

- body は `{agent, seqs}`。runner は、出来事をターンに入れ、そのターンが終わってから ack する。制御の出来事は、手順が終わってから ack する。
- 知らない `seq`・既に済んだ `seq` は無視する。

## 自分宛ての出来事

- body は `{agent, id, summary, payload}`。backend は `source` が `self` の出来事として列に入れる（取り込み口と同じ処理）。`delivery` は backend の設定（既定 `now`）。
- サブエージェントが終わったことの知らせや、自分の作業の区切りに使う。取り込み口は Unix socket で sandbox から見えないため、この口を置く。
- `id` は呼び手が付ける。同じ `id` は重複として落ちる。
- 応答は `202` で、body は無い（取り込み口と同じ）。

## 返事

- body は `{agent, text, expression?, in_reply_to?}`。
  - `expression`: 表情。欄だけを持つ。最初の Web UI は表示しない（[ADR-0009](adr/0009-web-ui-first-with-a-new-api-and-astryx.md)）。
  - `in_reply_to`: 答えている出来事の `seq`。ターンの `<events>` の行の `seq` である（`batch` のまとめなら `seqs` の 1 つ）。
- 応答は `201` と `{id}`。backend は会話の履歴に残し、UI の流れへ送る（[ui-api.md](ui-api.md)）。

## 途中経過

- body は `{agent, activities: [...]}`。runner が Pi の出来事を購読し、**ブロックが閉じるごとに**送る。トークンごとには送らない。
- 1 件は `kind`・`at`（RFC 3339）・`turn_id` を持つ。
- `turn_id` は runner がターンごとに付ける UUID である。runner の 1 ターンは、Pi の 1 回の実行（入力を渡してから、Pi がそれ以上自分で続けなくなるまで）で、その間に steer と follow-up で入った出来事も含む。
- 地の文の無いまま終わったターンで、畳む前に runner が送る頼みと、その答え（[ADR-0015](adr/0015-fold-ended-turns-before-they-are-sent.md)）も、同じ `turn_id` のターンに入る。ターンの終わりの知らせは、その答えの後に送る。
- `tool_result` の `output` は、結果の文字の部分を改行でつないだものである。画像などの文字でない部分は `[image/png]` のように種類だけを書く。16,000 文字を超えた分は送らず、`[N more characters]` と数だけを添える。
- 送れなかった途中経過は送り直さない。記録と UI の写しだけのためである。

| `kind` | ほかの欄 |
| --- | --- |
| `turn_start` | なし |
| `thinking` | `text`（考えたこと） |
| `tool_call` | `call_id`・`name`・`arguments`（任意の JSON） |
| `tool_result` | `call_id`・`is_error`・`output`（文字列） |
| `message` | `text`（返答の区切り） |
| `turn_end` | なし |

- backend は 1 件ずつ記録に残し、UI の流れへ送る。`turn_start` でエージェントを `thinking`、`turn_end` で `waiting` にする。
- 1 件でも形が違えば、要求の全体を `400` で断り、何も残さない。

## ターンの終わり

- body は `{agent, turn_id}`。backend が `/memory` の作業ツリーの変わったものをコミットする合図である（[ADR-0006](adr/0006-memory-kept-compatible-without-checks-committed-outside.md)）。コミットの形は [backend.md](backend.md) の「`/memory` のコミット」にある。
- backend はコミットを終えてから `204` で答える。コミットに失敗したら `500` で答える。
- UI の流れでは、エージェントを `waiting` にする。
- 途中経過の `turn_end` は UI と記録のため、この口はコミットのために、別に置く。

## 予約

- 予約は、cron の式か 1 回の時刻（RFC 3339）のどちらか一方と、理由（`reason`）を持つ。
- `POST /v1/schedules` の body は `{agent, reason, cron}` か `{agent, reason, at}`。応答は予約（`{id, agent, reason, cron か at}`）。
- `GET /v1/schedules?agent=` は `{schedules: [...]}`。`DELETE /v1/schedules/<id>` で消す。
- 時刻が来たら、backend が `source` が `cron` の出来事を列に入れる（[events.md](events.md) の「予約の出来事」）。1 回の予約は、出来事にしたら消える。

- cron の式は 5 欄（分・時・日・月・曜日）で、backend の設定の時間帯で読む。式か時刻が読めなければ `400`。
- 作ったら `201`、消したら `204`、消す予約が無ければ `404`。

## セッションの切り替えの知らせ

- 夜の切り替え（制御の出来事、[events.md](events.md) の「制御の出来事」）を終え、新しいセッションが動き出したら、runner が送る。body は `{agent}`。
- そのあと runner は、制御の出来事を ack する。
- runner は、新しいセッションに切り替えたときに、その制御の出来事の `seq` をセッションの記録の場所に残す。同じ `seq` がもう一度渡されたら、手順は回さずに知らせと ack だけを送り直す。新しいセッションに切り替える前に止まったときは、もう一度渡された出来事で、振り返りからやり直す。

- backend は切り替えの段を数えず、制御の出来事も ack が無ければもう一度渡すだけである。切り替えの途中で runner が止まったとき（制御の出来事がもう一度渡されたとき）にどこからやり直すか、整理係のターンが失敗したときにどうするかは、runner が決める（[backend.md](backend.md) の「夜の切り替え」）。
- 整理係のターンが失敗しても、runner は記録に残して新しいセッションへ進む。記憶は整理係が変えたところまでのままで、ターンの終わりの知らせでコミットされる。振り返りのターンが失敗したときも同じく先へ進む。夜の切り替えを止めて日中のセッションを続けるより、次の夜に整理し直せる方を採る。

## 状態コード

成功で body の無いもの（ack・途中経過・ターンの終わり・切り替えの知らせ）は `204`、形が違えば `400`、認証が通らなければ `401`、口の無い道は `404`、道はあるが method が違えば `405`、body が上限（16 MiB）より大きければ `413`。backend が本物の token を設定されていなければ、すべての要求を `401` で断る。
