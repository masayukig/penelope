# A2A の受け口の仕様

ほかのエージェントが A2A でペネロペに頼む受け口を決める。方針は
[ADR-0010](adr/0010-github-oauth-for-people-tokenreview-for-a2a.md) と [ADR-0018](adr/0018-a2a-tasks-in-the-backend-and-replaceable-sender-checks.md) にある。
受けた依頼が出来事になる形は [events.md](events.md)、エージェントが返す口は [sandbox-api.md](sandbox-api.md) の「A2A の Task に返す」、設定は [backend.md](backend.md) の「設定」にある。
型は `packages/contract` の `src/events.ts`（`A2APayload`）と `src/sandbox.ts`（`A2AReplyRequest`・`A2ATaskState`）が正である。

## 道

backend の UI 向けの API と同じ TCP の待ち受け（`PENELOPE_LISTEN`）に置く。

| 道 | 中身 |
| --- | --- |
| `GET /.well-known/agent-card.json` | Agent Card。token なしで読める |
| `POST /a2a/`（`POST /a2a` も同じ） | JSON-RPC の呼び出し |

- 受け口が閉じているとき（送り手の allow-list が空のとき）は、ルートの Agent Card、`/a2a`、`/a2a/` の下のすべての道が `404`（`{error}`）になる。Web UI のページは返さない。
- これらの道には、オーナーのログインの cookie は要らず、使わない。

## 版と呼び出し

- A2A 1.0 の JSON-RPC で受ける。送り手は `A2A-Version: 1.0` を付けて呼ぶ。版のヘッダが無い呼び出しは 0.3 として扱われ、版が合わないとして断られる。
- 受ける呼び出しは `SendMessage` と `GetTask` だけである。

| 呼び出し | 答え |
| --- | --- |
| `SendMessage` | Task。新しい依頼なら新しい Task、聞き返しへの答えならその Task |
| `GetTask` | 送り手自身の Task |
| `SendStreamingMessage`・`SubscribeToTask` | `UnsupportedOperation`（JSON の 1 つの答え。流れにはしない） |
| `CancelTask`・`ListTasks`・`GetExtendedAgentCard` | `UnsupportedOperation` |
| push 通知の設定の呼び出し | `PushNotificationNotSupported` |

- `SendMessage` の `configuration.historyLength` と `GetTask` の `historyLength` を渡されたら、Task の `history` をその数の最後の分だけにする（0 なら空）。渡されなければすべて。

## Agent Card

接続設定の宛先にはホストのルート（例: `https://helper.agents.example.com/`）を書き、a2a-cli の `-a` にそのまま渡す。
a2a-cli はルートの `/.well-known/agent-card.json` から Agent Card を読み、`a2a send` は Card に書かれた `/a2a/` の呼び出し口へ送る。

| 欄 | 中身 |
| --- | --- |
| `name` | エージェントの名前（`PENELOPE_AGENT_NAME`、無ければアバターの名前。UI に出す名前と同じ） |
| `description` | `PENELOPE_A2A_DESCRIPTION` |
| `supportedInterfaces` | 1 つ。`url` は `PENELOPE_PUBLIC_URL` の `/a2a/`、`protocolBinding` は `JSONRPC`、`protocolVersion` は `1.0` |
| `capabilities` | ストリーミング・push 通知・拡張の card のどれも無い |
| `securitySchemes` | `bearer`（HTTP の Bearer）1 つ |
| `defaultInputModes`・`defaultOutputModes` | `text/plain`・`image/png`・`image/jpeg`・`image/gif`・`image/webp` |

- 応答は `Cache-Control: public, max-age=300`。

## 送り手の確かめ

すべての JSON-RPC の呼び出しで、送り手を確かめてから本文を読む。

