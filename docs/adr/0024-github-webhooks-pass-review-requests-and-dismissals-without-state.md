# 0024. GitHub の webhook は状態を持たずに受け、レビューの依頼と取り消しの 2 つだけを出来事にする

- Date: 2026-11-15
- Status: Accepted

## Context

エージェントは、自分の GitHub のアカウントで、依存の更新の PR（Renovate などの bot が作るもの）をレビューして承認している。PR は CODEOWNERS や Renovate の設定でエージェントにレビューを頼み、コードオーナーの承認と必須の check が揃うと GitHub がマージする。承認の後に push されると、リポジトリの ruleset（`dismiss_stale_reviews_on_push`）が承認を取り消す。

なつみベースの前の形（natsumi ADR 0093）は、GitHub App の webhook を `https://penelope.fraction.jp/v1/webhooks/github` で、GitHub 形の HMAC の署名で確かめて受けていた。新しい形の receivers（ADR-0023）はこのパスを受けるプラグインを持たないので、いまは届いた配送に `404` を返している。

前の形は状態を持っていた。`review_requested` で PR を覚え、覚えた PR の push（`pull_request` の `synchronize`）・CI の結果（`check_suite` の `completed`）・閉じたこと（`closed`）を通し、配送の ID で重複を落とした。CI の結果の `check_suite` には PR の作者もレビュアーも載っておらず、届いた 1 回だけでは頼まれた PR のものかを決められないためである。一方、receivers は要求 1 回から封筒を作るだけで、状態を持たない（ADR-0023 の Decision 項 4（取り込み口がすべて受けてから、送り手に成功を返す））。重複は backend が `(source, id)` で落とす。

新しい形のエージェントは sandbox の中で `gh` を持ち、Sentinel が GitHub の token を差し替える（ADR-0004）。PR の今の状態（CI の結果、push、閉じたか、自分のレビューの状態）は、エージェントがターンの中で自分で引ける。

GitHub の webhook について確かめた事実は次のとおりである（References）。

- GitHub App の webhook は、1 つの URL に、インストールしたすべてのリポジトリの、購読したすべてのイベントを送る。
- イベントの種類は `X-GitHub-Event`、配送の ID（GUID）は `X-GitHub-Delivery` のヘッダーで届き、action は本文の最上位の `action` にある。署名 `X-Hub-Signature-256` は、秘密を鍵にした本文の HMAC-SHA256 の 16 進に `sha256=` を付けたものである。`X-GitHub-Event` は署名の外にある。
- `pull_request` の `review_requested` は、人への依頼なら `requested_reviewer`、チームへの依頼なら `requested_team` を持つ。`pull_request_review` の action は `submitted`・`edited`・`dismissed` で、`dismissed` は取り消されたレビュー（`review`）と PR（`pull_request`）を持つ。App がどちらを受けるにも、Pull requests の read の権限が要る。webhook を作ると `ping` が届く。
- GitHub は、失敗した配送を自動では送り直さない。receivers が `503` を返した配送も送り直されない。送り直されるのは人が Redeliver したときだけで、そのときの `X-GitHub-Delivery` は元の配送と同じである。10 秒以内に 2xx を返さない配送は失敗になる。
- ruleset の `dismiss_stale_reviews_on_push` で承認が自動で取り消されたときに `pull_request_review` の `dismissed` が届くかは、GitHub Docs に書かれていない。

`stream` は `/sources/<source>/` の中の分け先で、英小文字・数字・`.`・`_`・`-` だけで、`.` で始まらないものに限られる（ADR-0013）。Slack のチャンネルを念頭に置いた封筒の欄の名前であり、GitHub ではリポジトリごとの置き場所になる。

## Decision

本 ADR は receivers の 2 つ目のプラグインとして、GitHub の webhook の受け方と、通す出来事を決める。プラグインの載せ方・送り手への答え方は ADR-0023 のまま変えない。

### 1. GitHub のプラグインは GitHub 形の HMAC で確かめ、状態を持たない

