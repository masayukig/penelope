# モデルの振り分け（router/auto）

サブスクの枠が残っている間は主のモデルへ、尽きかけたら代わりのモデルへ、要求ごとに振り分ける。Pi の virtual model（`modelRuntime.registerVirtualModel`）として runner が登録する。`PENELOPE_MODEL_ROUTER` が無ければ何も登録せず、これまでと同じに動く。

## 設定

sandbox の環境変数 `PENELOPE_MODEL_ROUTER` に JSON で書き、`PENELOPE_MODEL=router/auto` で選ぶ。

```sh
PENELOPE_MODEL=router/auto
PENELOPE_MODEL_ROUTER={"primary":"openai/gpt-6.1-sol","fallback":"anthropic/claude-sonnet-5-5","prometheus":"http://prometheus.example:9090","query":"max(codex_rate_limit_used_percent)"}
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

主が usage limit で答えると、Pi はそれを再試行しない（`subscription_sharing_usage_limit_exceeded` などは再試行しない誤りに入っている）。`prompt()` は throw せずに終わるので、runner は:

- モデルが誤りで終わったターンを、必ず stderr に記録する（router の有無によらない）。
- router が「主の usage limit」と判断したら（誤りの文に `usage limit`・`429`・`rate limit`・`too many requests`）、代わりへ移って、同じターンを 1 回だけ続けさせる（`penelope.model_retry` の custom message）。2 回目も誤りなら記録して終える。
