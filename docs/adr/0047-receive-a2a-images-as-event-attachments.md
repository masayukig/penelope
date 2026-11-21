# 0047. A2A のメッセージでは画像の中身を受け、出来事の添付にする

- Date: 2026-11-21
- Status: Proposed

## Context

penelope の A2A の受け口は、メッセージに文章以外の部品があるとメッセージごと断る。他のエージェントにスクリーンショットや図を見てほしいときにも、文章で説明するしかない。A2A 1.0 のファイルの部品（FilePart）は、画像そのものを base64 で持つ `raw` と、取りに行く先を示す `url` のどちらかを持てる。受ける形式を画像の中身に絞れば、backend が送り手の指定した宛先に接続せずに、既存の出来事の添付として渡せる。

## Decision

適用範囲は、penelope が `SendMessage` で受ける新しい依頼と聞き返しへの答え、および送り手への入力形式の案内である。Task の持ち主・状態遷移と返事の形式は変えない。

### 1. 文章に加え、受け付ける種類の画像の中身だけを受ける

- ファイルの部品は A2A 1.0 の `raw` に画像の中身があるものに限る。種類はオーナーの画像と同じ PNG・JPEG・GIF・WebP とする。backend は復号した中身で種類を見分け、`mediaType` があれば中身と一致することを確かめる。ファイル名や宣言だけで画像とみなさない。
- `url` の部品、構造のあるデータ、許可した種類と確認できないファイル、復号できない部品は断る。backend は画像を取りに行かない。不適合な部品だけを捨てて残りを届けることもしない。
- 文章だけ、画像だけ、文章と画像を混ぜたメッセージを受ける。空白以外の文章も有効な画像もないメッセージは断る。聞き返しで画像の提示を求められるよう、`input-required` への答えにも同じ条件を適用する。

### 2. 受け口の本文上限を広げず、画像にも上限を置く

- 画像は復号後の大きさで 1 枚 1 MiB まで、1 メッセージに 4 枚まで。A2A の JSON-RPC 本文全体の上限は 2 MiB、文章の上限は UTF-8 で 1 MiB のままとする。
- 1 MiB の画像は base64 で約 1.33 MiB になる。各画像が上限内でも、base64 化した画像と文章・JSON を合わせて 2 MiB を超えれば断る。4 枚は小さな図をまとめて送るための上限であり、上限サイズの画像を 4 枚送れるという意味ではない。本文上限は読み込み中に適用し、上限に合わないメッセージは保存・配送しない。

### 3. backend が出来事の添付に写し、既存の道でターンに渡す

- backend は、受け付けた画像の中身を `/sources/a2a` の添付に写す。画像と送り手の文章は同じ `a2a` の出来事に結び付ける。画像だけの場合も、受信元と送り手が分かる出来事にし、画像があることを要約で示す。既存の Task の上限などで出来事にしないメッセージでは、画像も保存しない。添付を保存できなければ、メッセージを受け付けず、出来事も残さず、Task を新規作成したり、聞き返しへの答えとして `working` に戻したりしない。
- 使うのはオーナーのメッセージも通る出来事の添付の道である。ADR-0034 の Decision 項 1（画像は返事の画像と同じ置き場に写す）が定めた Web UI の会話履歴用の写しは作らない。A2A の Task の履歴にも画像の中身や sandbox 内のパスは載せず、送り手の文章と画像が添付されたことだけを残す。ポーリングのたびに送り手自身の画像を返さず、画像を二重に保存しないためである。
- inline の出来事では runner が添付を読み、既存の枚数と大きさの範囲で画像としてターンに載せる。inline にする受信元の設定は変えない。inline でない場合や上限で載らなかった場合は、添付をあとから開ける。モデル要求には接続先ごとの画像の上限もそのまま適用する。受け付けた画像がすべてのモデル要求に載ることは保証しない。

### 4. Agent Card で入力形式を知らせ、skill で送り方を示す

- Agent Card の `defaultInputModes` に `text/plain` と、受ける 4 種類の画像の media type を載せる。`defaultOutputModes` は `text/plain` のままとする。
- `a2a` skill は、宛先の Agent Card で対応する入力形式を確かめ、`a2a send` の `--file-part` に URL でなくローカルの画像ファイルのパスを渡す使い方を示す。文章と混ぜる送り方と、base64 を含む本文上限も示す。対応形式が Card に無い相手には、画像が届く前提で送らない。

### 5. 画像の中身は送り手から届いたデータとして扱う

- 守る対象は、添付の保存先と他の送り手の Task、オーナーの指示との区別である。本文を読む前に送り手を確かめ、allow-list にある送り手だけを受ける。認証や Task の持ち主の確認が通らなければ受けない。送り手が指定したファイル名で添付の保存先の外に書き込めないよう、既存の添付の命名規則を使う。画像から読める文字も送り手の文章と同じく外から届いたデータであり、オーナーの指示としては従わない。画像を受けても送り手の権限は増えない。

