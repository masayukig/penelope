# receivers の仕様

receivers の設定、HTTP の口、プラグインの内側の契約、Alertmanager のプラグインが出来事を作る形を決める。
方針は [ADR-0002](adr/0002-one-intake-and-a-runner-that-pulls-events.md) と
[ADR-0023](adr/0023-receivers-plugins-in-the-repository-and-alertmanager-first.md) にある。ここにはその形を書く。
出来事の封筒と取り込み口は [events.md](events.md)、コンテナの UID・volume・待ち受けは [pod.md](pod.md) にある。

具体的なホスト名・token の値・配置ごとの名前は、配置のリポジトリの設定にだけ書く。ここの例はすべて架空である。

「未決」と書いた点は、実装の作業単位が決めて、この文書を直す。

## 動かし方

- `receivers serve` で動く。image は引数なしでこれを動かす。`receivers version` は版を出す。
- 設定は 1 つの JSON のファイル。場所は環境変数 `PENELOPE_RECEIVERS_CONFIG` で渡す。既定は `/etc/penelope/receivers/config.json`。
- 鍵の値は設定のファイルに書かず、値を書いたファイルの場所を書く（`_file` で終わる欄）。
- 設定が読めない、または使えない値があれば、起動せずに終わる（終了コード 2）。標準エラーに、どの欄がなぜ使えないかを 1 行書く。
- 設定と鍵のファイルは起動のときに 1 度だけ読む。変えたら再起動する。
- 起動したら、標準エラーに待ち受けのアドレスと、有効化ごとの名前・プラグイン・`source` を 1 行書く。
- SIGTERM で、新しい要求を受けるのをやめ、処理中の要求（取り込み口へ送っているものを含む）を終えてから終わる。終える要求の応答には `Connection: close` を付け、つなぎ置きの接続を残さない。

## 設定

| 欄 | 既定 | 中身 |
| --- | --- | --- |
| `listen` | `0.0.0.0:8081` | HTTP の口の TCP の待ち受け（`host:port`、IPv6 は `[::]:8081`）。backend の `PENELOPE_LISTEN`（既定 `8080`）と同じ Pod で重ならないポートにする。ポートが `0` なら空いているものを使う（テストのため） |
| `intake` | `/run/penelope/intake/backend.sock` | 取り込み口の Unix socket。backend の `PENELOPE_INTAKE_SOCKET` と同じ場所 |
| `intake_timeout_seconds` | `10` | 取り込み口への 1 件の要求を待つ秒数。0 より大きい整数 |
| `plugins` | `[]` | プラグインの有効化の一覧（下の「プラグインの有効化」）。空なら、出来事を作らずに health だけを答える |

- 知らない欄が書かれていれば、起動しない（書き損じを黙って無視しない）。プラグインの `settings` の中も同じである。
- 起動しないときの 1 行は `receivers: <欄>: <理由>` の形である。欄は `plugins[0].settings.token_file` のように、どこにあるかを付けて書く。鍵のファイルが読めないときも、ファイルの場所と読めない理由だけを書き、中身は書かない。

### プラグインの有効化

1 件が、プラグイン 1 つを 1 つの名前と設定で動かすもの。

| 欄 | 必須 | 中身 |
| --- | --- | --- |
| `name` | ○ | 有効化の名前。webhook のプラグインなら URL の `/v1/webhooks/<name>` になる。英小文字・数字・`-` で、1〜32 文字、`-` で始まらない。一覧の中で一意 |
| `plugin` | ○ | プラグインの名前（下の「プラグインの一覧」）。知らない名前なら起動しない |
| `source` | | 取り込み口に送る出来事の `source`。省けば `plugin` の名前。[events.md](events.md) の `source` の文字の制限を満たし、backend の中の受信元の名前（`ui`・`cron`・`a2a`・`self`・`control`）でないもの。一覧の中で一意 |
| `settings` | | プラグインごとの設定（各プラグインの節）。省けば `{}` |

- 1 つの配置に同じ送り手の種類が 2 つあるときは、同じ `plugin` を 2 つ有効にし、`name` と `source` を変える。`source` が重なる設定は起動しない。`id` は `source` の中だけで一意なので、送り手をまたいで ID が重なると、片方が重複として落ちるためである。

### 例

架空の配置。Alertmanager を、前の形から引き継いだ URL `/v1/webhooks/fraction` で受け、`source` を `alertmanager` にする。

| 欄 | 値 |
| --- | --- |
| `plugins[0].name` | `fraction` |
| `plugins[0].plugin` | `alertmanager` |
| `plugins[0].source` | 省く（`alertmanager` になる） |
| `plugins[0].settings.token_file` | `/run/secrets/penelope-receivers/alertmanager-token` |

`listen`・`intake`・`intake_timeout_seconds` は既定のまま省く。2 つ目の Alertmanager を足すなら、`name` を `lab`、`source` を `alertmanager-lab` のようにした有効化を並べる。

### プラグインの一覧

| `plugin` | 種類 | 節 |
| --- | --- | --- |
| `alertmanager` | webhook | 下の「Alertmanager のプラグイン」 |