- プラグインの名前は `github`、種類は webhook である。前の形の URL（`/v1/webhooks/github`）と GitHub App と秘密を引き継げるように、有効化の名前は配置が決める（ADR-0023 の Decision 項 2（webhook のプラグインは 1 つの HTTP サーバーの下に並ぶ））。
- 要求の `X-Hub-Signature-256` を、秘密と本文から作った HMAC-SHA256 と、比べる時間が一致の度合いで変わらない形で照らす。秘密の値は設定のファイルにも環境変数にも書かず、有効化の設定が指すファイルから読む。
- 秘密のファイルが設定に無い、または読めない・空なら、receivers は起動しない。署名を確かめない受け口を開かない。
- プラグインは、届いた 1 回の要求だけから出来事を作る。覚えた PR、配送の ID、GitHub の API への問い合わせは持たない。

### 2. 通す出来事は、レビューの依頼と、レビューの取り消しの 2 つだけ

- **レビューの依頼**: `pull_request` の `review_requested` のうち、人への依頼で、その相手が設定の `reviewers` のどれかで、PR の作者が設定の `authors` のどれかであるもの。
- **レビューの取り消し**: `pull_request_review` の `dismissed` のうち、取り消されたレビューを出した人が `reviewers` のどれかで、PR の作者が `authors` のどれかであるもの。作者を絞るのは依頼と同じ範囲の PR に揃えるためで、`authors` の外の PR はもともと依頼が通らない。
- チームへの依頼（`requested_team`）は `reviewers` に照らさず、通さない。
- `authors` と `reviewers` は配置の設定で、どちらも必須で 1 つ以上である。GitHub のログインは大文字と小文字を区別しないので、照らすときも区別しない。絞らずにすべての PR を通す設定は作らない。
- ほかのイベント（`ping` を含む）と、読む 2 つのイベントのほかの action は、読まずに成功を返し、出来事を作らない。照らして当たらない依頼と取り消しも、出来事を作らずに成功を返す。

### 3. CI の結果・push・閉じたことは通さず、エージェントが GitHub で見る

- `check_suite`・`synchronize`・`closed` など、前の形が覚えた PR について通していた出来事は通さない。これらは頼まれた PR かどうかを 1 回の配送から決められず、通すには状態が要るためである。
- 出来事を受けたエージェントは、PR の今の状態（CI の結果、push、閉じたか）を自分で GitHub に尋ねる。CI がまだ終わっていなければ、自分で見直しを予約する。
- 承認の後の push で承認が取り消されたことは、レビューの取り消しとして届く。これが届くかは「実装で確かめること」に挙げる。

### 4. 封筒

- `delivery` は、依頼も取り消しも `batch` にする。依存の更新の PR は急がず、急ぐものはオーナーが A2A で頼む（ADR-0018）。
- `stream` はリポジトリごとに 1 つで、`<owner>.<name>` を `stream` に使える文字に写したものである。写し方は Alertmanager の `alertname` の写し方（ADR-0023 の Decision 項 5（Alertmanager のプラグイン））と同じものを使う。写した結果が同じになるリポジトリは同じ `stream` に入るが、元の名前は `payload` のリポジトリにそのまま残る。
- `id` は `X-GitHub-Delivery` である。人が Redeliver した配送は同じ `id` になり、backend が重複として落とす。読む 2 つのイベントで `X-GitHub-Delivery` が無い要求は、重複を落とせないので断る。
- `payload` は決まった欄だけにする。イベントと action、配送の ID、リポジトリ、PR の番号・題・URL・作者、head の SHA とブランチ、base のブランチ、依頼の相手か取り消されたレビューを出した人である。PR の本文、コメント、差分は入れない。レビューでは、差分と CI の結果を読みに必ず GitHub へ行くためで、外の人が書いた長い文を `/sources` に残さない。
- `summary` は、依頼なら `[review requested] <owner>/<name>#<番号>: <題>`、取り消しなら `[review dismissed] <owner>/<name>#<番号>: <題>` の形の 1 行で、200 文字までに切る。
- PR の題とブランチの名前は外の人が書いた文として扱う。読み方をプロンプトに書かない（ADR-0008）。

### 5. 断り方

- 署名が無い・違う要求は `401` で断る。署名は本文を読む前に確かめ、`401` は `400` より先に決める。
- `X-GitHub-Event` が無い要求、読む 2 つのイベントで形の合わない本文、読む 2 つのイベントで `X-GitHub-Delivery` が無い要求は、`400` で断る。送り直しても通らないためである。
- 照らして当たったものは、取り込み口が受けてから成功を返し、受けられなければ `5xx` を返す（ADR-0023 の Decision 項 4）。

### 6. 取りこぼしの保険は仕組みに置かない

