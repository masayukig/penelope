# 端から端までの確かめ（e2e）

[docs/pod.md](../docs/pod.md) の Pod の 4 つのコンテナ（Sentinel・backend・sandbox・receivers）を Docker Compose で 1 つの網の名前空間に並べ、
Pod の外を偽物にして、オーナーのログインから夜の切り替えまでを通す。

```sh
make e2e
```

`make images` で image を作り、`node --test` で `test/e2e.test.ts` を動かす。Docker（Compose v2）と Node が要る。`make test` からは呼ばない。

- `PENELOPE_E2E_KEEP=1` を付けると、終わった後もコンテナを残し、全部のログを出す。失敗したときはいつもログを出す。
- 鍵と証明書は走らせるたびに `e2e/.run/` に作り直す（git には入れない）。

## 並べ方

| サービス | 役目 |
| --- | --- |
| `pod` | 網の名前空間の持ち主。Pod の pause コンテナに当たる |
| `init` | `NET_ADMIN` を持つ init container。sandbox の UID（1000）の TCP と名前解決を、IPv4 と IPv6 とも Sentinel へ向け直す。loopback はそのまま（`init/redirect.sh`） |
| `volumes` | volume の持ち主を決め、sandbox の HOME に Pi の設定（`config/models.json`）を置く。Pod の `fsGroup` と配置の役目に当たる |
| `sentinel`・`backend`・`sandbox`・`receivers` | リポジトリの image そのまま。`network_mode: service:pod` で名前空間を共有する |
| `outside` | Pod の外の偽物（下の「偽物」） |

- volume と mount は pod.md の表のとおり。`/memory/.git` は別の volume で、sandbox には読み取りで重ねる。取り込み口と管理口の socket は sandbox に mount しない。
- sandbox に置くのはサロゲートと Sentinel の CA の公開の証明書だけである。本物の鍵（モデルの鍵、backend の token、OAuth の client secret）は Sentinel・backend・偽物にだけ mount する。
- receivers のプラグインはまだ無い。receivers のコンテナは `sleep` で立てておき、テストがそこで小さな送り手（`sender/send.ts`）を動かして取り込み口の socket を叩く。

## 偽物

`outside` のコンテナ 1 つが、Pod の外を受け持つ（`outside/`）。

- 名前解決: テストの名前（`model.example.com`・`backend.example.com`・`plain.example.net`・`github.com`・`api.github.com`）を自分のアドレスで答え、ほかは無いと答える。Pod のすべてのコンテナの `resolv.conf` はこれを指す（クラスタの DNS に当たる）。テストはマシンの外に出ない。
- モデル: Pi の `openai-completions` が話す chat completions の偽物。テストの印（`E2E-TURN-1` など）を見て、決まった返事と道具の呼び出し（`write`・`bash`・`reply`）を返す。受けた入力をすべて覚え、`Authorization` が本物の鍵だったか（Sentinel が差し替えたか）を記録する。
- GitHub の OAuth と API: token の交換（client secret と PKCE を確かめる）と `/user`。
- 素通しの宛先: `plain.example.net`（HTTPS と平文の HTTP）。
- 制御の口: テストが偽物の受けたものを読む。outside のコンテナの loopback だけで待ち受ける。

テストは backend の UI 向けの API と偽物の制御の口を、`outside` のコンテナの中から呼ぶ（`outside/client.ts`）。オーナーのブラウザが Pod の外にいるのと同じ形で、テストを動かすマシンにポートを公開しない。

## Pod とのずれ

- **GitHub の宛先**: backend の GitHub の宛先は設定で変えられない（`github.com` と `api.github.com` に決めてある）。テストのために設定を足さず、偽物の名前解決がこの 2 つの名前を偽物に向け、backend にだけ偽物の CA を `NODE_EXTRA_CA_CERTS` で信頼させる。backend の UID の外向きは向け直されないので、本番と同じ宛先のまま偽物に届く。sandbox も同じ名前解決を見るのが Pod とのずれである（このテストでは sandbox は GitHub を使わない）。
- **網**: `pod` と `outside` は Docker の既定の bridge に置き、アドレスは Docker が付ける。テストは `outside` を立ててから `resolv.conf` を書き、`pod` を立ててから backend の公開の URL を決め、残りを立てる。ユーザー定義の網は使わない（コンテナどうしが届かないマシンがあった）。IPv6 の向け直しの規則は入れるが、網は IPv4 だけである。
- **volume の持ち主**: Pod は `fsGroup` で共有の volume を 1 つのグループに置く。ここでは `volumes` のコンテナが持ち主を UID ごとに決める。
- **ServiceAccount の token と kubeconfig**: クラスタが無いので、どのコンテナにも無い。
- **夜の切り替え**: テストは最後に backend を作り直し、`PENELOPE_NIGHTLY_CRON` を毎分（`* * * * *`）にして次の切り替えを待つ。起動にかかった時間や今の時刻に左右されない。取り込み口は `control` の出来事を断るので、外から夜を起こす道は無い。

## 通すシナリオ

`test/e2e.test.ts` が、1 つの Pod で順に通す。

1. GitHub の OAuth でログインする。backend が Web UI の build（ページ、script、styles）を配り、エージェントの名前（`/api/agent` と manifest）が設定から来る。メッセージを送る。sandbox の runner がターンを回し、返事が履歴と流れ（SSE）に届く。途中経過（`turn_start`・`tool_call`・`tool_result`・`message`・`turn_end`）と状態（`thinking`・`waiting`）が流れに乗る。モデルにはサロゲートではなく本物の鍵が届く。
2. ターンの終わりに `/memory` がコミットされる（`Turn <turn_id>` と `Agent: main`）。sandbox は `/memory/.git` に書けず、履歴は読める。
3. 2 つめのターンのモデルへの入力で、1 つめのターンが畳まれている（出来事・地の文・`reply` は残り、ほかの呼び出しは 1 行、道具の出力は無い）。
4. sandbox の外向きが Sentinel を通り、記録に残る。素通し（`plain.example.net`）、開く宛先（モデルと backend）、名前解決、登録の無いホストへのサロゲート・リンクローカル・受け口へ直に届いた通信を断る。sandbox の loopback は向け直されず、記録にも残らない。
5. sandbox に本物の鍵が無い。取り込み口の socket が見えない。backend の UI 向けの口に loopback で届いても、ログインを求められる。
6. receivers から取り込み口へ出来事を入れ、`/sources` に追記される。重複は受けたことになり、`control` は断られる。`batch` は待ち、後から来た `now` が待っている `batch` を連れて 1 つのターンに届く。
7. 夜の制御の出来事で、振り返り → 整理係 → 新しいセッションが回り、`handoff.md` と整理係の変えたものがコミットされる。新しいセッションのシステムプロンプトに `handoff.md` が入り、前の日の会話は無い。次の切り替えの後も、ターンは回り続ける。
