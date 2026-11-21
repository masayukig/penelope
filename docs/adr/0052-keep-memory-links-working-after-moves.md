# 0052. 棚卸しで移動した記憶への参照は runner が直す

- Date: 2026-11-21
- Status: Accepted

## Context

日中のセッションは毎晩切り替わり、前の文脈ではなく更新された記憶から始まる。整理係は記憶のファイルを移動できるが、移動を記録して他の記憶からの参照を直す仕組みはない。記憶を目的に合わせて再構成するには、索引や毎回読む記憶が、前の場所に取り残されないことが必要である。

## Decision

- 棚卸しの構成のターンの後、runner は整理係の `move` の記録（元と先のパス）を使い、記憶全体の Markdown リンクと、毎回読む層および `INDEX.md` に書かれた古いパスを新しいパスに置き換える。指す先を保つための機械的な書き換えに限り、記述や目的の意味は変えない。日記のリンク先は直しても、日ごとの記録の内容は要約しない。
- 対応が分からない場合、行き先を推測して置き換えない。`move` を使わず統合して消えたパスへの参照は、切れたリンクとして次の夜の見取り図に出す。日中の移動はこの置き換えの対象にしない。
- 書き換えは runner が行い、backend が整理係とは別のコミットとして残す。仕組みが記憶を書き換える最初の例だが、`.git` は sandbox から引き続き読み取りのみとし、コミット前に記憶を検査して戻す方式にはしない。
- 新しい日中のセッションには移動の一覧を添えない。オーナーは構成の変化を活動の記録と git 履歴で確認する。

### 本 ADR で決定しないこと

- 移動の記録の形式、相対リンクや古いパスの判定方法、別コミットを依頼する口（委譲先: runner・backend の実装と sandbox 向けの口の仕様書）

## Consequences

- 構成を変えても、記憶を読みに来たセッションが新しい場所をたどれる。モデルに書き換えを任せず、オーナーは機械的な修正だけを別に確認し、必要なら戻せる。
- 対応が記録されない統合の後には、次の夜に直すまで切れた参照が残りうる。日中にエージェントが移動したときは、自分で参照を直す必要がある。

## Related ADRs

- Related: [ADR-0006 記憶は `/memory` の形を保ち、検査をやめ、コミットだけを sandbox の外で行う](0006-memory-kept-compatible-without-checks-committed-outside.md) の Decision「コミットは sandbox の外で backend がする」を維持し、runner による参照だけの更新を加える。
- Related: [ADR-0049 配置ごとの目的に沿って記憶を知識ベースに育てる](0049-grow-memory-around-an-instance-purpose.md)（`PURPOSE.md` も参照の更新対象だが、runner は目的の意味を変えない）。
- Related: [ADR-0050 夜は記憶の見取り図を渡し、棚卸しで中身と構成を分けて見直す](0050-organize-memory-with-a-map-and-a-weekly-review.md)（棚卸しの構成のターンと見取り図）。

## References

- [夜の道具](../../packages/runner/src/night-tools.ts) の `nightTools`・[runner の夜の切り替え](../../packages/runner/src/runner.ts) の `Runner.nightly`（2026-11-21 確認）: 整理係にはファイルを移動する道具があり、runner は参照の修正を行わず次のセッションに切り替える。
- natsumi [ADR 0068 整理係は人間の記憶のように、工程を分けて古い記憶を要約し、出来事を知識にする](https://github.com/yuanying/natsumi/blob/main/docs/adr/0068-a-curator-that-remembers-like-a-person.md) の「改名・移動のとき、古いパスはサーバーが置き換える」（2026-11-21 確認）: 参照の修正をモデルの編集と別のコミットにする先例。