- 確かめ方は `PENELOPE_A2A_AUTH` で選ぶ。`gated-assertion`・`tokenreview` のどちらか、または両方。
- 呼び出しは、それが持つヘッダの確かめ方で決める。`Gated-Assertion` があれば `gated-assertion`、無くて `Authorization: Bearer` があれば `tokenreview`。選ばれていない確かめ方のヘッダは無いものとして扱う。どちらのヘッダも無ければ通らない。
- 確かめ方が言う ServiceAccount（`system:serviceaccount:<名前空間>:<名前>`）を、allow-list（`PENELOPE_A2A_SENDERS` の `<名前空間>/<名前>` の一覧）と照らす。載っていれば、その ServiceAccount の名前が送り手の名前である。送り手の名前は `/sources/a2a/` の下の `stream` になるので、allow-list に同じ名前は 2 つ置けない。

### `gated-assertion`

gated の後ろで受けるときの確かめ方。gated は、gated の audience の ServiceAccount の token を `Authorization` ごと落とし、確かめた主体を署名した `Gated-Assertion` に入れて転送する。

- JWS の compact 形式で、`alg` は `EdDSA`、`typ` は `gated-assertion+jwt` だけを受ける。
- 鍵は `PENELOPE_A2A_GATED_JWKS_URL` の JWKS から取り、assertion からは取らない。鍵は最長 5 分持ち、知らない `kid` は前に取ってから 1 分以上空いていれば取り直す。取れないときは持っている鍵を使い続け、1 分後に取り直す。
- `iss` は `PENELOPE_A2A_GATED_ISSUER` と同じ、`aud` は `PENELOPE_PUBLIC_URL` のホスト名（小文字、ポートなし）を含む、`exp` は過ぎていない、`iat` は先の時刻でない（どちらも 30 秒のずれまで）。
- `sub` が ServiceAccount の主体である。

### `tokenreview`

`Authorization: Bearer` の token を、Kubernetes の TokenReview（`authentication.k8s.io/v1`）で API server に尋ねる。

- 尋ねる先は `PENELOPE_KUBERNETES_URL`、無ければクラスタの中の `KUBERNETES_SERVICE_HOST` と `KUBERNETES_SERVICE_PORT`。API server の証明書は `PENELOPE_KUBERNETES_CA_FILE` の CA で確かめる。
- backend 自身の ServiceAccount の token（`PENELOPE_KUBERNETES_TOKEN_FILE`）を `Authorization: Bearer` に付けて尋ねる。token のファイルは尋ねるたびに読み直す（kubelet が作り直すため）。
- `spec.audiences` に `PENELOPE_A2A_AUDIENCES` を置く。答えの `status.authenticated` が真で、`status.audiences` に置いた audience のどれかがあるものだけを通す。`status.user.username` が ServiceAccount の主体である。
- 答えを待つのは 10 秒まで。API server が `200`・`201` 以外で答えたとき、届かないときは、答えが得られないものとする。

### 断り方

| 場合 | 状態コード | body |
| --- | --- | --- |
| 確かめが通らない（ヘッダが無い、形・署名・発行元・宛先・期限・audience が合わない、TokenReview が認めない、allow-list に無い） | `401` | `{"error": "unauthorized"}`。どこで外れたかは書かない |
| 確かめの答えが得られない（API server に届かない、gated の鍵が取れず鍵が無い） | `503` | `{error}`。送り直せば通り得る |
| method が `POST` でない | `405` | `{error}` |

- `401` と `503` は `Connection: close` を付ける。
- 断った呼び出しは、送り手の名前を知らないまま、外れた理由だけを backend のログに残す。token と assertion の値は残さない。

## 依頼の扱い

- 本文（JSON-RPC の body 全体）は 32 MiB まで。読み込み中に超えれば `413`。JSON でなければ `400` と JSON-RPC の `-32700`。
- 文章（`text`）だけ、画像（`raw`）だけ、または混在を受ける。文章の部分は改行でつなぐ。画像は復号後で 1 枚 5 MiB、1 メッセージに 4 枚まで。
- `raw` は PNG・JPEG・GIF・WebP の base64 を受ける。種類を中身の先頭のバイトで見分け、`mediaType` があれば照合する。URL（`url`）や構造化データ（`data`）、不正な base64、種類が合わないファイルは `ContentTypeNotSupported`。不適合な部品が 1 つでもあればメッセージごと断る。backend は画像を取りに行かない。
- 文は 1 MiB（UTF-8）まで。超える文、空白以外の文も画像も無いメッセージは `InvalidRequest` で断る。

