# UI 向けの API の仕様

Web UI が backend を呼ぶ API を決める。方針は [ADR-0009](adr/0009-web-ui-first-with-a-new-api-and-astryx.md) と
[ADR-0010](adr/0010-github-oauth-for-people-tokenreview-for-a2a.md) にある。型は `packages/contract` の `src/ui.ts` が正である。

**この文書は、画面の一覧と流れをオーナーと合意した後に直す。** ここにあるのは、backend を先に作るための最小の形である。

「未決」と書いた点は、実装の作業単位が決めて、この文書を直す。

## 認証

- backend の GitHub OAuth のログインで作るセッションの cookie で確かめる（[ADR-0010](adr/0010-github-oauth-for-people-tokenreview-for-a2a.md)）。通すのはオーナーの GitHub アカウントだけ。
- cookie が無いか通らなければ `401`。失敗の応答の body は `{error}`。
- セッションの寿命と cookie の形は [backend.md](backend.md) の「オーナーのログイン」にある。

| 口 | 中身 |
| --- | --- |
| `GET /auth/github/start` | GitHub へ送る（`302`）。ログインが設定されていなければ `503`（`login-not-configured`） |
| `GET /auth/github/callback` | GitHub から戻る口。オーナーなら cookie を付けて `/` へ送る（`302`）。そうでなければ `{error}` で断る |
| `POST /auth/logout` | セッションを取り消し、cookie を消す（`204`） |

- callback の断りの `error` は、`invalid-state`・`login-expired`・`invalid-request`（`400`）、`github-denied`・`account-not-allowed`（`403`）、`github-exchange-failed`・`github-unavailable`（`502`）、`too-many-logins`（`429`）のどれか。
- 戻る先は `/` に決めてあり、要求の中身では変わらない。
- `GET /healthz` は認証なしで `200` を返す（配置の確かめのため）。
- `GET /api/agent` と `GET /api/agent/icons/<表情>` は認証なしで読める（「エージェント」）。ログインの画面とホーム画面のアイコンが、ログインの前にエージェントの名前とアイコンを出すためである。この 2 つにはそれ以外のものを載せない。
- `/a2a` と `/a2a/` の下は A2A の受け口で、ログインを使わず、受け口が自分で送り手を確かめる（[a2a.md](a2a.md)）。受け口が閉じていれば `404` で、Web UI のページにはならない。
- `/api/`・`/auth/`・`/a2a/` のほかの道は、Web UI の静的ファイルを配る場所である（「Web UI の配り方」）。

## 口の一覧

| 口 | 中身 |
| --- | --- |
| `POST /api/messages` | オーナーのメッセージを送る |
| `GET /api/history?before=` | 会話の履歴 |
| `GET /api/stream` | 返事・途中経過・状態の流れ（SSE） |
| `GET /api/agent`・`GET /api/agent/icons/<表情>` | エージェントの名前と表情のアイコン（認証なし） |
| `GET /api/agents` | 閉じていないサブエージェントの一覧 |
| `GET /api/approvals`・`POST /api/approvals/<id>` | 承認（後の波） |

## メッセージを送る

- body は `{text}`。添付があるときは `multipart/form-data` で、本文とファイルを並べる。
- backend は `source` が `ui` の出来事にして列に入れる（[events.md](events.md)）。`ui` は inline なので、本文はそのままターンに入る。添付は `/sources/ui/files/` に置かれる。
- 応答は `202` と `{id}`（出来事の `id`）。
- multipart では、本文は `text` の欄、ファイルは `file` の部分を繰り返す。大きさの上限は body の全体で 64 MiB。数の上限は置かない。
- 本文が空でファイルも無ければ `400`。
- 出来事の `summary` は本文の 1 行目（200 文字まで）。本文が空なら、ファイルの数。

## 履歴

