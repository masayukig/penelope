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
- `/api/` と `/auth/` のほかの道は、Web UI の静的ファイルを配る場所である（P6b で中身を入れる。それまでは `404`）。

## 口の一覧

| 口 | 中身 |
| --- | --- |
| `POST /api/messages` | オーナーのメッセージを送る |
| `GET /api/history?before=` | 会話の履歴 |
| `GET /api/stream` | 返事・途中経過・状態の流れ（SSE） |
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

- 1 ページは 50 件。backend の渡していない `before` は `400`。
- 途中経過は履歴に含めない。途中経過は流れだけで送る。過去の途中経過を見る画面は後の波。

## 流れ（SSE）

- `GET /api/stream` は Server-Sent Events。出来事の名前（SSE の `event`）と、JSON の `data` を送る。

| `event` | `data` |
| --- | --- |
| `reply` | 返事（履歴の `agent` の 1 件と同じ形） |
| `activity` | `{agent, activity}`。`activity` は sandbox 向けの口の途中経過の 1 件の写し（[sandbox-api.md](sandbox-api.md) の「途中経過」） |
| `state` | `{agent, state}`。`state` は `thinking`（ターンの最中）か `waiting`（出来事を待っている） |

- 細かさは、sandbox 向けの口と同じくブロックが閉じるごと。トークンごとの流れが UI に要るなら、後で足す。

- SSE の `id` に連番を付ける。つなぎ直したときに `Last-Event-ID` があれば、その後のものから送り直す。backend が覚えているのは最近の 1000 件だけで、backend が再起動すると連番は 1 から数え直す。足りなければ UI が履歴を読み直す。
- 25 秒ごとに SSE のコメントを送り、つながりを保つ。

未決:

- オーナー自身のメッセージを流れにも送るか（複数のタブで見ているとき）。今は送らない（`StreamEvent` にオーナーのメッセージの形が無い）。

## 承認（後の波）

形だけを置く。最初の版では作らない。

- `GET /api/approvals`: Sentinel の承認待ちの一覧。
- `POST /api/approvals/<id>`: 答える（「この 1 回」か「このホストをずっと」、または断る）。
- backend は Sentinel の管理口へ中継する（[ADR-0005](adr/0005-approvals-held-by-the-sentinel-answered-in-the-web-ui.md)）。中身の形は、管理口の形とともに既定を ask に切り替えるときに決める。
