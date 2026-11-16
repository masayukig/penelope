# 0033. Slack への投稿は読み取りの CLI に足し、鍵はサロゲートのまま Sentinel を通す

- Date: 2026-11-16
- Status: Accepted

## Context

なつみとミャオは、Slack に日常的に投稿している。日本語の複数行の文、スレッドへの返事、表情ごとのアイコン、画像である。2 人は penelope に移る（ADR-0026）。penelope の sandbox には Slack へ投稿する道具が無く、配置のコネクタの文書（ADR-0020）が curl での書き方を渡しているだけである。

curl で投稿すると、次のことが毎回エージェントの手に残る。

- 複数行の日本語を、Slack の Web API の引数として壊さずに渡すこと。
- アイコンにする画像の URL を組み立てること。アイコンの画像は、backend がログインなしで配る、アバターの表情ごとの画像である（ADR-0016、[UI 向けの API の仕様書](../ui-api.md) の「エージェント」）。Slack は投稿のたびに外からその URL を取りにくるので、オーナーが backend に届く公開の URL でなければならない。
- 画像を、Slack の 3 段（アップロード先の URL をもらう、そこへ中身を送る、チャンネルとスレッドに共有する）で送ること。

前提になる事実は次のとおりである。

- sandbox の外向きはすべて Sentinel を通る。返事や投稿のための道具は、HTTP を呼ぶだけの薄いものにし、宛先ごとの判定は Sentinel のコネクタとして差し込む（ADR-0003）。
- 本物の鍵は Sentinel が持ち、sandbox にはサロゲートだけを置く。Sentinel は、登録したホストへの要求の `Authorization` のサロゲートを本物に差し替える（ADR-0004）。
- Slack の 3 段のうち、2 段目のアップロード先（`files.slack.com`）は、1 段目が返した URL そのものが送ってよいことの印であり、鍵を付けない。Sentinel は、サロゲートが鍵の登録の無いホストへ出ていく要求を断る。アップロード先に鍵の登録が無い配置では、サロゲートを付けると、アップロードが断られる。
- Slack の様子を読むための CLI が、Slack のプラグインの package にあり、sandbox の image に入っている（ADR-0029 の Decision 項 5（読み取り用の CLI は、深く読むときのもの））。CLI の名前は `slackctl` である。Slack 公式の開発者向けの CLI は `slack` という名前で、モデルが公式のサブコマンドで呼びうるので、それと重ならない名前にした。
- オーナーは、投稿の中身を判定することを、いまはしないと決めている。後で Sentinel の `slack.com` のコネクタに判定を足すことを見込む（ADR-0028 の「本 ADR で決定しないこと」の、投稿を判定するコネクタ）。

## Decision

適用範囲は、エージェントが sandbox から Slack にメッセージと画像を投稿することである。リアクションなど、投稿のほかの Web API は扱わない（curl で足りる）。

### 1. 投稿は読み取りの CLI に足す

- Slack のプラグインの package の CLI に、投稿のコマンドを足す。読むのと書くのを 1 つの道具にし、新しい道具を増やさない。
- 本文は標準入力から受け、そのまま送る。複数行の文を引数のエスケープなしで渡せるようにするためである。
- 送り先はチャンネル（ID か名前）と、任意のスレッドである。投稿の場所と ts を出力に出し、エージェントが続けてスレッドに返事を書けるようにする。
- 画像は Slack の 3 段で送り、本文と同じチャンネル・スレッドに共有する。
- CLI は HTTP を呼ぶだけで、投稿してよいかを判定しない（ADR-0003 の Decision 項「sandbox の外向きは 1 本の道」）。curl で投稿することも禁じない。

### 2. 鍵はサロゲートを送るだけにする

- CLI は、環境変数にあるサロゲートを `Authorization: Bearer` で Slack の Web API に送るだけである。本物の鍵は Sentinel が差し替える（ADR-0004）。
- 1 つの配置が複数のワークスペースに投稿するときは、ワークスペースごとに別のサロゲートを別の環境変数に置き、CLI はワークスペースの名前から環境変数を選ぶ。ワークスペースを名指さないときは、既定の 1 つを使う。
- アップロード先には鍵を付けない。

### 3. アイコンは backend の表情の画像を、公開の URL で渡す

- 表情を名指すと、CLI は backend のアバターの表情の画像の URL を投稿のアイコンに入れる。投稿の見た目の名前は変えない。
- URL の出どころは、オーナーが backend に届く公開の URL であり、配置が sandbox に渡す。CLI は、その URL で backend のログインの要らない口から表情の一覧を読み、無い表情なら投稿しない。
- 表情の画像の URL は、画像の拡張子で終わる形にする。Slack が拡張子の無い URL をアイコンとして受けるかが確かめられていないためである。
- Slack App には、アイコンを変えるための権限（`chat:write.customize`）が要る。

### 守る対象と、失敗したときの倒し方

- 守る対象は Slack の本物の bot の token である。sandbox は本物の token を持たず、サロゲートだけを送る（ADR-0004）。
- アイコンのために sandbox と Slack が読む backend の口は、もとからログインなしで読める、名前と表情の画像だけの口である。投稿のために新しく公開するものは無い。
- サロゲートの環境変数が無い、画像が読めない、名指した表情が無い、チャンネルが見つからないときは、何も投稿せずに失敗として終わる。半端な投稿にならないよう、確かめられることは投稿の前にすべて確かめる。
- 本文を投稿した後に画像で失敗したときは、投稿した分を出力に残して失敗として終わる。Slack に何が届いたかを、エージェントが分かるようにするためである。

