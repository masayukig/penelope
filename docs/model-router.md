# モデルの振り分け（router/auto）

サブスクの枠が残っている間は主のモデルへ、尽きかけたら代わりのモデルへ、要求ごとに振り分ける（ADR-0039）。Pi の virtual model（`modelRuntime.registerVirtualModel`）として runner が登録する。`PENELOPE_MODEL_ROUTER` が無ければ何も登録せず、これまでと同じに動く。

## 設定

sandbox の環境変数 `PENELOPE_MODEL_ROUTER` に JSON で書き、`PENELOPE_MODEL=router/auto` で選ぶ。

```sh
PENELOPE_MODEL=router/auto
PENELOPE_MODEL_ROUTER={"primary":"openai/gpt-5.5","fallback":"anthropic/claude-sonnet-4-5","prometheus":"http://prometheus.example:9090","query":"max(codex_rate_limit_used_percent)"}
```

| キー | 意味 | 既定 |
| --- | --- | --- |
| `primary`・`fallback` | `<provider>/<model>`。どちらも `models.json` にあり、鍵があること | （必須） |
| `prometheus` | Prometheus の URL。sandbox からは Sentinel を通って届くこと | （必須） |
| `query` | 主の枠の使用率（%）を返す instant query。系列が複数なら最大を使う。結果が空なら「分からない」 | （必須） |
| `high`・`low` | 使用率が `high` 以上で代わりへ、代わりにいる間は `low` 未満になるまで戻らない | 85・70 |
| `cacheSeconds` | 1 回読んだ値を使う秒数。usage limit の後に代わりへ留まる最短の秒数も兼ねる | 300 |

値が古いときに空を返すよう、query に鮮度の条件を入れておくとよい（例: `… and on() (time() - max(node_textfile_mtime_seconds{…}) < 1800)`）。

## 振り分け

- ユーザーの入力から始まる要求（と compaction などの `direct`）は、使用率で決める。
- ツールの結果の後（`continuation`）と自動の再試行（`retry`）は、前に答えたモデルに留まる（prompt cache を保つため）。ただし主が usage limit を返した後は、主に留まらず代わりへ。
- **Prometheus が読めない・値が空のときは、前の決定のまま。起動直後で一度も読めていないときは代わり（fallback）。** 枠が分からないまま主へ送ると、尽きていればターンが失敗するため、安全な側を選ぶ。
- 状態はプロセスのメモリだけに持つ。再起動すると代わりから始め、最初の読みで決め直す。

## 失敗したターン

主が usage limit で答えると、Pi はそれを再試行しない（`@earendil-works/pi-ai` の `utils/retry.js` で、`subscription_sharing_usage_limit_exceeded` などは再試行しない誤りに入っている）。`prompt()` は throw せずに終わるので、runner は:

- モデルが誤りで終わった要求を、どのモデルの何の誤りかと一緒に stderr に記録する（router の有無によらない）。
- router が「主の枠が尽きた」と判断したら、代わりへ移って、同じターンを 1 回だけ続けさせる（`penelope.model_retry` の custom message）。これはターンの途中で、そのとき Pi の待ち行列に残っている steer・follow-up より先に行う。続けている間に来た event も、同じターンで（代わりのモデルへ）送る。runner が止まるところなら続けない。
- 続けた答えが誤りでなければ、ターンの結果は `done`。続けた答えも誤りなら記録して、結果は `failed`（ADR-0038）。
- サブエージェントのターンも同じに 1 回だけ続ける。

「枠が尽きた」と判断する誤りの文は、pi-ai が再試行しない枠・残高の誤り（`NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN`）にそろえる: `usage limit`（`subscription_sharing_usage_limit_exceeded`・`subscription_sharing_workplace_individual_usage_limit_exceeded`・`Monthly usage limit reached`・`GoUsageLimitError` を含む）・`available balance`・`insufficient_quota`・`out of budget`・`quota exceeded`・`billing`・Z.ai の `"code": 1308`。`429`・`too many requests`・`rate limit` だけの誤りは一時的な絞りで、Pi が同じモデルで再試行する（`retry` の要求は答えたモデルに留まる）ので、移らない。

## 設定の誤り

次のときは runner が起動しない: `PENELOPE_MODEL_ROUTER` が JSON のオブジェクトでない・欄が足りない・形が違う、`PENELOPE_MODEL=router/auto` なのに `PENELOPE_MODEL_ROUTER` が無い、`PENELOPE_MODEL_ROUTER` があるのに `PENELOPE_MODEL` が `router/auto` でない。
