# Pod の形の仕様

1 つの Pod に並ぶ 4 つのコンテナと、その UID・volume・網の向け直しを決める。sandbox の image と、配置のリポジトリの manifest は、これに合わせる。
方針は [ADR-0001](adr/0001-one-pod-with-pi-inside-the-sandbox.md)・[ADR-0002](adr/0002-one-intake-and-a-runner-that-pulls-events.md)・[ADR-0003](adr/0003-all-egress-through-the-sentinel-passthrough-by-default.md)・[ADR-0004](adr/0004-the-sentinel-keeps-the-keys-through-a-replaceable-source.md)・[ADR-0006](adr/0006-memory-kept-compatible-without-checks-committed-outside.md)・[ADR-0011](adr/0011-a-full-dev-image-and-a-generic-user-home.md)・[ADR-0013](adr/0013-event-contents-in-sources-and-summaries-in-turns.md)・[ADR-0014](adr/0014-sandbox-loopback-left-open-and-pod-ports-on-unix-sockets.md) にある。

「未決」と書いた点は、実装の作業単位が決めて、この文書を直す。

## コンテナ

| コンテナ | UID | 持つもの |
| --- | --- | --- |
| sandbox | 1000（ユーザー `agent`、HOME `/home/agent`） | runner と Pi、開発の道具。サロゲートだけ |
| backend | sandbox と別 | 取り込み口と待ち行列、sandbox 向けの口、UI 向けの API |
| Sentinel | sandbox と別 | 透過の受け口、本物の鍵、CA の鍵、管理口 |
| receivers | sandbox と別 | 受信のプラグイン、受信の鍵 |

未決:

- sandbox のほかの 3 つの UID の値（それぞれ別にするか）。

## volume

| volume | sandbox | backend | Sentinel | receivers |
| --- | --- | --- | --- | --- |
| `/memory` の作業ツリー（永続） | 読み書き | 読み書き | — | — |
| `/memory/.git`（同じ永続の場所） | 読み取りで重ねる | 読み書き | — | — |
| `/home/agent`（永続） | 読み書き | — | — | — |
| backend の SQLite（永続） | — | 読み書き | — | — |
| `/sources`（永続） | 読み取り | 読み書き | — | — |
| 取り込み口の socket（emptyDir） | — | 読み書き | — | 読み書き |
| backend の sandbox 向けの口の socket（emptyDir） | — | 読み書き | 読み書き | — |
| Sentinel の管理口の socket（emptyDir） | — | 読み書き | 読み書き | — |
| 鍵の Secret・CA の鍵 | — | — | 読み取り | — |
| Sentinel の CA の公開の証明書（`/etc/penelope/ca/`） | 読み取り | — | — | — |
| projected の ServiceAccount の token | — | 読み取り | 読み取り | — |
| 受信の鍵の Secret | — | — | — | 読み取り |

- Pi のディレクトリ（設定・認証・モデル・skill）とセッションの記録は HOME の下に置く（`/home/agent/.pi/agent/`、セッションは `/home/agent/.pi/agent/sessions/main/`）。別の volume にはしない。HOME が永続なので足りる。
- `/memory` の `.git` は sandbox からは読むだけである。backend がターンの終わりにコミットする（[ADR-0006](adr/0006-memory-kept-compatible-without-checks-committed-outside.md)）。
- `/sources` を書くのは backend だけ（[events.md](events.md)）。receivers は mount しない。
- 取り込み口の socket は sandbox に mount しない。送れるのは socket が見えるコンテナだけである（[ADR-0002](adr/0002-one-intake-and-a-runner-that-pulls-events.md)）。
- 管理口の socket も sandbox に mount しない（[ADR-0005](adr/0005-approvals-held-by-the-sentinel-answered-in-the-web-ui.md)）。
- backend の sandbox 向けの口の socket は、backend と Sentinel だけが mount する。Sentinel は backend の登録の `upstream` でこの socket につなぐ（[sentinel-config.md](sentinel-config.md) の「上流」）。