- GitHub は失敗した配送を自動では送り直さないので、receivers が `5xx` を返した配送や、receivers が落ちていた間の配送は、人が Redeliver しない限り届かない。プラグインを入れる前から開いている PR の依頼も届かない。
- これを埋める仕組み（GitHub への問い合わせ、受けたものを溜める場所）は receivers にも backend にも足さない。保険は、エージェントが自分で予約する定期の見回り（開いている bot の PR のうち、自分に依頼が出ていて、自分の承認がまだ無いもの）に任せる。

### 守る対象と、失敗したときの倒し方

- 守る対象は、エージェントの出来事の入口である。署名の合わない要求から出来事を作らない。秘密が読めない設定では起動しないので、確かめの無い口が開いたままにはならない。
- 許す範囲は、署名の合う配送のうち、`authors` の作者の PR について、`reviewers` への依頼と `reviewers` のレビューの取り消しだけである。読み分けられないもの（知らないイベント・action、当たらない依頼）は、出来事を作らない側に倒す。
- 受信の鍵（webhook の秘密）は receivers のコンテナにだけ置く。backend と sandbox は持たない（ADR-0002）。
- 設定の誤り（`authors` か `reviewers` が無い・空、秘密が読めない）は、起動しない側に倒す。

### 本 ADR で決定しないこと

- 設定の欄の名前、`payload` の欄の名前、`stream`・`summary` の組み立ての細部、本文の形の確かめ方（委譲先: [receivers の仕様書](../receivers.md) の「GitHub のプラグイン」）
- エージェントの定期の見回りの中身と頻度（委譲先: エージェントの記憶。オーナーがエージェントに頼んで、エージェントが予約し記憶に書く）
- GitHub App の作成と購読するイベント、秘密の置き場所、`authors` と `reviewers` の値（委譲先: 配置のリポジトリ）
- ほかのイベント（issue、コメント、`pull_request_review` の `submitted` など）を読むこと（委譲先: 要るようになったときに、このプラグインを広げる ADR。[receivers の仕様書](../receivers.md) の「後に足すプラグイン」に挙げる）

### 実装で確かめること

- ruleset の `dismiss_stale_reviews_on_push` で承認が自動で取り消されたときに、`pull_request_review` の `dismissed` が届くか。GitHub Docs には書かれていないので、`dismiss_stale_reviews_on_push` を持つリポジトリで、承認した PR に push して、App の配送の記録を見る。届かなければ、push による取り消しは定期の見回りでしか拾えない。そのときもこの ADR の決定は変えず、仕様書に事実を書き足す。

## Consequences

- receivers は状態を持たないままで、再起動しても失うものが無い。前の形の SQLite の表（覚えた PR、配送の ID）は要らない。
- 送り手の GitHub App と URL と秘密を変えずに、受け持つ側を前の形から receivers に替えられる。購読には Pull request review を足す必要がある。
- エージェントに届くのは、頼まれたこととレビューが取り消されたことだけである。CI の結果・push・閉じたことは届かないので、エージェントはそのたびに GitHub へ尋ねに行く。CI が終わるのを待つときは、自分で見直しを予約する。前の形より出来事は少なく、ターンの中の GitHub への問い合わせは多い。
- 前の形が通していた `check_suite` の `completed` が届かないので、CI が終わったことを即座には知らない。見直しの予約の間隔だけ、承認が遅れうる。
- 承認の後の push による取り消しが `dismissed` として届かない場合、その PR は定期の見回りまで承認し直されない。
- GitHub は自動では送り直さないので、receivers や backend が止まっていた間の依頼は失われ、定期の見回りが拾うまで届かない。ADR-0023 の Consequences にある「送り手の送り直しに頼る」の面が、GitHub では送り直しが無い形で現れることを受け入れる。
- `payload` に本文を入れないので、外の人が書いた PR の本文やコメントが `/sources` に残らない。代わりに、エージェントは中身を読むたびに GitHub へ行く。
- リポジトリごとに `stream` が分かれるので、`/sources/<source>/` の下はリポジトリの数だけディレクトリが増える。
- `X-GitHub-Event` は署名の外にあるので、署名の合う本文を見た者は、イベントの種類を変えて送り直せる。本文の形がイベントごとに違うので、多くは `400` か出来事を作らない成功になる。秘密が漏れていなければ、新しい本文は作れない。

## Alternatives Considered