## HTTP の口

receivers は、`listen` の TCP で HTTP のサーバーを 1 つだけ持つ。Pod の外から呼ばれる口であり、sandbox からも loopback で届くが、扱いは外から届くのと同じである（[pod.md](pod.md) の「待ち受け」）。

| 要求 | 中身 |
| --- | --- |
| `GET /healthz` | `200`、body は `ok`。プロセスが要求を受けられることだけを表す。取り込み口に届くかは確かめない。`HEAD` も受ける。ほかのメソッドは `405`（`Allow: GET, HEAD`） |
| `POST /v1/webhooks/<name>` | webhook のプラグインの有効化 `<name>` が受ける。body の上限は 1 MiB |

| 応答 | 意味 |
| --- | --- |
| `200` | 受けた。作った出来事はすべて取り込み口が `202` で受けた（作った出来事が 0 件のときも同じ） |
| `400` | body が読めない、またはプラグインの形でない。送り直しても通らない |
| `401` | 送り手の確かめを通らない。出来事は作らない |
| `404` | `<name>` の webhook の有効化が無い。ほかの知らないパスも同じ |
| `405` | `/v1/webhooks/<name>` に POST 以外で来た。`Allow: POST` を付ける |
| `413` | body が上限より大きい |
| `503` | 取り込み口が 1 件でも `202` を返さなかった（つながらない・待ちが切れた・`202` 以外の応答）。送り手は同じ知らせを送り直す |

- webhook への応答は、どの番号も body を持たない。
- body の上限（`413`）は本体が、プラグインに渡す前に見る。`Content-Length` が上限を超えていれば読まずに断り、超えていなくても読んだ量が上限を超えたところで断る。
- 確かめ（`401`）は、body を読む（`400`）より先に行う。
- 出来事は 1 件ずつ順に取り込み口へ送り、最初に `202` を受けられなかったところで止めて `503` を返す。それまでに入った出来事は、送り直しのときに backend が重複として落とす。
- 取り込み口が `400`・`413` を返したときも `503` にする。receivers が作った封筒の誤りなので、標準エラーに出来事の `source`・`id` と応答を書く。
- 要求ごとに標準エラーへ 1 行書く: 有効化の名前、応答の番号、取り込み口が受けた出来事の数、捨てたアラートの数。形は `receivers: webhook=<name> status=<番号> events=<数> dropped=<数>` で、有効化に当たらない要求（`404`）の名前は `-` である。`400` のときは、どの欄がなぜ外れたか（`reason="alerts[0]: fingerprint must be a non-empty string"` のように）を後ろに足す。body の中身と鍵は書かない。`/healthz` は書かない。
- 取り込み口に受けられなかったときは、その前にもう 1 行、出来事の `source/id` と理由（応答の番号と body の先頭、つながらない、待ちが切れた）を書く。

## プラグインの内側の契約

receivers の本体（以下、本体）とプラグインの境目。実装はこの境目に従う。

### 本体が持つもの

- 設定のファイルを読み、有効化ごとにプラグインへ `settings` を渡す。
- HTTP のサーバー、パスの振り分け、body の上限、`404`・`405`・`413` の応答、`/healthz`。
- 取り込み口への送信と、その結果からの `200`・`503` の応答。
- 出来事の `source`。プラグインは `source` を知らず、本体が有効化の `source` を付ける。

### プラグインが持つもの

- 名前（設定の `plugin` に書くもの）と種類（いまは webhook だけ）。
- `settings` の確かめ: 起動のときに本体から `settings` を受け、知らない欄・使えない値・読めない鍵のファイルがあれば、理由を付けて断る。本体はそれを受けて起動しない。鍵のファイルを読むのはここである。
- webhook のプラグインは、1 回の要求（ヘッダーと body のバイト列）を受けて、次のどちらかを返す。
  - 断る: 応答の番号（`400` か `401`）。出来事は作らない。`400` には、本体がログに書く理由を付ける。理由は欄の名前と外れ方だけで、body の中身を写さない。
  - 受ける: 出来事の一覧（0 件でもよい）と、捨てたものの数と、本体がログに書く行（Alertmanager の `truncatedAlerts` など。0 行でもよい）。出来事は封筒の `source` を除くすべての欄（`id`・`occurred_at`・`summary`・`stream`・`delivery`・`payload`）を持つ。
- 要求には、本体が受けた時刻を付けて渡す。プラグインは時計を読まない。
- プラグインは取り込み口にも網にも触れない。要求から封筒を作るだけなので、HTTP のサーバーも socket も無しでテストできる。
- 封筒の欄の型は `packages/contract` の `src/events.ts` の `Event` に従う。

未決:

- webhook でないプラグイン（Slack の Socket Mode のように、receivers の方から送り手につなぐもの）の形。最初のそうしたプラグインが決め、この節に足す。

## Alertmanager のプラグイン

Alertmanager の webhook（`webhook_configs`）の知らせを受ける。`plugin` は `alertmanager`、種類は webhook。

### 設定

