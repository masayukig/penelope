# Sentinel の設定と記録の仕様

Sentinel の設定の形と、通信の記録の形を決める。方針は
[ADR-0003](adr/0003-all-egress-through-the-sentinel-passthrough-by-default.md)・[ADR-0004](adr/0004-the-sentinel-keeps-the-keys-through-a-replaceable-source.md)・[ADR-0005](adr/0005-approvals-held-by-the-sentinel-answered-in-the-web-ui.md)・[ADR-0014](adr/0014-sandbox-loopback-left-open-and-pod-ports-on-unix-sockets.md) にある。
Go の型は Sentinel の実装が持ち、この文書に合わせる。

具体的なホスト名・鍵の置き場所・サロゲートの値は、配置のリポジトリの設定にだけ書く。ここの例はすべて架空である。

「未決」と書いた点は、実装の作業単位が決めて、この文書を直す。

## 設定

設定は 1 つの YAML のファイル。

| 欄 | 中身 |
| --- | --- |
| `default` | 開くと決めていないホストの扱い。`passthrough`（素通しで記録だけ）・`ask`（オーナーに聞く）・`deny`。最初は `passthrough` |
| `hosts` | 開くホストの登録の一覧（下の「ホストの登録」） |
| `allow` | 既定が `ask` のときに素通しでよいホストの一覧（後の波）。最初の版は空 |

### ホストの登録

1 件が、開いて（TLS を終端して）鍵を差し替えるホスト 1 つ。

| 欄 | 必須 | 中身 |
| --- | --- | --- |
| `name` | ○ | ホストの名前。SNI と `Host` で照らす |
| `port` | | 既定 443 |
| `upstream` | | 上流の宛先。省けば `name` を名前解決した先へ `port` の TLS で送る（下の「上流」） |
| `upstream_ca` | | 上流の証明書を確かめる CA のファイル。省けばシステムの CA |
| `credentials` | | 鍵の差し替えの一覧（下の「鍵の差し替え」） |
| `connector` | | コネクタの名前。省けばコネクタ無し |
| `connector_config` | | コネクタごとの設定。形はコネクタが決める |

- 特定のホストを特別扱いするコードは書かない。クラスタの API server も、backend も、登録の 1 件である。

### 上流

- `upstream` は上流の宛先を URL で書く汎用の欄である。特定のホストのための欄ではない。
  - `https://<ホスト>:<ポート>`: その宛先へ TLS で送る。上流の証明書は `upstream_ca`（省けばシステムの CA）で確かめる。
  - `http://<ホスト>:<ポート>`: その宛先へ TLS でなく送る。
  - `unix://<socket のパス>`: その Unix socket へ、TLS でない HTTP で送る（例: `unix:///run/penelope/backend/sandbox.sock`）。
- sandbox からの通信は、どの場合も sandbox との間では Sentinel の CA の証明書で TLS を終端する。
- backend の sandbox 向けの口は、この欄で backend の Unix socket を指して登録する（[ADR-0014](adr/0014-sandbox-loopback-left-open-and-pod-ports-on-unix-sockets.md)）。

### コネクタ

- コネクタは、1 つのホストに特化した判定や処理を差し込むプラグインである（[ADR-0003](adr/0003-all-egress-through-the-sentinel-passthrough-by-default.md)）。判定、そのホストに特有の鍵の扱い（body に鍵を含める要求や署名など、差し替えでは扱えないもの。[ADR-0004](adr/0004-the-sentinel-keeps-the-keys-through-a-replaceable-source.md)）、記録を詳しくすることを受け持つ。
- **最初の版の Sentinel はコネクタを 1 つも持たない。** `connector` が書かれた登録があれば、「知らないコネクタ」として起動しない（黙って無視しない）。動いている最中の読み直しなら、前の設定のまま動き続ける（[ADR-0003](adr/0003-all-egress-through-the-sentinel-passthrough-by-default.md) の Decision「守る対象と、失敗したときの倒し方」）。

未決:

- コネクタの差し込み口（Go の interface）の形。最初のコネクタを作るときに決める。

### 鍵の差し替え

`credentials` の 1 件が、要求の 1 か所のサロゲートを本物の鍵に差し替える。

| 欄 | 必須 | 中身 |
| --- | --- | --- |
| `place` | ○ | 置き場所。`bearer`（`Authorization` の Bearer と token）・`basic`（`Authorization` の Basic のパスワードの部分）・`header`（名前を決めたヘッダ） |
| `header` | `place` が `header` のとき | ヘッダの名前（例: `x-api-key`） |
| `surrogate` | ○ | sandbox に置くサロゲートの値 |
| `source` | ○ | 鍵の出どころ。最初は `{file: <パス>}` だけ |

