# ADR

penelope の設計の判断の記録です。1 つの ADR に 1 つの判断を書きます。

| 番号 | タイトル | Status |
| --- | --- | --- |
| 0001 | [1 つの Pod に backend・Sentinel・sandbox・receivers を置き、Pi ごと sandbox の中で動かす](0001-one-pod-with-pi-inside-the-sandbox.md) | Accepted |
| 0002 | [出来事は取り込み口 1 つの待ち行列に入れ、sandbox の runner が取りにいく](0002-one-intake-and-a-runner-that-pulls-events.md) | Accepted（一部を ADR-0014 で置き換え） |
| 0003 | [sandbox の外向きはすべて Sentinel を通し、既定は素通しで記録する](0003-all-egress-through-the-sentinel-passthrough-by-default.md) | Accepted（一部を ADR-0014 で置き換え） |
| 0004 | [本物の鍵は Sentinel が持ち、鍵の出どころは差し替えられる口にする](0004-the-sentinel-keeps-the-keys-through-a-replaceable-source.md) | Accepted（一部を ADR-0021 で置き換え） |
| 0005 | [承認待ちは Sentinel が持ち、オーナーは Web UI で答える](0005-approvals-held-by-the-sentinel-answered-in-the-web-ui.md) | Accepted |
| 0006 | [記憶は `/memory` の形を保ち、検査をやめ、コミットだけを sandbox の外で行う](0006-memory-kept-compatible-without-checks-committed-outside.md) | Accepted |
| 0007 | [セッションは 1 本にし、夜に振り返り・整理係・新しいセッションの 3 段で切り替える](0007-one-session-switched-nightly-with-a-one-turn-curator.md) | Accepted |
| 0008 | [プロンプトは事実と環境だけを伝え、やり方は任せる](0008-prompts-state-facts-and-leave-the-how.md) | Accepted |
| 0009 | [最初の UI は Web だけにし、新しい API と Astryx で作る](0009-web-ui-first-with-a-new-api-and-astryx.md) | Accepted（一部を ADR-0016 で置き換え） |
| 0010 | [人は GitHub OAuth で、A2A の送り手は ServiceAccount の token で確かめる](0010-github-oauth-for-people-tokenreview-for-a2a.md) | Accepted（一部を ADR-0018 で置き換え） |
| 0011 | [sandbox の image は開発の一式を持ち、汎用のユーザーの HOME で作業する](0011-a-full-dev-image-and-a-generic-user-home.md) | Accepted |
| 0012 | [なつみベースのペネロペからは、並べて立ち上げてから切り替え、戻せる形を保つ](0012-move-penelope-side-by-side-and-keep-a-way-back.md) | Accepted |
| 0013 | [出来事の中身は backend が `/sources` に追記し、ターンには要約と場所だけを渡す](0013-event-contents-in-sources-and-summaries-in-turns.md) | Accepted |
| 0014 | [sandbox の loopback は sandbox に任せ、Pod の中の口は Unix socket だけで待ち受ける](0014-sandbox-loopback-left-open-and-pod-ports-on-unix-sockets.md) | Accepted |
| 0015 | [終わったターンは、モデルに送る直前に機械的に畳み、セッションの記録は書き換えない](0015-fold-ended-turns-before-they-are-sent.md) | Accepted |
| 0016 | [最初の Web UI からアバターを表情ごとの絵で出し、アバターは 1 つの部品に閉じる](0016-show-the-avatar-and-expression-from-the-first-web-ui.md) | Accepted |
| 0017 | [ターンの入力は 1 行 1 件の JSON を `<events>` で囲み、1 件の型を契約にする](0017-turn-input-as-json-lines-in-events.md) | Accepted |
| 0018 | [A2A の依頼は backend が Task として持って出来事にし、送り手は差し替えられる確かめ方で確かめる](0018-a2a-tasks-in-the-backend-and-replaceable-sender-checks.md) | Accepted |
| 0019 | [ssh は別のコンテナの ssh-agent の socket で行い、鍵は sandbox に見せない](0019-ssh-through-an-agent-socket-keys-kept-out-of-the-sandbox.md) | Superseded by ADR-0021 |
| 0020 | [コネクタは Sentinel の登録と使い方の文書の組にし、文書の一覧をシステムプロンプトに出す](0020-connectors-with-a-usage-document-listed-in-the-prompt.md) | Accepted |
| 0021 | [自分で作った VM への ssh の鍵は、エージェントが自分で HOME に作る](0021-her-own-ssh-key-in-home-for-the-vms-she-makes.md) | Accepted |
| 0022 | [サブエージェントは runner が非同期に回し、本体とだけツールと自分宛ての出来事でやりとりする](0022-sub-agents-run-by-the-runner-and-talk-only-to-the-main-agent.md) | Accepted |
| 0023 | [receivers のプラグインはリポジトリの中に持って配置の設定で有効にし、最初に Alertmanager の webhook を受ける](0023-receivers-plugins-in-the-repository-and-alertmanager-first.md) | Accepted |
| 0024 | [GitHub の webhook は状態を持たずに受け、レビューの依頼と取り消しの 2 つだけを出来事にする](0024-github-webhooks-pass-review-requests-and-dismissals-without-state.md) | Accepted |
| 0025 | [Sentinel のホストの登録に、左端の 1 ラベルだけのワイルドカードを書ける](0025-wildcard-host-registrations-for-one-left-most-label.md) | Accepted |
