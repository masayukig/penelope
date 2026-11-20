# 0043. モデルと思考の深さはオーナーが設定画面で選ぶ

- Date: 2026-11-19
- Status: Accepted（一部を [ADR-0044 夜は記憶を原本と照合してから整理し、週に一度は棚卸しする](0044-check-memory-against-records-before-nightly-organization.md) で置き換え）

## Context

ペネロペのモデルは sandbox の環境変数と Pi のモデル定義で決まる。主に使う ChatGPT のサブスクリプションの枠が尽きたとき、オーナーが別の provider で会話を続けるには、配置を書き換えて Pod を立て直す必要がある。候補には Chat Completions を使う provider もある。これらは既存の仕組みで Sentinel が接続先ごとに鍵を差し替えれば直接使える。

Pi はセッションの履歴を残したままモデルを替えられる。思考の深さはモデルごとに使える値が異なる。通常のモデルではコンテキストがしきい値を超えると Pi は自動で圧縮を試す。切り替え直後も、前のモデルの応答をもとに新しいモデルの上限で判定できる。ただし圧縮の要約も切り替え先のモデルに履歴を送って作るため、長すぎる履歴が必ず収まるわけではない。Pi が認識した上限超過には、圧縮が成功すれば 1 回の再試行がある。

## Decision

照合係と整理係で使うモデルには [ADR-0044 夜は記憶を原本と照合してから整理し、週に一度は棚卸しする](0044-check-memory-against-records-before-nightly-organization.md) の例外がある。振り返りと日中のモデル選択は本 ADR のままとする。

- モデルと思考の深さの組は backend が SQLite に配置ごとに 1 組保存する。オーナーとしてログインした人だけが読み書きでき、A2A や sandbox の認証では書けない。設定が無いときは環境変数の既定を残し、未指定なら Pi の振る舞いに従う。
- モデルは Pi と同じ `<provider>/<model>` で識別する。最初の `/` だけが区切りである。候補の正は、Pi が認証を確認できるモデルを runner が報告した一覧とする。候補の名前・コンテキストの大きさ・対応する思考の深さを画面に出す。一覧が無いか期限切れの場合も含め、一覧にないモデルや非対応の深さは保存しない。
- runner はターンの前に設定を読み、セッションを切らずに適用する。本体・サブエージェント・夜の振り返りと整理係がすべて従う。途中のターンのモデルは変えない。保存したモデルが利用できなくなったときはログに残して既定に戻し、思考の深さだけが非対応になった場合は Pi に丸めを任せる。
- 小さいモデルへの切り替えで、既存の履歴が新しいコンテキストに収まらない見込みなら、切り替え前に元のモデルで圧縮を試す。元のモデルの枠切れが切り替えの理由になりうるので、圧縮に失敗しても切り替え自体は行う。以降は Pi の通常の圧縮と上限超過時の処理に任せる。
- 使用率やエラーを理由に自動で別のモデルへは替えない。

### 本 ADR で決定しないこと

- API と画面の詳細（委譲先: UI 向けの API の仕様「設定」、sandbox 向けの口の仕様「モデルの設定」）
- 配置で有効にするモデルと鍵の入れ方（委譲先: Kubernetes 配置の手引き「モデルの設定」および既存の Sentinel の仕組み）

## Consequences

- Pod を立て直さずにモデルを替えて会話や作業を続けられる。一方、大幅に小さいモデルへの切り替えは圧縮のために元のモデルへの追加の要求を伴いうる。切り替え先に履歴が収まらなければターンが失敗することはある。
- 一覧の報告が途絶えたら新しい設定を保存できない。選択した値はモデルが候補から外れても SQLite に残る。
- 設定を保存する SQLite の migration は一方通行である。古い backend に戻すには更新前の SQLite のバックアップが必要になる。

## Alternatives Considered

- **主の枠が尽きそうなら自動で下りる**: サブスクリプション用の接続で使っている Responses API から利用枠の使用率を取得できない。エラーを起点に自動で切り替える案も、オーナーが手で替えられれば足りるため採らない。
- **llm-proxy に複数の上流を持たせる**: Responses と Chat Completions の変換が要る。llm-proxy はサブスクリプションの認証を受け持つままにして、ほかの provider は runner から直接使う。

## Related ADRs

- Related: ADR-0002 出来事は取り込み口 1 つの待ち行列に入れ、sandbox の runner が取りにいく
- Related: ADR-0004 本物の鍵は Sentinel が持ち、鍵の出どころは差し替えられる口にする
- Related: ADR-0007 セッションは 1 本にし、夜に振り返り・整理係・新しいセッションの 3 段で切り替える（従来の夜の段）
- Superseded by（一部）: [ADR-0044 夜は記憶を原本と照合してから整理し、週に一度は棚卸しする](0044-check-memory-against-records-before-nightly-organization.md)（Decision 項 3（各ターンでの設定の適用）のうち、照合係と整理係にだけ別のモデルを手で選べるようにする。自動では替えない）
- Related: ADR-0010 人は GitHub OAuth で、A2A の送り手は ServiceAccount の token で確かめる
- Related: ADR-0017 ターンの入力は 1 行 1 件の JSON を `<events>` で囲み、1 件の型を契約にする
- Related: ADR-0022 サブエージェントは runner が非同期に回し、本体とだけツールと自分宛ての出来事でやりとりする

## References

- `@earendil-works/pi-coding-agent` 1.5.2 の `dist/core/agent-session.js` の `setModel`・`setThinkingLevel`・`_prepareRun`・`_modelForMessage`・`_checkCompaction`・`_runAutoCompaction`、`dist/core/compaction/compaction.js` の `generateSummaryWithUsage`（2026-11-19 確認）: セッション内の切り替え、丸め、自動圧縮の判定と再試行。
- `@earendil-works/pi-coding-agent` 1.5.2 の `dist/core/model-runtime.js` の `getAvailable` と `@earendil-works/pi-ai` 1.5.2 の `dist/models.js` の `getSupportedThinkingLevels`（2026-11-19 確認）: 利用できるモデルと対応する思考の深さ。
- サブスクリプション用の認証で送った Responses API の応答ヘッダと SSE の実測（2026-11-19 確認）、[OpenAI Codex の報告](https://github.com/openai/codex/issues/54219): 利用枠の使用率が得られない条件。
- [UI 向けの API の仕様「設定」](../ui-api.md#設定)、[sandbox 向けの口の仕様「モデルの設定」](../sandbox-api.md#モデルの設定)、[Kubernetes 配置の手引き「モデルの設定」](../../deploy/kubernetes/README.md#モデルの設定)