- 返事とオーナーのメッセージを、新しい順に返す。応答は `{entries, before?}`。`before` は次の（より古い）ページを取るための不透明な cursor で、最後のページには無い。
- 1 件は `kind`（`owner` か `agent`）・`id`・`at`・`text` を持つ。`agent` のものは、さらに `agent`（エージェントの ID）と `expression` を持つ。
- `agent` のものは、答えている出来事（返事の `in_reply_to`）を backend が知っていれば、`trigger` として、その出来事の `source` と `summary` を持つ。出来事の `payload` は載せない。UI はこれを、エージェントが何をきっかけに話したかの札にする。

- 1 ページは 50 件。backend の渡していない `before` は `400`。
- 途中経過は履歴に含めない。途中経過は流れだけで送る。過去の途中経過を見る画面は後の波。

## 流れ（SSE）

- `GET /api/stream` は Server-Sent Events。出来事の名前（SSE の `event`）と、JSON の `data` を送る。

| `event` | `data` |
| --- | --- |
| `reply` | 返事（履歴の `agent` の 1 件と同じ形） |
| `activity` | `{agent, activity}`。`activity` は sandbox 向けの口の途中経過の 1 件の写し（[sandbox-api.md](sandbox-api.md) の「途中経過」） |
| `state` | `{agent, state}`。`state` は `thinking`（ターンの最中）か `waiting`（出来事を待っている） |
| `agent` | `{agent, purpose, closed}`（型は `SubAgentStatus`）。サブエージェントを起こした・閉じた（「サブエージェント」） |

- 細かさは、sandbox 向けの口と同じくブロックが閉じるごと。トークンごとの流れが UI に要るなら、後で足す。

- SSE の `id` に連番を付ける。つなぎ直したときに `Last-Event-ID` があれば、その後のものから送り直す。backend が覚えているのは最近の 1000 件だけで、backend が再起動すると連番は 1 から数え直す。足りなければ UI が履歴を読み直す。
- Web UI は、最初につなぐときも、つなぎ直すときも `Last-Event-ID: 0` を付け、覚えている分をすべて受け取り直す。今の状態と今のターンの途中経過を、その中の最後の `state` と最後の `turn_start` から後で知るためである（状態だけを返す口は無い）。backend の再起動で連番が戻っても、これなら取りこぼさない。返事は `id` で履歴と重ねる。
- 25 秒ごとに SSE のコメントを送り、つながりを保つ。

未決:

- オーナー自身のメッセージを流れにも送るか（複数のタブで見ているとき）。今は送らない（`StreamEvent` にオーナーのメッセージの形が無い）。

## サブエージェント

サブエージェントは、本体が起こし、runner が回す別のセッションである（[ADR-0022](adr/0022-sub-agents-run-by-the-runner-and-talk-only-to-the-main-agent.md)）。Web UI は見るだけで、サブエージェントを操作する口は無い。

- 流れの `activity` と `state` は、`agent` で本体（`main`）とサブエージェント（サブエージェントの名前）を見分ける。サブエージェントのものは右のパネルのそのサブエージェントの欄に出し、会話の時系列には出さない。
- 返事は本体だけが送るので、履歴と流れの `reply` の `agent` はいつも `main` である。
- `GET /api/agents` は `{agents: [...]}`（型は `SubAgentsResponse`、1 件は `SubAgent`）。1 件は `agent`（サブエージェントの名前）・`purpose`（起こしたときの目的）・`state`（`thinking` か `waiting`）・`started_at`（起こした時刻。backend が最初に `closed: false` を受けた時刻）・`state_since`（今の `state` になった時刻。まだターンの無いサブエージェントは `started_at` と同じ）を持つ。時刻は RFC 3339。並びは、backend がその名前を初めて受けた順。閉じたサブエージェントは載せない。サブエージェントは夜をまたいで残り、流れの覚えている 1000 件からは今のサブエージェントを組み立てられないため、この口を置く。
- 載るのは、runner がサブエージェントを起こしたと知らせた（sandbox 向けの口の `POST /v1/agents`）名前だけである。まだ知らせの無い名前の途中経過は流れには出るが、一覧には載らない。
- `state` と `state_since` は、そのサブエージェントの途中経過の記録の最後の `turn_start` か `turn_end` から引く。時刻はその途中経過の `at` で、backend が立ち上がり直しても変わらない（[sandbox-api.md](sandbox-api.md) の「途中経過」）。
- 流れの `state` は時刻を持たない。UI は受けた時刻を、その `state` になった時刻とする。
- 流れの `agent` は、サブエージェントを起こしたとき（`closed: false`）と閉じたとき（`closed: true`）に送る。UI は、閉じたサブエージェントの欄を消す。閉じたサブエージェントの途中経過は backend の記録に残るが、UI には出さない。
- UI は、最初につなぐときとつなぎ直すときに `GET /api/agents` を読み、その後は流れで直す。

