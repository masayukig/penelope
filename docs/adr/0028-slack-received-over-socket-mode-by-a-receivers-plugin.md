# 0028. Slack は receivers のプラグインが Socket Mode で受け、つなぎ直しのたびに最近の発言を取り直す

- Date: 2026-11-16
- Status: Accepted

## Context

なつみとミャオは、Slack の 2 つのワークスペースで発言を受けて話している。ペネロペも Slack を受けることになった。penelope の receivers には Slack のプラグインが無く、エージェントは Slack への投稿（sandbox から Sentinel を通る外向き。ADR-0003）だけができる。

receivers のプラグインは、いまは webhook の種類だけである（ADR-0023）。receivers が持つ 1 つの HTTP サーバーの下で、送り手から届いた要求 1 回から出来事を作り、取り込み口がすべて受けてから送り手に成功を返す。receivers は状態を持たず、送り直しは送り手に任せる。

Slack の受け方について確かめた事実は次のとおりである（References）。

- Socket Mode では、アプリが app-level token で `apps.connections.open` を呼んで WebSocket の URL を得て、アプリの側から接続を張る。公開の URL は要らない。同時に 10 本まで接続を張れ、出来事はどの接続に届くか決まっていない。
- 出来事は `envelope_id` を持つ封筒で届き、アプリは `envelope_id` を返して受けたことを伝える。受けたことを伝えるかどうかで、Slack が送り直すかが決まる。
- 接続は数時間ごとに Slack の側から張り直しを求められる（`refresh_requested`）。切る前に `warning` が届くこともある。
- Events API（HTTP で受ける形）では、3 秒以内に 2xx を返さないと失敗とし、すぐ・1 分後・5 分後の 3 回まで送り直す。接続の無い間の出来事を溜めておくとは書かれていない。
- 出来事の外側は、全体で一意の `event_id` と時刻を持つ。発言はチャンネルと `ts` で一意に決まる。

natsumi は Socket Mode で受け、起動のときとつなぎ直したときに、チャンネルごとに最後に記録した時刻から履歴を取り直していた（natsumi ADR 0039）。そのために、最後に記録した時刻という状態を持っていた。

出来事の `stream` は `/sources/<source>/` の中の分け先で、使える文字が限られる（ADR-0013、ADR-0023 の Decision 項 5（Alertmanager のプラグイン）の写し方）。

## Decision

本 ADR は、receivers に Slack のプラグインを足し、そのために外へ接続を張る種類のプラグインを足す。取り込み口・封筒・配送の約束（ADR-0002・ADR-0013）と、プラグインの載せ方（ADR-0023 の Decision 項 1（プラグインはリポジトリの中に持ち、配置の設定で有効にする）と項 3（`source` は有効化ごとに 1 つ））は変えない。

### 1. 外へ接続を張る種類のプラグイン

- receivers のプラグインに、webhook のほかに、自分から外のサービスへ接続を張って出来事を受ける種類を足す。Slack のプラグインはこの種類である。
- この種類のプラグインは、HTTP サーバーの下に道を持たない。
- 取り込み口がその出来事をすべて受けてから、外のサービスに受けたことを伝える（Slack では `envelope_id` を返す）。取り込み口が受けなければ、受けたことを伝えず、外のサービスの送り直しに任せる。ADR-0023 の Decision 項 4（取り込み口がすべて受けてから、送り手に成功を返す）を、この種類にも当てはめる。
- 接続が切れても、receivers は止まらない。プラグインが自分でつなぎ直し、失敗が続くときは待ちを延ばしながら続ける。設定と鍵の誤りだけが、起動しない理由になる（ADR-0023 の Decision 項 1）。

### 2. 1 つの有効化で複数のワークスペースを受ける

- 1 つの Slack の有効化は、1 つ以上のワークスペースを持つ。ワークスペースごとに、Slack App の app-level token と bot の token のファイルと、`stream` に使う短い名前を設定で与える。
- `source` は有効化ごとに 1 つで、既定は `slack` である。`stream` は「ワークスペースの名前」と「チャンネルの名前（DM なら相手）」からなり、使えない文字は写す。写し方は Alertmanager と GitHub と同じものを使う（ADR-0023 の Decision 項 5、ADR-0024 の Decision 項 4（封筒））。
- 設定に無いワークスペースから届いた出来事は、受けたことを伝えて捨てる。

