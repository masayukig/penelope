# 出来事の仕様

エージェントに届く出来事の封筒、取り込み口、`/sources` の置き方、出来事がターンに入る形を決める。
方針は [ADR-0002](adr/0002-one-intake-and-a-runner-that-pulls-events.md) と
[ADR-0013](adr/0013-event-contents-in-sources-and-summaries-in-turns.md) にある。ここにはその形を書く。
型は `packages/contract` の `src/events.ts` と `src/sandbox.ts` が正である。

「未決」と書いた点は、実装の作業単位が決めて、この文書を直す。

## 封筒

受信元が取り込み口へ送る 1 件の出来事。

| 欄 | 必須 | 中身 |
| --- | --- | --- |
| `source` | ○ | 受信元の名前。`/sources` の最初のディレクトリにもなる。backend の中の受信元は `ui`・`cron`・`a2a`・`self`・`control` |
| `id` | ○ | 受信元が付ける。`source` と組で一意。重複を除くキー |
| `occurred_at` | ○ | 起きた時刻（RFC 3339） |
| `summary` | ○ | 1 行の要約。人とモデルが読む |
| `stream` | | `/sources/<source>/` の中の分け先（Slack のチャンネルなど） |
| `delivery` | | `now` か `batch`。省けば受信元の既定（下の「`delivery`」） |
| `payload` | ○ | 受信元の中身そのまま（任意の JSON）。backend は形を知らない |

backend は受けたときに、単調増加の整数 `seq` と、受けた時刻 `received_at` を付ける。順番は `seq` の順である。

`source` と `stream` は `/sources` のパスの一部になる。使えるのは英小文字・数字・`.`・`_`・`-` で、`.` で始まらないものだけである。外れた出来事は `400` で断る。`/` や `..` で `/sources` の外や別の受信元の場所を指せないようにするためである。

### 配送の約束

- 少なくとも 1 回。受信元は、`202` を受け取れなければ同じ `id` で送り直す。
- `(source, id)` が既にあれば、受けたことにして何もしない。`/sources` にも書かない。

### `delivery`

- `now`: すぐにターンへ。ターンの最中なら割り込み（steer）、待っていれば新しいターン。起きている時間の外でも。
- `batch`: `/sources` にはすぐ書くが、ターンへはまとめて後で渡す。いつ渡すかは backend が決める（下の「いつ渡すか」）。
- **決めるのは受信元の側だけ**である。receivers のプラグインは自分の設定（例: Slack ならメンションと DM は `now`）に従って出来事ごとに付ける。backend はそれを上書きしない。
- 封筒で省いたときの既定は、receivers のプラグインなら `batch`。backend の中の受信元（`ui`・`cron`・`a2a`・`self`）は backend の設定で決め、既定はどれも `now`。`control` は常に `now`。

### `inline`

- 中身（`payload`）をそのままターンに載せる受信元。封筒の欄ではなく、backend の設定で受信元ごとに決める。
- 最初は `ui`（オーナーのメッセージ）と `control`（制御の出来事）だけ。
- inline の出来事も、ほかと同じく `/sources` に書く。

### 制御の出来事

- `source` は `control`。runner が受けて手順を回し、エージェントのターンには入らない。
- 最初は夜の切り替えだけである。backend が夜の時刻に `payload` が `{kind: "nightly"}` の出来事を列に入れ、runner が振り返り → 整理係 → 新しいセッションを回す（[ADR-0007](adr/0007-one-session-switched-nightly-with-a-one-turn-curator.md)）。終わったら runner が知らせる（[sandbox-api.md](sandbox-api.md) の「セッションの切り替えの知らせ」）。

### 予約の出来事

- エージェントの予約（[sandbox-api.md](sandbox-api.md) の「予約」）の時刻が来ると、backend が `source` が `cron` の出来事を列に入れる。
- `payload` は予約の ID（`schedule_id`）と理由（`reason`）。`summary` は理由。

## 取り込み口

- Unix socket の上の HTTP。socket は backend と receivers だけが mount する volume に置く（[pod.md](pod.md)）。
- backend の中の受信元は、HTTP を通らず、同じ取り込みの処理を直接呼ぶ。

| 要求 | 中身 |
| --- | --- |
| `POST /v1/events` | body は封筒の JSON（`Content-Type: application/json`）。添付があるときは `multipart/form-data` で、封筒の JSON の部分と、ファイルの部分を並べる |

| 応答 | 意味 |
| --- | --- |
| `202` | 受けた。重複も同じ |
| `400` | 形が違う。body は `{error}`。送り直しても通らない |
| `5xx` | 受けていない。同じ `id` で送り直す |

未決:

- multipart の部分の名前（案: 封筒は `event`、ファイルは `file` を繰り返す。ファイルの名前は部分の filename）。
- 封筒とファイルの大きさの上限。
- `202` の body（案: 無し）。

## `/sources`

- **書くのは backend だけ。** 追記するだけで、書き換えない。git にはしない。
- sandbox は読むだけ。receivers は mount しない。
- 置き場所:
  - 出来事 1 件を JSON の 1 行として、`/sources/<source>/<stream>/<YYYY-MM-DD>.jsonl` に追記する。`stream` が無ければ `/sources/<source>/<YYYY-MM-DD>.jsonl`。
  - 添付は `/sources/<source>/files/<seq>-<ファイルの名前>`。
- 1 行は、封筒の欄と backend が付けた欄を `payload` と並べたものである（型は `SourcesLine`）。

| 欄 | 中身 |
| --- | --- |
| `seq`・`received_at` | backend が付けたもの |
| `occurred_at`・`source`・`stream`・`id`・`summary` | 封筒のもの（`stream` は無ければ省く） |
| `attachments` | 添付のパスの一覧（無ければ省く） |
| `payload` | 封筒の `payload` そのまま |
- 保存期間は backend の設定。日付のファイルごとに消す。

未決:

- ファイルの日付をどの時刻（`received_at` か `occurred_at`）の、どの時間帯で決めるか（案: `received_at` を backend の設定の時間帯で）。
- 添付のファイルの名前に使える文字と、同じ名前が重なったときの扱い。

### 例: Slack の記録

Slack のプラグインは、起きたことを 1 件ずつ出来事にする。下の表は、その `payload` が持つものである。発言・編集・削除・絵文字・スレッドの返信のどれも、起きた日のファイルに 1 行として足される。今の姿は書き換えずに、行を組み立てて作る。

| 起きたこと | `payload` が持つもの（例） |
| --- | --- |
| 発言 | `type: message`、`ts`、本文、送り手 |
| スレッドの返信 | `type: message`、`ts`、`thread_ts`（スレッドの親の `ts`）、本文 |
| 編集 | `type: message_changed`、元の発言の `ts`、新しい本文 |
| 削除 | `type: message_deleted`、元の発言の `ts` |
| 絵文字 | `type: reaction_added` か `reaction_removed`、付けた発言の `ts`、絵文字の名前 |

`payload` の形そのものは Slack のプラグインが決め、プラグインの文書に書く。読むための CLI（チャンネルの最近の流れやスレッドを今の姿に組み立てて出す）はプラグインが持ち、sandbox の image に入る。

## ターンに入る形

runner は sandbox 向けの口で出来事を受け取り（[sandbox-api.md](sandbox-api.md)）、次の形でターンに入れる。

- inline の出来事: 中身そのもの（オーナーのメッセージなら本文と添付の場所）。
  - inline の出来事に付いた画像（拡張子が `.png`・`.jpg`・`.jpeg`・`.gif`・`.webp` のもの）は、場所に加えて、画像としてもターンに載せる。runner が `/sources` から読み、Pi の画像の入力として渡す。1 つの入力に 4 枚まで、runner の設定の大きさ（既定 5 MiB）を超えるものと読めないものは載せず、場所だけにする。
  - inline でない出来事の画像は場所だけである。エージェントが Pi の `read` で開く。
- inline でない出来事: `source`・`stream`・`summary` と、足された場所（ファイルと行の範囲、1 始まり・両端を含む）。中身は、エージェントが必要なときに sandbox の shell でそのファイルを読む。
- `batch` のまとめ: 受信元と `stream` ごとに、件数と足された場所を並べた 1 つの入力。

### いつ渡すか

- **いつ渡すかは backend が決め、渡す時が来た出来事だけを sandbox 向けの口で返す**（[sandbox-api.md](sandbox-api.md) の「出来事を取る」）。runner は時を数えない。
- `now`: backend はすぐに渡す。runner は、ターンの最中なら steer、待っていれば新しいターンにする。
- `batch`: backend は、受信元と `stream` をまたいで、まだ渡していない `batch` の最初の 1 件を受けると待ちを始める。待ちは、新しい `batch` の出来事が来るたびに N 分先まで延び、最初の 1 件から M 分で打ち切る。待ちが終わったら、それまでに溜まったものを一度に渡す。起きている時間の外に来たものは、朝まで渡さない。
  - N・M・起きている時間は backend の設定。既定は N が 5 分、M が 30 分。
- runner は、一度に渡された `batch` の出来事を 1 つの入力にまとめる。ターンの最中に渡されたときは steer にせず、そのターンの後に follow-up で入れる。
