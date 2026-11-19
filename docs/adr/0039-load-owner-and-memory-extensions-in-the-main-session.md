# 0039. Pi 拡張はオーナーの置き場と記憶から本人のセッションだけに読み込む

- Date: 2026-11-19
- Status: Accepted

## Context

利用枠の消費量に応じたモデルの振り分けが提案されたが、監視基盤と利用枠の測り方は配置によって異なる。runner には本体の Pi 拡張（たとえば、終わったターンの折りたたみ）を読み込む仕組みがある一方、配置やエージェントが独自の拡張を使うには、本体や image を変える必要がある。

skill はエージェントが参照する文書だが、Pi 拡張は runner と同じプロセスで動くコードである。モデルに送る文脈を変えたり、ツールの呼び出しに介入したりできる。sandbox のシェルからすでに記憶や backend 向けのサロゲートにアクセスできるが、拡張はシェルの外側にある、そのセッションを動かす runner の処理にも直接介入できる。

## Decision

- 本体は配置ごとの機能を持たず、オーナーの Pi 拡張と記憶の拡張を読む口を設ける。オーナーの拡張は image に含めず、配置が指定し、sandbox に読み取り専用で mount した場所から読む。次に、エージェントが書き換えられる記憶の拡張の置き場を読む。HOME や作業ディレクトリの拡張は自動検出しない。
- 拡張を読み込むのは本人（main agent）のセッションだけである。セッションを開くときに読み、置き場が変わったら次のターンの前に読み直す。進行中のターンには反映しない。サブエージェントと夜の整理係のセッションには読み込まない。本体の拡張は今までどおり使う。
- 拡張を入れても、sandbox のファイルや外部サービスへの権限は増やさない。拡張は sandbox 内の runner と同じ権限で動き、外向き通信は同じく Sentinel を通る。Sentinel が差し替えに使う本物の鍵は拡張に渡さない。オーナーの置き場に入れるコードとその依存先は、配置のオーナーが管理する。
- 置き場がないときは、その場所からは読み込まない。代わりにほかの場所を探さない。

### 記憶の拡張でセッションが壊れたとき

1. Pi が読み込みエラーやハンドラの例外を報告したら、runner のログと次のターンの入力で知らせる。読み込めない拡張は入れずに続ける。ハンドラの例外は Pi が処理し、必要に応じてそのツール呼び出しなどを止める。
2. 記憶の拡張の内容を識別し、未確認の内容は、実行前にその印を記憶の外に永続化する。最初のターンが `done` でなければ、またはその印が残ったまま runner が再起動したら、その内容を読み込み対象から外す。外した理由はログと次のターンの入力で知らせる。内容が変われば、変更後の内容を試せる。オーナーの拡張は外さない。
3. ターンが `done` でも振る舞いがおかしい場合や、ターンが終わらず固まる場合は、自動では検出しない。拡張を置き場から外すか、記憶の履歴から戻せる。本人のセッションが動かないときはオーナーが runner の外から作業ツリーを戻し、必要なら runner を再起動する。

### 本 ADR で決定しないこと

- サブエージェントと夜の整理係への拡張の適用（委譲先: [ADR の一覧](README.md) に追加する、適用を見直す際の ADR）
- モデルの振り分けなど、拡張が実現する機能（委譲先: 各拡張の実装）

## Consequences

- オーナーもエージェント自身も、本体や image を変えずに拡張できる。記憶に置いた拡張の変更は、ほかの記憶と同じく、ターンの終わりに backend がコミットする。
- 最初のターンの結果による判定は、モデルの一時的な障害など、拡張と無関係の失敗でもその版を外す。一方、ターンが正常終了するように見える不具合は残る。オーナーは runner の外から記憶の拡張を戻せる。
- Pi の版を上げる際には、その版で使う拡張の互換性を確認する必要がある。

## Related ADRs

- Related: [ADR-0003 sandbox の外向きはすべて Sentinel を通し、既定は素通しで記録する](0003-all-egress-through-the-sentinel-passthrough-by-default.md)
- Related: [ADR-0004 本物の鍵は Sentinel が持ち、鍵の出どころは差し替えられる口にする](0004-the-sentinel-keeps-the-keys-through-a-replaceable-source.md)
- Related: [ADR-0006 記憶は `/memory` の形を保ち、検査をやめ、コミットだけを sandbox の外で行う](0006-memory-kept-compatible-without-checks-committed-outside.md)
- Related: [ADR-0015 終わったターンは、モデルに送る直前に機械的に畳み、セッションの記録は書き換えない](0015-fold-ended-turns-before-they-are-sent.md)
- Related: [ADR-0035 道具の使い方とどの配置にも同じ skill は sandbox の image に skill として入れ、オーナー・記憶の後に並べる](0035-tool-usage-and-shared-skills-as-image-skills.md)

## References

- [モデルを利用枠に応じて振り分ける提案](https://github.com/yuanying/penelope/pull/75)（2026-11-19 確認）: Prometheus で利用率を読む案
- Pi coding agent の `DefaultResourceLoader.reload`、`AgentSession.reload`、`docs/extensions.md` の「Error Handling」（`@earendil-works/pi-coding-agent` 1.5.2、2026-11-19 確認）: 明示したパスの読み直しと、読み込みエラー・ハンドラの例外が報告されること
- [runner の `openSession`](../../packages/runner/src/pi.ts) と [runner の `foldExtension` の利用](../../packages/runner/src/runner.ts)（2026-11-19 確認）: 拡張を読み込む時期と折りたたみの差し込み
- [backend の `Memory.commit`](../../packages/backend/src/memory.ts)（2026-11-19 確認）: ターンの終わりのコミット
- [Pod の形の仕様「volume」・「網」](../pod.md) と [なつみからの移行「8. 予約を入れる」](../migrate-from-natsumi.md)（2026-11-19 確認）: 本物の鍵の mount、通信の向け直し、sandbox のシェルから backend のサロゲートが利用できること
