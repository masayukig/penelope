# 0039. モデルは配置の設定で選んだまま、`router/auto` を選んだ配置では runner が要求ごとに主の枠の使用率で振り分ける

- Date: 2026-11-18
- Status: Accepted

## Context

配置のモデルは、Pi のモデルの設定（`PENELOPE_MODEL`）で 1 つ選ぶ（ADR-0026 の Decision「モデルは配置ごとに設定で選ぶ」）。同じ ADR は、モデルを手で切り替える仕組み（natsumi ADR 0046）を作らず、変えるときは配置の設定を変えると決めている。

サブスクリプションの枠で使うモデルを主にしている配置では、枠が尽きると、そのモデルへの要求が usage limit の誤りで返る。確かめた事実は次のとおりである（References）。

- Pi は usage limit の誤り（`subscription_sharing_usage_limit_exceeded` など）を再試行しない。`prompt()` は throw せずに終わり、セッションの最後の答えが `stopReason: "error"` になる。
- そのターンは、活動の記録に `failed` として残る（ADR-0038）。ただし枠が戻るまで、次のターンも同じ誤りで終わる。配置の設定を書き換えて Pod を作り直すまで、エージェントは話せない。
- Pi は virtual model（`ModelRuntime.registerVirtualModel`）を持つ。登録したモデルは要求のたびに `route()` が呼ばれ、要求の理由（新しい要求・ツールの結果の続き・再試行・失敗した答え）を受けて、実際に送るモデルを返せる。
- 枠の使用率は、配置によっては Prometheus に指標として出ている（どの指標かは配置ごとに違う）。

## Decision

本 ADR は、runner に、主の枠の使用率で要求ごとにモデルを振り分ける virtual model `router/auto` を足す。ADR-0026 の「モデルは配置ごとに設定で選ぶ」と「手で切り替える仕組みは作らない」は変えない。`router/auto` を使うかどうか、主と代わりにどのモデルを置くかは、配置の設定で決める。

### 1. 配置が選んだときだけ登録する

- sandbox の環境変数 `PENELOPE_MODEL_ROUTER`（JSON）があるときだけ、runner は virtual model `router/auto` を登録する。配置は `PENELOPE_MODEL=router/auto` で選ぶ。
- 無ければ何も登録せず、今までと同じに動く。
- 主と代わりのモデルは、どちらも Pi のモデルの設定にあり、鍵（サロゲート）があるものである。鍵の扱いは変えない（ADR-0004）。

### 2. 新しい要求は使用率で決め、続きは答えたモデルに留める

- ユーザーの入力から始まる要求（と compaction など）は、Prometheus の instant query で読んだ主の使用率（%）で決める。`high` 以上で代わりへ、代わりにいる間は `low` 未満になるまで戻らない。読んだ値は `cacheSeconds` のあいだ使う。
- ツールの結果の続きと自動の再試行は、前に答えたモデルに留める（prompt cache を保つため）。
- Prometheus が読めない・値が空のときは、前の決定のまま。起動してから一度も読めていないときは代わりを使う。枠が分からないまま主へ送ると、尽きていればターンが失敗するためである。
- 状態は runner のメモリだけに持つ。

### 3. 主が usage limit で答えたら、代わりで同じターンを 1 回だけ続ける

- 主の答えが usage limit の誤り（誤りの文で判断する）なら、代わりへ移り、少なくとも `cacheSeconds` のあいだ留まる。そのターンには custom message `penelope.model_retry` を入れ、代わりのモデルで 1 回だけ続けさせる。続けるのは、そのターンの待ち行列（steer・follow-up）を送るより前で、続けている間に来たものも同じターンで送る。続けた答えが誤りでなければターンは `done`、2 回目も誤りなら、ログに残してターンを終える（ADR-0038 の `failed`）。runner が止まるところなら続けない。サブエージェントのターンも同じにする。
- usage limit と判断するのは、pi-ai が再試行しない枠・残高の誤り（References）に限る。`429`・`too many requests`・`rate limit` は一時的な絞りとして Pi が同じモデルで再試行するので、移らない。主のそれ以外の誤りでも移らない。
- モデルの誤りで終わったターンは、`router/auto` の有無によらず、どのモデルの何の誤りかを runner のログに 1 行残す。