- **前の形のように、頼まれた PR を覚えて CI の結果・push・閉じたことも通す**: receivers に永続の場所と表が要り、ADR-0023 の「receivers は状態を持たない」を崩す。エージェントは `gh` で PR の今の状態を引けるので、覚えて通す分の価値が小さい。
- **`check_suite` を PR の作者を GitHub に尋ねて絞る**: プラグインに GitHub の token と API の道が要り、要求の中で外へ問い合わせることになる。10 秒の応答の制限にもかかる。
- **レビューの取り消しを、PR の作者で絞らない**: `authors` の外の PR は依頼が通らないので、取り消しだけが届いても、エージェントが見るべき PR かどうかを出来事からは決められない。
- **リポジトリで分けず、`stream` を省く**: リポジトリをまたいで 1 つのファイルに混ざり、同じリポジトリの依頼と取り消しを並べて読みにくくなる。
- **取りこぼしの保険を receivers に置く（起動のときに開いている PR を GitHub に尋ねる、など）**: プラグインに GitHub の token と状態が要る。取りこぼしは稀で、エージェントの定期の見回りで拾える。

## Related ADRs

- Related: ADR-0002 出来事は取り込み口 1 つの待ち行列に入れ、sandbox の runner が取りにいく（受信の鍵は receivers だけ、少なくとも 1 回の配送と重複の除き方）
- Related: ADR-0004 本物の鍵は Sentinel が持ち、鍵の出どころは差し替えられる口にする（エージェントの `gh` の token）
- Related: ADR-0008 プロンプトは事実と環境だけを伝え、やり方は任せる（題やブランチの名前の読み方をプロンプトに書かない）
- Related: ADR-0013 出来事の中身は backend が `/sources` に追記し、ターンには要約と場所だけを渡す（`stream` と `summary`）
- Related: ADR-0018 A2A の依頼は backend が Task として持って出来事にし、送り手は差し替えられる確かめ方で確かめる（急ぐレビューは A2A で頼む）
- Related: ADR-0023 receivers のプラグインはリポジトリの中に持って配置の設定で有効にし、最初に Alertmanager の webhook を受ける（プラグインの載せ方、送り手への答え方、`stream` の写し方）
- Related（natsumi、このリポジトリの外）: ADR 0093「webhook の型 `github` を足し、レビューを頼まれた PR の出来事だけを通す」（前の形。URL・App・秘密を引き継ぎ、状態を持つ形は引き継がない）

## References

- GitHub Docs「Webhook events and payloads」の Delivery headers（`X-GitHub-Event`・`X-GitHub-Delivery`・`X-Hub-Signature-256`）、`ping`、`pull_request`（`review_requested`、`requested_reviewer`・`requested_team`、Pull requests の read の権限）、`pull_request_review`（`submitted`・`edited`・`dismissed`、`review`・`pull_request`、Pull requests の read の権限）（https://docs.github.com/en/webhooks/webhook-events-and-payloads 、2026-11-15 確認）
- GitHub Docs「Validating webhook deliveries」（HMAC の 16 進に `sha256=` を付けること、時間の一定な比べ方。https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries 、2026-11-15 確認）
- GitHub Docs「Handling failed webhook deliveries」（失敗した配送を自動では送り直さない、10 秒より遅い応答は失敗。https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries 、2026-11-15 確認）
- GitHub Docs「Best practices for using webhooks」（10 秒以内に 2xx、Redeliver でも `X-GitHub-Delivery` は同じ、イベントと action を見てから処理すること。https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks 、2026-11-15 確認）
- GitHub REST API の rulesets の `pull_request` の規則の `dismiss_stale_reviews_on_push`（`yuanying/natsumi` の ruleset を `gh api repos/yuanying/natsumi/rulesets/<id>` で読んで欄があることを確認、2026-11-15）
- natsumi ADR 0093「webhook の型 `github` を足し、レビューを頼まれた PR の出来事だけを通す」（https://github.com/yuanying/natsumi/blob/main/docs/adr/0093-a-github-format-for-pull-requests-asked-to-review.md 、2026-11-15 確認）: 前の形の URL・GitHub App・覚えた PR と通していたイベント
- [receivers の仕様書](../receivers.md) の「GitHub のプラグイン」と「`stream` の写し方」
- [出来事の仕様書](../events.md) の「封筒」（`stream` に使える文字）
