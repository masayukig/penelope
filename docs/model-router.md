# モデルの振り分け（router/auto）

サブスクの枠が残っている間は主のモデルへ、尽きかけたら代わりのモデルへ、要求ごとに振り分ける。代わりは順に並べた複数でもよい（例: ChatGPT → Grok → Anthropic）。Pi の virtual model（`modelRuntime.registerVirtualModel`）として runner が登録する。`PENELOPE_MODEL_ROUTER` が無ければ何も登録せず、これまでと同じに動く。

## 設定

sandbox の環境変数 `PENELOPE_MODEL_ROUTER` に JSON で書き、`PENELOPE_MODEL=router/auto` で選ぶ。

```sh
PENELOPE_MODEL=router/auto
PENELOPE_MODEL_ROUTER={"models":["openai/gpt-6.1-sol","xai/grok-4.7","anthropic/claude-sonnet-5-5"],"prometheus":"http://prometheus.example:9090","query":"max(codex_rate_limit_used_percent)"}
```

`{"primary":"a/x","fallback":"b/y"}` は `{"models":["a/x","b/y"]}` と同じ（前の書き方）。

| キー | 意味 | 既定 |
| --- | --- | --- |
| `models` | `<provider>/<model>` を好む順に 2 つ以上。どれも `models.json` にあり、鍵があること。使用率を読むのは先頭だけ | （必須。`primary`・`fallback` でも可） |
| `prometheus` | Prometheus の URL。sandbox からは Sentinel を通って届くこと | （必須） |
| `query` | 先頭（主）の枠の使用率（%）を返す instant query。系列が複数なら最大を使う。結果が空なら「分からない」 | （必須） |
| `high`・`low` | 使用率が `high` 以上で代わりへ、代わりにいる間は `low` 未満になるまで戻らない | 85・70 |
| `cacheSeconds` | 1 回読んだ値を使う秒数。失敗で次へ移った後に留まる最短の秒数も兼ねる | 300 |

値が古いときに空を返すよう、query に鮮度の条件を入れておくとよい（例: `… and on() (time() - max(node_textfile_mtime_seconds{…}) < 1800)`）。

## 振り分け

- ユーザーの入力から始まる要求（と compaction などの `direct`）は、使用率で決める。`high` 以上なら 2 番目へ、`low` 未満なら先頭へ戻る。その間は今いるモデルに留まる。
- 2 番目以降には使用率が無い。次へ移るのは、そのモデルが「使えない」誤り（下）で答えたときだけ。3 番目以降へ移った後は、先頭の使用率が `low` 未満になるまで、2 番目へは戻らない。
- ツールの結果の後（`continuation`）と自動の再試行（`retry`）は、前に答えたモデルに留まる（prompt cache を保つため）。ただし、そのモデルが「使えない」誤りを返して次へ移った後（留まる時間の間）は、留まらず今のモデルへ。
- **Prometheus が読めない・値が空のときは、前の決定のまま。起動直後で一度も読めていないときは代わり（fallback）。** 枠が分からないまま主へ送ると、尽きていればターンが失敗するため、安全な側を選ぶ。
- 状態はプロセスのメモリだけに持つ。再起動すると代わりから始め、最初の読みで決め直す。

## 失敗したターン

並べたモデルのどれかが usage limit で答えると、Pi はそれを再試行しない（`subscription_sharing_usage_limit_exceeded` などは再試行しない誤りに入っている）。`prompt()` は throw せずに終わるので、runner は:

- モデルが誤りで終わったターンを、必ず stderr に記録する（router の有無によらない）。
- router が「そのモデルは今使えない」と判断したら（誤りの文に `usage limit`・`429`・`rate limit`・`too many requests`、または `401`・`403`・`unauthorized`・`forbidden`・`authentication`・中継の `no access token`）、次のモデルへ移って同じターンを続けさせる（`penelope.model_retry` の custom message）。続けた先も「使えない」なら、さらに次へ。最後のモデルが誤りなら、記録して終える。