### 守る対象と、失敗したときの倒し方

- 守る対象は、エージェントが話し続けられることである。
- 使用率が分からないときは、尽きているかもしれない主ではなく、代わりに倒す。
- Prometheus への問い合わせは sandbox の外向きで、Sentinel を通る（ADR-0003）。Prometheus のホストは配置が Sentinel で開く。
- 設定が誤っているとき（JSON のオブジェクトでない、モデルの名前の形が違う、`low <= high` でない、`PENELOPE_MODEL=router/auto` と `PENELOPE_MODEL_ROUTER` の片方しか無いなど）は、runner は起動しない。

### 本 ADR で決定しないこと

- 設定の欄の名前と既定、usage limit と判断する誤りの文の細部（委譲先: [モデルの振り分け](../model-router.md)）
- 3 つ以上のモデルを順に試すこと（委譲先: 必要になったときの ADR）
- どの Prometheus のどの指標を読むか、主と代わりにどのモデルを置くか（委譲先: 配置のリポジトリ）

## Consequences

- 主の枠が尽きかけても、配置の設定を書き換えずにエージェントが話し続けられる。
- 振り分けは自動で、エージェントにもオーナーにも手で切り替える口は無い。ADR-0026 の「手で切り替える仕組みは作らない」はそのまま保たれる。
- 1 つのセッションの中で、要求ごとに違うモデルが答えうる。セッションの記録には、各答えのモデルが残る。
- 枠の使用率の指標を Prometheus に出している配置でしか使えない。指標が古くなっても値を返すなら、古い値で振り分ける。鮮度の条件は query に書く。
- 再起動の直後は、最初に読めるまで代わりを使う。

## Alternatives Considered

- **usage limit の誤りが返ってから代わりへ移るだけにする**: 枠が尽きるたびに 1 回の失敗が要る。使用率を先に読めば、尽きる前に移れる。誤りでの移動は、読めなかったときの受け皿として残した。
- **配置の設定を書き換えて Pod を作り直す（今のまま）**: 枠が戻るまでの間、オーナーが 2 回手を動かす。戻すのを忘れると、主のモデルを使わないままになる。
- **エージェントやオーナーが手で切り替える口を作る**: ADR-0026 で作らないと決めている。
- **Pi の外（モデルの API の手前の proxy）で振り分ける**: 続きと再試行を同じモデルに留めるには、要求の理由が要る。Pi の virtual model なら `route()` がそれを受け取る。

## Related ADRs

- Related: ADR-0003 sandbox の外向きはすべて Sentinel を通し、既定は素通しで記録する（Prometheus への問い合わせ）
- Related: ADR-0004 本物の鍵は Sentinel が持ち、鍵の出どころは差し替えられる口にする（主と代わりの鍵）
- Related: ADR-0026 なつみ・ミャオ・アキも 1 人 1 つの配置で penelope に移し、記憶は履歴ごと写して、戻し道は持たない（モデルは配置ごとに設定で選ぶ、手で切り替える仕組みは作らない）
- Related: ADR-0038 活動の記録は backend が 1 行の要約として持ち、ターンの結果と夜の段の結果を runner が知らせる（モデルの誤りで終わったターンは `failed`）

## References

- Pi（`@earendil-works/pi-coding-agent`）の `ModelRuntime.registerVirtualModel` と `ModelRouteRequest`（1.5.2 の `dist/core/model-runtime.js`、2026-11-18 確認）: 要求ごとの `route()`、理由（`reason`）、前に答えたモデル（`previous`）、失敗した答え（`failed`）
- `@earendil-works/pi-ai` 1.5.2 の `dist/utils/retry.js`（2026-11-18 確認）: `subscription_sharing_usage_limit_exceeded` などの枠・残高の誤り（`NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN`）は再試行せず、`429`・`too many requests`・`rate limit` は再試行する（`RETRYABLE_PROVIDER_ERROR_PATTERN`）