### 新しい依頼

`taskId` の無いメッセージは、新しい依頼である。

- `contextId` があれば、その送り手に前に渡した context でなければならない。違えば `InvalidRequest`。無ければ backend が新しく付ける。
- 送り手の開いている Task（`working` と `input-required`）が上限（`PENELOPE_A2A_MAX_OPEN_TASKS`）に達していれば、`rejected` の Task を返す。出来事にはせず、画像も保存しない。
- そうでなければ、`working` の Task を作り、メッセージを `a2a` の出来事にしてから返す（[events.md](events.md) の「A2A の出来事」）。出来事を `/sources` に書けなければ、Task も残さず、JSON-RPC の内部の失敗（`-32603`、状態コード `500`）を返す。送り手は送り直す。

### 聞き返しへの答え

`taskId` のあるメッセージは、その Task への答えである。

| Task | 扱い |
| --- | --- |
| 無い、または別の送り手のもの | `TaskNotFound` |
| `contextId` が Task のものと違う | `InvalidRequest` |
| `working`（聞き返していない） | `UnsupportedOperation`。足したいことは新しい依頼にする |
| `completed`・`failed`・`rejected` | `UnsupportedOperation` |
| `input-required` | 新しい依頼と同じ条件で文章や画像を受け、`a2a` の出来事にして `working` に戻す。添付を保存できなければ出来事を残さず、状態は変えない |

### 期限

- 開いている Task は、送り手の最後のメッセージ（依頼か、聞き返しへの答え）から `PENELOPE_A2A_DEADLINE_HOURS` 時間で `failed` になる。聞き返しの間も数える。
- 期限は Task を読むとき・書くときに確かめる。時計で見回ることはしない。`failed` にしたことは出来事にしない。
- 催促はしない。

## Task の見せ方

| 欄 | 中身 |
| --- | --- |
| `id`・`contextId` | backend が付けたもの |
| `status.state` | `TASK_STATE_WORKING`・`TASK_STATE_INPUT_REQUIRED`・`TASK_STATE_COMPLETED`・`TASK_STATE_FAILED`・`TASK_STATE_REJECTED` |
| `status.message` | `input-required` の間はエージェントの聞き返しの文、`failed`・`rejected` では理由。ほかは無い |
| `status.timestamp` | 最後に状態が変わった時刻 |
| `artifacts` | `completed` で文または画像があれば、名前 `response` の artifact 1 つ。文章の部分（任意）の後に画像の部分（`raw`・`mediaType`・`filename`）を並べる。ファイル名にディレクトリはなく、同じ artifact 内では重ならない |
| `history` | 送り手（`ROLE_USER`）とエージェント（`ROLE_AGENT`）の文章を順に並べ、画像が添えられたメッセージには `[Images attached]` を付ける。画像本体やパスは載せない |

- 期限で `failed` になった Task と `rejected` の Task も、送り手は `GetTask` で読める。
- 成果画像の写しが 1 枚でも読めなければ、画像を省いた Task は返さない。`GetTask` は HTTP `500` と JSON-RPC の内部エラー（`-32603`）を返す。Task の状態は変えず、写しの保存先も公開しない。

## 状態

- Task とメッセージは SQLite の `a2a_tasks` と `a2a_messages` に置く。送り手のメッセージの行は、それがなった出来事の `seq` を持つ。エージェントの返事は、この `seq` で Task を引く。
- 受信画像は `/sources/a2a/files/` に保存し、Task に二重には保存しない。完了時に返した画像の写しは `PENELOPE_ASSETS_DIR` にファイルとして保存し、Task と同じ寿命を持つ。`a2a_tasks.response_images` は画像本体を持たず、置き場のファイル名・artifact のファイル名・MIME を返事の順番で並べた JSON を持つ。`a2a_messages.has_images` は添付の有無だけを記録する。
- 既存の DB は backend の起動時に schema 11 へ自動で移行する。一方通行で、移行後の DB は旧版 backend では開けない。旧版に戻すには移行前の DB が必要である。
- 消さない。いつまで残すかは、量が問題になったときに決める（[backend.md](backend.md) の「状態」）。