### 本 ADR で決定しないこと

- `reply_to_agent` による返事の画像と、Task の artifact での配布。ADR-0032 の Decision 項 2（backend は呼んだ時点で写し、写しを返事に結び付ける）はオーナー向けの返事に限られ、A2A の返事には広げない（委譲先: A2A の返事に画像を付けるときの ADR）。
- 断り方の詳細、Task 履歴の表示文言、添付のファイル名の扱い、CLI のコマンド例（委譲先: A2A の受け口と出来事の仕様、`a2a` skill）。

## Consequences

- エージェント間で、図を文章で説明し直さなくても、新しい依頼や聞き返しへの答えに画像を添えられる。文章だけの送り手は呼び方を変えなくてよい。
- 保存する添付とモデルに載る画像は増える。本文上限を維持する代わりに、大きな画像や複数の画像を一度に送りたい場合は、送り手が縮小するか枚数を減らす必要がある。
- Task を取得しても送信済み画像の中身は戻らない。A2A の返事として画像が必要な場合、同じ Task の成果として画像を返すことはできない。

## Related ADRs

- Supersedes（一部、採択時）: [ADR-0018 A2A の依頼は backend が Task として持って出来事にし、送り手は差し替えられる確かめ方で確かめる](0018-a2a-tasks-in-the-backend-and-replaceable-sender-checks.md) の Decision「受け口は backend の外向きの待ち受けに置き、A2A 1.0 で受ける」のうち「受けるのは文章だけ」を置き換える。送り手の確かめ方と Task の持ち主の扱いは変えない。
- Related: [ADR-0034 オーナーが送った画像も backend が写し、会話の履歴の行に結び付ける](0034-images-the-owner-sends-copied-by-the-backend.md)。オーナーの画像と同じ種類を受けるが、会話の履歴用の写しは作らない。
- Related: [ADR-0032 返事に sandbox の画像を添え、backend が写して Web UI で見せる](0032-images-attached-to-a-reply-copied-by-the-backend.md)。オーナーへの返事と A2A の Task への返事は別のままにする。
- Related: [ADR-0046 モデル要求では接続先の上限に合わせて古い画像を省き、失敗を次のターンに伝える](0046-budget-images-before-model-requests.md)。A2A で受けた画像も接続先ごとの画像上限の対象にする。

## References

- [A2A の受け口の仕様](../a2a.md)「Agent Card」「送り手の確かめ」「依頼の扱い」「Task の見せ方」と、[受け口の実装](../../packages/backend/src/a2a/endpoint.ts) の `MAX_A2A_BODY_BYTES`、`Requests.sendMessage`、`buildCard`（2026-11-21 確認）: JSON-RPC 本文は 2 MiB、文章は 1 MiB。文章以外の部品を断る。
- [出来事の仕様](../events.md)「A2A の出来事」「`inline`」「`/sources`」「ひとつの出来事」と、[添付の実装](../../packages/backend/src/sources.ts)の `imageTypeOf`、[オーナーの画像の実装](../../packages/backend/src/assets.ts)の `splitOwnerFiles`（2026-11-21 確認）: backend が添付を保存し、runner は inline の画像を 1 入力 4 枚まで載せる。オーナーの画像は PNG・JPEG・GIF・WebP を中身で見分ける。
- A2A 1.0 仕様の [Part](https://a2a-protocol.org/v1.0.0/specification/#416-part)、[FilePart の移行例](https://a2a-protocol.org/v1.0.0/specification/#a21-breaking-change-kind-discriminator-removed)、[AgentCard](https://a2a-protocol.org/v1.0.0/specification/#441-agentcard)（2026-11-21 確認）: JSON のファイルの部品は `raw`（base64）か `url` を持ち、`mediaType` と `filename` は任意。Agent Card は media type で入出力形式を示す。
- [sandbox image の Dockerfile](../../Dockerfile) の `A2A_VERSION` と、a2a-cli v0.4.0 の [`buildFilePart`](https://github.com/a2aproject/a2a-cli/blob/v0.4.0/internal/flagparse/parts.go)・[`send` のメッセージ組み立て](https://github.com/a2aproject/a2a-cli/blob/v0.4.0/internal/cli/send.go)、[`a2a` skill](../../packages/runner/image/skills/a2a/SKILL.md)（2026-11-21 確認）: `--file-part ./diagram.png` は中身を入れ、URL は参照にする。`--media-type` は直前の部品に掛かり、文章は位置引数や `--text-part` で同送できる。