### 3. 通す出来事

- 発言（チャンネルの発言、スレッドの返信、DM）、発言の編集と削除、リアクションの付け外し、発言に付いたファイルを出来事にする。エージェント自身の発言も通す。ターンに Slack の流れを描くとき（ADR-0029）に、自分が何を言ったかが要るためである。
- 1 つの Slack の出来事を、1 件の出来事にする。今の姿（編集の後の本文、付いているリアクション）は、読む側が組み立てる（ADR-0013 の Decision 項 1（中身は backend が `/sources` に追記する））。
- ファイルは receivers が bot の token で取り、出来事の添付として取り込み口へ送る（ADR-0013）。大きさと種類の上限は設定で決め、上限を超えたものは、あったことだけを `payload` に残す。
- `payload` の形は Slack のプラグインの package が決め、ターンに描く側と読む CLI が同じ型を使う（ADR-0029）。backend は形を知らない。
- `payload` と `summary` の中身は外から来た文として扱い、読み方をプロンプトに書かない（ADR-0008）。

### 4. `delivery`

- bot へのメンションと DM は `now`、ほかは `batch` を既定にする。エージェント自身の発言は `now` にしない。
- 既定を変えられる範囲（`now` にするチャンネルを足すなど）は設定で決める。

### 5. `id` は Slack の中身から作り、取り直しでも同じになる

- 発言の `id` は、ワークスペース・チャンネル・`ts` から作る。Slack の送り直しで届いても、次の節の取り直しで届いても同じ `id` になり、backend が重複として落とす（ADR-0002 の Decision 項 3（配送の約束））。
- 編集・削除・リアクションのように Slack の中身から一意に決まらない出来事は、Slack の `event_id` から作る。

### 6. つなぎ直しのたびに、最近の発言を取り直す

- 起動したときと、つなぎ直したときに、bot が入っているチャンネルと DM の最近の発言を、bot の token で Slack に尋ねて取り直し、ふつうの発言と同じ出来事として送る。どこまでさかのぼるかは、設定の決まった長さとする。
- receivers は、最後に受けた時刻などの状態を持たない（ADR-0023 の Consequences の「receivers は状態を持たない」を保つ）。決まった長さを毎回取り直し、すでに受けた発言は backend が重複として落とす。
- 取り直せるのは発言だけである。切れていた間の編集・削除・リアクションは、Slack の送り直しで届かなければ失われる。取り直した発言は、取り直したときの本文で届く。

### 守る対象と、失敗したときの倒し方

- 守る対象は、エージェントの出来事の入口と、Slack の鍵である。
- Slack の app-level token と bot の token は receivers のコンテナにだけ置く（ADR-0002）。エージェントが投稿に使う token は、これとは別に Sentinel が持つ（ADR-0004）。
- token のファイルが設定に無い・読めない・空のとき、ワークスペースの名前が重なるときは、receivers は起動しない。
- 出来事が届く道は、receivers が張った TLS の接続だけである。受ける口を外に開かないので、webhook のような送り手の確かめは無い。
- Slack の接続が張れないときは、ログに残してつなぎ直し続ける。ほかの有効化（Alertmanager・GitHub）の受け口は止めない。
- 取り込み口が受けない出来事は、Slack に受けたことを伝えない側に倒す。

### 本 ADR で決定しないこと

- 設定の欄の名前、`payload` の欄、`id` と `stream` の組み立ての細部、つなぎ直しの待ちの延ばし方、取り直す長さの既定、ファイルの上限の既定（委譲先: [receivers の仕様書](../receivers.md) の「Slack のプラグイン」。Slack のプラグインを作る作業単位で足す）
- 外へ接続を張る種類のプラグインと本体の境目（委譲先: [receivers の仕様書](../receivers.md) の「プラグインの内側の契約」）
- Slack への投稿を判定するコネクタ（委譲先: ADR-0003 の「本 ADR で決定しないこと」に挙げた、既定を ask に切り替えるときの ADR。差し込み口は、投稿の判定を後から足せる形に保つ）
- Slack の様子をターンにどう載せるか（委譲先: ADR-0029）
- Slack App の作成、購読する出来事と権限、token の値と置き場、ワークスペースの名前（委譲先: 配置のリポジトリ）