### 本 ADR で決定しないこと

- コマンドの引数と出力の形、終了コード、環境変数の名前（委譲先: [receivers の仕様書](../receivers.md) の「Slack のプラグイン」の「投稿の CLI」）
- 表情の画像の口の形（委譲先: [UI 向けの API の仕様書](../ui-api.md) の「エージェント」）
- Slack App の設定と、サロゲート・本物の token の置き場（委譲先: 配置のリポジトリ。要る scope は receivers の仕様書の「Slack App の用意」）
- 投稿の判定（委譲先: ADR-0028 の「本 ADR で決定しないこと」に挙げた、投稿を判定するコネクタの ADR）
- システムプロンプトで投稿に触れるか（委譲先: プロンプトのファイル `packages/runner/src/prompts.ts`。ADR-0008 の方針に従う。使い方はコネクタの文書（ADR-0020）が持つ）

## Consequences

- エージェントは、複数行の日本語・スレッドへの返事・表情のアイコン・画像を、1 つのコマンドで投稿できる。なつみとミャオの Slack での振る舞いが、penelope でも続けられる。
- 読むのと書くのが同じ道具なので、エージェントは `slackctl` の使い方を 1 つ覚えればよい。読み取りで見た ts を、そのまま投稿のスレッドに使える。
- 鍵の扱いはほかの外向きと同じで、Sentinel の記録に投稿が残る。後で `slack.com` のコネクタに判定を足しても、CLI は変えずに済む。
- 一方で、Slack のプラグインの package が、読むだけでなく外へ書く道具を持つ。package の中に Slack の Web API を呼ぶコードが、receivers のプラグインのものとは別にもう 1 つできる。
- 表情のアイコンは、Slack が投稿のたびに公開の URL を取りにくる。backend が公開の URL で届かない配置では、表情の付いた投稿のアイコンが出ない。
- 複数のワークスペースでは、ワークスペースごとのサロゲートと Sentinel の登録が配置に要る。

## Alternatives Considered

- **curl のままにし、コネクタの文書に書き方を渡す**: 複数行の文の渡し方、アイコンの URL、3 段のアップロードを、毎回エージェントが組み立てることになる。
- **投稿の道具を別の CLI にする**: 読むのと書くので道具が分かれ、同じ Slack を指す名前（ワークスペース、チャンネル、ts）の扱いが 2 か所になる。
- **backend が投稿を中継する**: backend が Slack の鍵と Slack の形を知ることになり、返事や投稿は sandbox から出る HTTP の通信として Sentinel を通す、という ADR-0003 の決定に反する。

## Related ADRs

- Related: ADR-0003 sandbox の外向きはすべて Sentinel を通し、既定は素通しで記録する（投稿は sandbox から出る HTTP の通信、道具は薄くする）
- Related: ADR-0004 本物の鍵は Sentinel が持ち、鍵の出どころは差し替えられる口にする
- Related: ADR-0008 プロンプトは事実と環境だけを伝え、やり方は任せる
- Related: ADR-0016 最初の Web UI からアバターを表情ごとの絵で出し、アバターは 1 つの部品に閉じる（表情の画像）
- Related: ADR-0020 コネクタは Sentinel の登録と使い方の文書の組にし、文書の一覧をシステムプロンプトに出す
- Related: ADR-0026 なつみ・ミャオ・アキも 1 人 1 つの配置で penelope に移し、記憶は履歴ごと写して、戻し道は持たない
- Related: ADR-0028 Slack は receivers のプラグインが Socket Mode で受け、つなぎ直しのたびに最近の発言を取り直す（投稿の token は Sentinel が持つ、投稿を判定するコネクタ）
- Related: ADR-0029 Slack の出来事はターンに inline で載せ、前のターンからの変化をチャンネルとスレッドの形で描く（読み取り用の CLI）

## References

- Slack の文書「chat.postMessage」（https://docs.slack.dev/reference/methods/chat.postMessage 、2026-11-16 確認）: `chat:write` が要る、`icon_url` などで見た目を変えるには `chat:write.customize` が要る、`channel` は ID か名前（名前は公開のチャンネルだけ）
- Slack の文書「Working with files」（https://docs.slack.dev/messaging/working-with-files 、2026-11-16 確認）: `files.getUploadURLExternal`（`filename`・`length`）→ `upload_url` へ中身を POST（例に `Authorization` は無い）→ `files.completeUploadExternal`、`files:write`
- Slack の文書「files.completeUploadExternal」（https://docs.slack.dev/reference/methods/files.completeUploadExternal 、2026-11-16 確認）: `channel_id`・`thread_ts`・`icon_url`（`chat:write.customize` が要る）
- Slack の文書「users.conversations」（https://docs.slack.dev/reference/methods/users.conversations 、2026-11-16 確認）: bot の入っている会話の一覧、`cursor` と `response_metadata.next_cursor`
- [Sentinel の設定と記録の仕様書](../sentinel-config.md) の「登録の無いホストへのサロゲート」（2026-11-16 確認）: サロゲートが登録の無いホストへ出ていく要求は `403` で断る
- penelope `packages/backend/src/ui-api.ts` の `GET /api/agent` と `faceFile`（2026-11-16 確認）: ログインなしで、名前と表情の画像だけを返す