- 鍵のファイルは使うたびに読み直す（kubelet が作り直す ServiceAccount の token を指せるようにするため）。
- 鍵の出どころから鍵が読めないときは、その要求を上流へ送らずに断る。
- query の置き場所は後から足す。

例（架空の値）:

```yaml
default: passthrough
hosts:
  - name: api.example.com
    credentials:
      - place: bearer
        surrogate: surrogate-example-0001
        source: { file: /run/secrets/example/token }
  - name: backend.example.com
    upstream: unix:///run/penelope/backend/sandbox.sock
    credentials:
      - place: bearer
        surrogate: surrogate-example-0003
        source: { file: /run/secrets/example/backend-token }
  - name: kubernetes.default.svc
    upstream_ca: /run/secrets/example/ca.crt
    credentials:
      - place: bearer
        surrogate: surrogate-example-0002
        source: { file: /run/secrets/example/sa-token }
allow: []
```

未決:

- サロゲートの値の形（長さ、文字、本物の鍵と見分けられる接頭辞を持つか）。
- 登録したホストへの要求にサロゲートが無いとき（オーナーが自分の鍵を入れて呼んだときなど）の扱い（案: そのまま送る）。
- `Host` が登録の `name` と違うとき（SNI とずれる要求）の扱い（案: 断る）。
- Sentinel 自身の待ち受け・CA の鍵・名前解決の上流・管理口の socket・記録の出し先の欄（Sentinel の実装の作業単位で足す）。
- 設定の読み直しのきっかけ（ファイルの変化か、合図か）。

## 登録の無いホストへのサロゲート

- サロゲートが、登録の無いホスト、または登録に無い置き場所で出ていくときは、その要求を断り、記録に残す（[ADR-0004](adr/0004-the-sentinel-keeps-the-keys-through-a-replaceable-source.md) の「本 ADR で決定しないこと」で委ねられた点）。
- Sentinel が見えるのは、開いた（TLS を終端した）通信と、平文の HTTP の中身だけである。素通しの TLS の中のサロゲートは見えないままとし、見つけるために開くことはしない。出ていくのはサロゲートであり、本物の鍵ではないためである。

未決:

- 断るときの応答（案: `403` と、理由を書いた短い本文）。

## Sentinel が断る通信

- リンクローカル（169.254.0.0/16、fe80::/10）への通信。sandbox の UID のものは iptables で Sentinel へ向け直されてくるので、Sentinel が断り、記録に残す（[ADR-0014](adr/0014-sandbox-loopback-left-open-and-pod-ports-on-unix-sockets.md)）。
- 向け直しの受け口へ直に届いた通信（向け直される前の宛先が受け口そのもの）。sandbox の loopback は止めないので、sandbox から受け口へ直につなげるためである。
- 登録の無いホストへのサロゲート（上の節）と、鍵の出どころから鍵が読めない要求。

## 記録

- 1 つの通信を 1 行の JSON にする。素通しの通信も、開いた通信も、止めた通信も残す。
- 鍵の値は記録に出さない。サロゲートも出さない。

| 欄 | 中身 |
| --- | --- |
| `time` | 通信の始まり（RFC 3339） |
| `uid` | 送り手の UID |
| `agent` | エージェントの ID。分かるときだけ（[sandbox-api.md](sandbox-api.md) の「`agent` の欄」。同じ UID なので、要求の中身から分かるときに限る） |
| `host` | 宛先の名前（SNI か `Host`、名前解決の要求なら問い合わせた名前） |
| `addr`・`port` | 宛先のアドレスとポート |
| `action` | `passthrough`・`open`・`deny`（後の波で `ask`） |
| `reason` | `deny` のときの理由 |
| `method`・`path`・`status` | 開いたとき、または平文の HTTP のときだけ |
| `bytes_in`・`bytes_out` | 量 |
| `duration_ms` | 時間 |

未決:

- 欄の名前（上は案）。
- 記録の出し先（案: 標準出力。保存期間と見方は、クラスタのログの集め方に任せる）。
- 名前解決の要求を 1 件ずつ記録するか。
- 管理口の API の形と、承認待ちの期限（[ADR-0005](adr/0005-approvals-held-by-the-sentinel-answered-in-the-web-ui.md)。既定を ask に切り替えるときに決める）。