| `settings` の欄 | 既定 | 中身 |
| --- | --- | --- |
| `token_file` | なし（必須） | Bearer の token を書いたファイル。前後の空白と改行を除いたものが token。読めない・空なら起動しない |
| `now_severities` | `["critical"]` | 鳴り始めを `now` にする `severity` のラベルの値の一覧。`[]` なら、すべて `batch` |
| `drop_labels` | `{"sender": "penelope"}` | 捨てるアラートの印。ラベルの名前から値への対応で、どれか 1 つが一致するアラートを捨てる。`{}` なら捨てない |

送り手の Alertmanager の側は、`http_config.authorization` で `type` を省き（`Bearer`）、`credentials_file` に同じ token を置く。`send_resolved: true` にすると、鳴り止みも届く。

### 確かめ

- `Authorization` が `Bearer <token>` で、`<token>` が設定の token と一致するものだけを通す。`Bearer` の大文字と小文字は問わない。
- 比べるのに要る時間が、どこまで一致したかで変わらない比べ方をする。届いた token と設定の token の SHA-256 を、長さの決まったバイト列どうしで比べるので、token の長さの違いでも時間が変わらない。
- ヘッダーが無い・形が違う・token が違う要求は、どれも同じ `401` で断る。

### body

- UTF-8 の JSON で、`alerts` が配列のもの。アラートはそれぞれ、`status`（`firing` か `resolved`）・`fingerprint`（空でない文字列）・`startsAt`（RFC 3339 の時刻）・`labels`（文字列から文字列への対応）を持つ。1 件でも外れれば、要求の全体を `400` で断る。
- `startsAt` を RFC 3339 の時刻に限るのは、`firing` の出来事の `occurred_at` になるためである。取り込み口は RFC 3339 でない `occurred_at` を `400` で断るので、受けてしまうと送り直しのたびに `503` になる。
- そのほかの欄（`version`・`groupKey`・`groupLabels` など）は確かめない。
- `truncatedAlerts` が 0 より大きければ、送り手が `max_alerts` でアラートを落としている。標準エラーにその数を書く。届いたアラートだけを出来事にする。

### 出来事の作り方

アラート 1 件ごとに、`drop_labels` に当たるものを捨て、残りを 1 件の出来事にする。

| 欄 | 作り方 |
| --- | --- |
| `id` | `<fingerprint>/<status>/<startsAt>`。`startsAt` は届いた文字列のまま |
| `occurred_at` | `firing` なら `startsAt`、`resolved` なら `endsAt`。`endsAt` が無い・RFC 3339 の時刻でない・`0001-01-01T00:00:00Z` なら、受けた時刻 |
| `stream` | `labels.alertname` を下の「`stream` の写し方」で写したもの。`alertname` が無いか、写して空になれば省く |
| `delivery` | `status` が `firing` で、`labels.severity` が `now_severities` にあれば `now`。ほかはすべて `batch`（`severity` のラベルが無いものも）。いつも明示する |
| `summary` | 下の「`summary` の形」 |
| `payload` | 届いたアラート 1 件の JSON をそのまま（欄を足しも削りもしない）に、要求の最上位の `externalURL` を `externalURL` の欄として足したもの。最上位に `externalURL` が無ければ足さない |

#### `stream` の写し方

1. `A`〜`Z` を `a`〜`z` にする。
2. 英小文字・数字・`.`・`_`・`-` のほかの文字（ほかの記号、空白、ASCII の外の文字）を、1 文字ずつ `_` にする。
3. 先頭の `.` を `_` にする。
4. 100 文字までに切る。

例: `KubePodCrashLooping` → `kubepodcrashlooping`、`Disk usage: /var` → `disk_usage___var`。

#### `summary` の形

- `[<状態> <severity>] <alertname>: <annotations.summary>`。`<状態>` は `FIRING` か `RESOLVED`。
- `severity` のラベルが無いか空なら `[<状態>]`。`alertname` が無いか空なら `fingerprint` を置く。`annotations.summary` が無い・空・文字列でないなら、`: ` から後を省く。
- 組み立てた 1 行の中の改行と制御文字（U+0000〜U+001F、U+007F〜U+009F）は、続くものをまとめて空白 1 つにする（`\r\n` も空白 1 つ）。そのうえで 200 文字（Unicode のコードポイント）までに切る。
- 例: `[FIRING critical] KubePodCrashLooping: Pod default/web-0 is crash looping.`

### 置き場所の例

`source` が `alertmanager` なら、上の例のアラートは `/sources/alertmanager/kubepodcrashlooping/<YYYY-MM-DD>.jsonl` に 1 行として足される（[events.md](events.md) の「`/sources`」）。

## 後に足すプラグイン

ADR-0023 が決めず、後の判断に回したもの。それぞれ、決めるときに ADR を書き、この文書に節を足す。

- GitHub の webhook（署名で確かめる。どの出来事を通すか）。
- Slack（Socket Mode か Events API か。`delivery` の決め方。上の「プラグインの内側の契約」の未決）。
- 鳴り続けているアラートの知らせ（いまは鳴り始めと鳴り止みだけ）。
- オーナーへの知らせの仕組みと、エージェントが Alertmanager にアラートを足す道（`drop_labels` の印）との関係。