## エージェント

- `GET /api/agent` は `{name, icons?}`。`name` は backend の設定のエージェントの名前（[backend.md](backend.md) の `PENELOPE_AGENT_NAME`、無ければアバターの名前）。`icons` は、設定でアバターを選んでいるとき（`PENELOPE_AVATAR`）だけあり、表情（expression）ごとの画像の道（`/api/agent/icons/<表情>`）を持つ。
- UI はエージェントの名前とアイコンをここから取る。コードと UI に決め打ちの名前を書かない（[ADR-0001](adr/0001-one-pod-with-pi-inside-the-sandbox.md)）。
- UI はアバターを表情ごとの画像で出す（[ADR-0016](adr/0016-show-the-avatar-and-expression-from-the-first-web-ui.md)）。表情が無いとき、アバターに無い表情のときは `neutral` の画像を出し、それも無ければ build に含めた汎用のアイコンを出す。
- `GET /api/agent/icons/<表情>` はその表情の画像を、拡張子の画像の型で返す。無い表情、読めない画像は `404`。

## Web UI の配り方

- `/api/`・`/auth/`・`/a2a/` のほかの道では、backend が `PENELOPE_WEB_DIR` にある Web UI の build（`packages/web` の `dist/`）を配る。`/` は `index.html` である。無いファイルは `404`。
- `/manifest.webmanifest` は backend がその場で作る。名前はエージェントの名前、アイコンはアバターの `neutral` の画像（無ければ build の `icon.svg`）である。ホーム画面に置いて開くため（PWA）。
- `assets/` の下のファイルは中身で名前が決まるので、長く cache させる。ほかは毎回確かめさせる。

## 予約（未実装）

ダッシュボードを少しずつ足す最初の 1 歩として、エージェントの予約（[sandbox-api.md](sandbox-api.md) の「予約」）を Web UI から見て取り消せるようにする。作る作業単位が、口の形を決めてこの節を直す。

- 一覧: 予約の ID・理由・cron の式か 1 回の時刻・次に来る時刻を返す。エージェントの `schedule_list` と同じものを見る。
- 取り消し: ID を指して予約を消す。エージェントの `schedule_remove` と同じ結果になる。消したことはエージェントには知らせない（エージェントは `schedule_list` で知る）。
- 予約を足す口は作らない。予約を足すのはエージェントである。

## これから足すもの

- Web Push の購読の登録と解除、VAPID の公開鍵を渡す道（[ADR-0027](adr/0027-every-reply-sent-by-web-push-with-subscriptions-per-deployment.md)）。
- 返事に結び付いた画像の一覧と、画像を ID で取る口（[ADR-0032](adr/0032-images-attached-to-a-reply-copied-by-the-backend.md)）。
- どの配置でも同じ形に保つ（[ADR-0026](adr/0026-move-natsumi-myao-and-aki-one-deployment-each-without-a-way-back.md)）。

## 承認（後の波）

形だけを置く。最初の版では作らない。

- `GET /api/approvals`: Sentinel の承認待ちの一覧。
- `POST /api/approvals/<id>`: 答える（「この 1 回」か「このホストをずっと」、または断る）。
- backend は Sentinel の管理口へ中継する（[ADR-0005](adr/0005-approvals-held-by-the-sentinel-answered-in-the-web-ui.md)）。中身の形は、管理口の形とともに既定を ask に切り替えるときに決める。