## Consequences

- 公開の URL を持たずに Slack を受けられる。webhook の署名の確かめも要らない。
- receivers は状態を持たないままで、再起動しても失うものが無い。切れていた間の発言は、決まった長さの中なら取り直しで届く。
- 一方で、取り直すたびに、決まった長さの発言をまとめて送り直す。重複は backend が落とすが、取り込み口とディスクの読み書きは増える。
- 切れていた間の編集・削除・リアクションは失われうる。決まった長さより長く切れていた間の発言も失われる。
- receivers のプラグインが、初めて外へ通信する。receivers の外向きは Sentinel を通らないので（ADR-0003）、Slack への接続と問い合わせは Sentinel の記録に残らない。
- bot の token が receivers と Sentinel の 2 か所に置かれる。Slack App の token を替えるときは、両方を替える。
- 1 つの有効化が複数のワークスペースを持つので、1 つの `source` の下で `stream` がワークスペースごとに分かれる。

## Alternatives Considered

- **Events API の HTTP で受ける**: 公開の URL が要り、receivers の HTTP の口を Slack に開くことになる。Socket Mode なら外から呼ばれる口が増えない。
- **natsumi と同じく、最後に受けた時刻を覚えて、そこから取り直す**: receivers に永続の場所が要る。決まった長さを毎回取り直せば、重複は backend が落とすので、状態を持たずに済む。
- **取り直しをしない**: Slack の送り直しは数分で終わるので、Pod の作り直しや版上げのたびに発言が失われる。
- **ワークスペースごとに有効化を分ける**: ADR-0023 で `source` は有効化ごとに一意なので、ワークスペースごとに `source` が分かれ、ターンに描くとき（ADR-0029）も、CLI も、`source` の名前を配置ごとに知ることになる。

## Related ADRs

- Related: ADR-0002 出来事は取り込み口 1 つの待ち行列に入れ、sandbox の runner が取りにいく（受信の鍵は receivers だけ、少なくとも 1 回の配送）
- Related: ADR-0003 sandbox の外向きはすべて Sentinel を通し、既定は素通しで記録する（Slack への投稿、receivers の外向き）
- Related: ADR-0004 本物の鍵は Sentinel が持ち、鍵の出どころは差し替えられる口にする
- Related: ADR-0008 プロンプトは事実と環境だけを伝え、やり方は任せる
- Related: ADR-0013 出来事の中身は backend が `/sources` に追記し、ターンには要約と場所だけを渡す（追記するだけ、添付、読むための CLI）
- Related: ADR-0023 receivers のプラグインはリポジトリの中に持って配置の設定で有効にし、最初に Alertmanager の webhook を受ける（プラグインの種類を足す。「本 ADR で決定しないこと」の Slack のプラグイン）
- Related: ADR-0024 GitHub の webhook は状態を持たずに受け、レビューの依頼と取り消しの 2 つだけを出来事にする（`stream` の写し方）
- Related: ADR-0029 Slack の出来事はターンに inline で載せ、前のターンからの変化をチャンネルとスレッドの形で描く
- Related（natsumi、このリポジトリの外）: ADR 0039「Slack は読むファイルとして受け取り、ポッポさんは問題点ごとの点数で判定する」

## References

- Slack の文書「Using Socket Mode」（https://docs.slack.dev/apis/events-api/using-socket-mode 、2026-11-16 確認）: app-level token と `apps.connections.open`、同時に 10 本まで、`envelope_id` を返して受けたことを伝え、それで送り直すかが決まる、`warning`・`refresh_requested`、数時間ごとの張り直し、出来事がどの接続に届くかは決まっていない
- Slack の文書「The Events API」（https://docs.slack.dev/apis/events-api/ 、2026-11-16 確認）: 3 秒以内に 2xx、送り直しはすぐ・1 分後・5 分後の 3 回、外側の `event_id` と `event_time`
- natsumi ADR 0039（https://github.com/yuanying/natsumi/blob/main/docs/adr/0039-slack-as-files-and-a-scored-dove.md 、2026-11-16 確認）: 起動とつなぎ直しのときに、チャンネルごとに最後に記録した時刻から履歴を取り直す
- penelope `packages/receivers/src/plugin.ts` の `Plugin`（2026-11-16 確認）: プラグインの種類は webhook だけ