## 待ち受け

Pod の中のコンテナは網の名前空間を共有するので、TCP の待ち受けには sandbox からも loopback で届く。そのため、Pod の中のコンテナどうしのための口は Unix socket だけで待ち受ける（[ADR-0014](adr/0014-sandbox-loopback-left-open-and-pod-ports-on-unix-sockets.md)）。

| コンテナ | Unix socket だけで待ち受ける口 | TCP で待ち受ける口 |
| --- | --- | --- |
| backend | 取り込み口、sandbox 向けの口 | Pod の外から呼ばれる口（UI 向けの API と A2A の受け口） |
| Sentinel | 管理口 | 向け直しの受け口（直に届いた通信は断る） |
| receivers | なし | Pod の外から呼ばれる口（webhook の受け口） |
| sandbox | — | sandbox の自由（loopback は止めない） |

- TCP で待ち受ける Pod の外から呼ばれる口は、Pod の外から届くのと同じ確かめ（ログインのセッション、ServiceAccount の token、webhook の署名）を通す。sandbox からも loopback で届くが、扱いは外から届くのと同じである。

未決:

- 永続の場所を PVC いくつに分けるか、各 volume の mount の場所（`/memory`・`/home/agent`・`/sources` のほか）。

## 網

- init container が iptables で、sandbox の UID の外向きの通信（TCP と名前解決、IPv4 と IPv6）を Sentinel へ向け直す。sandbox のコンテナは NET_ADMIN を持たない。
- sandbox の UID の loopback への通信は、向け直しも止めもしない。backend の取り込み口・sandbox 向けの口と Sentinel の管理口には、TCP の待ち受けが無いので、loopback からは届かない（上の「待ち受け」）。
- リンクローカル（169.254.0.0/16、fe80::/10）への通信も Sentinel へ向け直し、Sentinel が断って記録に残す。
- ほかのコンテナの UID の通信は向け直さない。

未決:

- UDP（名前解決のほか）の扱い。
- 向け直しの先のポート。

## ServiceAccount の token

- Pod は `automountServiceAccountToken: false`。
- projected の token は Sentinel と backend のコンテナにだけ明示して mount する。Sentinel はそれを鍵の出どころにし、backend は A2A の送り手を確かめる TokenReview に使う（[ADR-0010](adr/0010-github-oauth-for-people-tokenreview-for-a2a.md)）。
- sandbox には、サロゲートを持つ kubeconfig だけを置く。

## CA

- Sentinel の CA の公開の証明書を、sandbox のシステムの信頼の置き場に入れ、Node と Python がシステムの束を使うよう環境変数を設定する（[ADR-0003](adr/0003-all-egress-through-the-sentinel-passthrough-by-default.md) の Decision「CA は image で信頼させる」）。

- 公開の証明書は、起動のときに volume から足す。CA の鍵を Pod ごとに作る形でも、Secret に置く形でも同じ image で済むためである。
  - 公開の証明書（PEM、拡張子 `.crt`）を sandbox の `/etc/penelope/ca/` に読み取りで mount する。
  - image の entrypoint が、runner を動かす前に、Debian の束（image が `/usr/share/penelope/ca-certificates.crt` に写しておくもの）とその証明書をつないで、システムの束 `/etc/ssl/certs/ca-certificates.crt` に書く。この束は image でユーザー `agent` が書けるようにしてある。Pi のモデルへの最初の通信より前に入る。
  - `SSL_CERT_FILE`・`NODE_EXTRA_CA_CERTS`・`REQUESTS_CA_BUNDLE` は image でシステムの束を指す。
  - sandbox のルートのファイルシステムは書けるままにする（`readOnlyRootFilesystem` にしない）。
  - `/etc/penelope/ca/` に証明書が無ければ、束は Debian のままである。

未決:

- CA の鍵を Pod ごとに作るか、Secret に置くか（Sentinel の作業単位で決める）。どちらでも、公開の証明書を上の場所に mount する。
