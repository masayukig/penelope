# 0018. A2A の依頼は backend が Task として持って出来事にし、送り手は差し替えられる確かめ方で確かめる

- Date: 2026-11-14
- Status: Accepted

## Context

ADR-0010 は、A2A の送り手を ServiceAccount の token で確かめ、backend が Kubernetes の TokenReview に尋ねると決めた。ADR-0002 と ADR-0013 は、A2A を backend の中の受信元 `a2a` とし、受けた中身を `/sources` に追記してターンには要約と場所だけを渡すと決めた。受け口の形、依頼の状態、エージェントが送り手に返す道は、まだ決めていなかった。

今のペネロペ（natsumi のインスタンス）には A2A の受け口があり、オーナーの Claude と Pi、ほかのなつみが頼みごとをしている。その形は次のとおりである。

- Agent Card を token なしで返し、A2A の依頼を送る呼び出しと、依頼の今の姿（Task）を読む呼び出しを受ける。送り手は Task を読みに来て返事を取る。
- エージェントは返事のツールで Task を閉じるか、送り手に聞き返す。
- 返事が無いまま残る依頼を、期限で失敗にする。送り手ごとに、開いている依頼の数に上限を置く。

送り手は、A2A 1.0 の公式の CLI（a2a-cli）と、natsumi の A2A の SDK で呼ぶ。どちらも、クラスタの入口の前段の認証（gated）の audience の ServiceAccount の token を `Authorization: Bearer` に付ける。

新しいペネロペの Ingress も gated の後ろに置く。gated は、振り分けたすべての要求に先に認証を掛け、`Authorization` の token が gated の audience で TokenReview に通ると、そのヘッダを落としてから転送する。代わりに、確かめた主体（`system:serviceaccount:<名前空間>:<名前>`）を、gated が署名した短い主張（`Gated-Assertion`、以下 assertion）で渡す。assertion は宛先のホスト名を `aud` に持ち、期限は 60 秒である。gated の audience でない token は、落とさずにそのまま転送する。

このため、ADR-0010 のとおり backend が TokenReview だけで確かめると、今の送り手の token は backend に届かず、送り手を変えずにはつなげない。オーナーは、確かめ方を差し替えられる形で 2 つ持ち、最初は gated の assertion で受けると決めた。

ここで使う言葉は次のとおりである。

- **Task**: 送り手の 1 つの依頼。送り手のメッセージとエージェントの返事を順に持ち、状態が移る。
- **開いている Task**: 状態が `working`（エージェントの返事を待つ）か `input-required`（エージェントの聞き返しへの、送り手の答えを待つ）の Task。
- **確かめ方**: 呼び出しのヘッダから、それがどの ServiceAccount の呼び出しかを言う部品。
- **allow-list**: 送り手として受ける ServiceAccount の一覧。確かめ方には依らず 1 つである。

## Decision

本 ADR は、ADR-0010 の Decision 項 2（A2A は ServiceAccount の token を TokenReview で確かめる）の具体を決め、そのうち次の 2 点を置き換える。ほかの点（送り手は allow-list で決めること、受ける audience を設定で選べること、失敗したときに受けない側へ倒すこと）は変えない。

- TokenReview だけで確かめる点。確かめ方を差し替えられる口にし、TokenReview はその 1 つにする。
- 「penelope の Ingress は、gated の後ろではないふつうの Ingress にする」点。gated の後ろに置いてよい。

適用範囲は、ほかのエージェントがペネロペに頼む向きの A2A である。ペネロペがほかのエージェントに頼む向き（sandbox から Sentinel を通る、ADR-0010 の Decision 項 3（出ていく向きも gated を知らない））は変えない。

### 受け口は backend の外向きの待ち受けに置き、A2A 1.0 で受ける

- JSON-RPC の受け口と Agent Card は、UI 向けの API と同じ待ち受けに置く。Agent Card は token なしで読める。
- 送り手が使う A2A の版と transport（A2A 1.0 の JSON-RPC）で受ける。受けるのは、依頼を送る呼び出しと Task を読む呼び出しだけである。ストリーミング・push 通知・Task の取り消しは受けない。送り手は Task を読みに来て返事を取る。
- 受けるのは文章だけである。ファイルや構造のあるデータを含むメッセージは断る。sandbox に置く前に判断が要るものを、判断せずに置かないためである。

### Task は backend が持ち、送り手のメッセージを 1 つずつ出来事にする

- Task とそのメッセージは backend の SQLite に持つ。backend が再起動しても、開いている Task は残る。
- Task の状態は `working`・`input-required`・`completed`・`failed`・`rejected` の 5 つである。`completed` にするのはエージェントの返事だけ、`failed` と `rejected` にするのは backend だけである。
- 送り手のメッセージのうち、新しい依頼と、聞き返しへの答えを、1 つずつ受信元 `a2a` の出来事にする。`stream` は送り手の名前である。中身はほかの出来事と同じく `/sources` に追記する（ADR-0013 の Decision 項 1（中身は backend が `/sources` に追記する））。`/sources` に書けなければ、Task も残さず、送り手に失敗を返す。
- 開いている Task に、聞き返しの間でないのに送り手が続けて送ったメッセージは断る。足したいことは新しい依頼にする。閉じた Task へのメッセージも断る。
- 送り手から見えるのは、自分の Task だけである。

### 上限と期限で、Task が開いたまま積もらないようにする

- 送り手ごとに、開いている Task の数に上限を置く。上限を超える新しい依頼は、すぐ `rejected` にして返す。出来事にはせず、エージェントを起こさない。
- 開いている Task は、送り手の最後のメッセージから期限を過ぎると `failed` にする。聞き返しの間も数える。送り手が答えないまま上限を埋め続けないためである。
- 催促はしない。`/sources` は追記するだけで（ADR-0013）、natsumi のように状態のファイルを書き換えて知らせる形を持ち込まない。

### エージェントは出来事の `seq` を名指して Task に返す

- sandbox 向けの口に、A2A の Task に返す口を足す。エージェントは、答える `a2a` の出来事の `seq` を名指し、`completed`（閉じる。文は任意）か `input-required`（聞き返す。文は必須）を選ぶ。runner には、この口を呼ぶだけのツールを足す。
- Task の ID ではなく出来事の `seq` で名指す。`seq` はターンの入力に必ずあり（ADR-0017）、オーナーへの返事の `in_reply_to` と同じ名指し方になる。`a2a` を inline の受信元にしても名指せる。
- エージェントの返事は Task に残り、送り手が読みに来る。オーナーとの会話の履歴には入れない。
- 閉じた Task への返事、`a2a` の出来事でない `seq` への返事は断り、エージェントに断ったことを返す。返していない返事を返したことにしない。
- 送り手の言葉をオーナーの言葉と取り違えないための指図は、プロンプトに書かない（ADR-0008）。出来事の `source` と `stream` が、オーナー以外の誰からかを示す。外へ作用する行為は、ほかの出来事のときと同じく Sentinel を通る（ADR-0003・ADR-0005）。

### 送り手の確かめ方は差し替えられる口にし、2 つ持つ

- 確かめ方は「呼び出しのヘッダから、どの ServiceAccount かを言う」口とする。allow-list に照らすのは口の外の 1 か所である。どの確かめ方で通っても、送り手の名前は ServiceAccount から決まる。
- 確かめ方は 2 つ持ち、設定で 1 つか両方を選ぶ。
  - **TokenReview**: `Authorization: Bearer` の token を、backend の ServiceAccount で API server の TokenReview に尋ねる。尋ねる audience は設定で決め、必ず 1 つ以上置く。API server 自身の audience では、その ServiceAccount で動くどの Pod にも mount されている token が通ってしまうためである。
  - **gated の assertion**: `Gated-Assertion` を、gated の署名（鍵は設定の場所から取り、assertion からは取らない）、発行元、`aud` が backend の公開のホスト名であること、期限で確かめ、`sub` の ServiceAccount を言う。
- 両方を選んだときは、assertion を持つ呼び出しを assertion で決める。gated は token を落として assertion に置き換えるので、assertion がある呼び出しの `Authorization` は gated に宛てたものではない。assertion の無い呼び出しを TokenReview で決める。両方を同時に開けるのは、送り手を一方からもう一方へ移す間に、どちらの道の呼び出しも受けるためである。
- 最初の配置では gated の assertion を使う。これは暫定とし、送り手が backend に宛てた audience の token で、gated に落とされずに backend へ届く道で呼べるようになったら、TokenReview に替えて gated の assertion を外す。そこで penelope は gated に依存しなくなる（ADR-0010 の Consequences の「gated に依存しない」）。

### 守る対象と、失敗したときの倒し方

- 守る対象は、A2A の受け口（Task を開くこと、Task を読むこと）と、それが書く `/sources/a2a` である。
- 許す範囲は、allow-list にある ServiceAccount と、その送り手自身の Task である。
- allow-list が空なら、受け口を閉じる。Agent Card も含めて、ほかの知らない道と同じに扱う。
- allow-list があるのに確かめ方が選ばれていない、または選んだ確かめ方に要る設定が欠けているときは、backend は起動しない。
- 確かめが通らないとき（形が違う、署名が合わない、期限切れ、別の audience・別のホスト、allow-list に無い）は受けない。どこで外れたかは送り手に返さない。
- 確かめの答えが得られないとき（API server や gated の鍵に届かない）も受けない。送り手には、送り直せば通り得ることだけを返す。

### 本 ADR で決定しないこと

- 受け口の道・JSON-RPC の断り方・状態コード、Task の見せ方、出来事の中身の欄、返事の口の形（委譲先: [A2A の受け口の仕様書](../a2a.md)、[sandbox 向けの口の仕様書](../sandbox-api.md)）
- 設定の名前と既定（上限の数、期限の長さ、確かめ方の選び方）（委譲先: [backend の仕様書](../backend.md) の「設定」）
- allow-list に載せる送り手、受ける audience、gated の発行元と鍵の場所の値（委譲先: 配置のリポジトリの設定）
- Task と `/sources/a2a` をいつまで残すか（委譲先: [backend の仕様書](../backend.md) の「状態」）
- 届いた依頼を Web UI に出すか（委譲先: [UI 向けの API の仕様書](../ui-api.md)。画面の一覧と流れをオーナーと合意した後に直す）
- push 通知で送り手に知らせるか、Task の取り消しを受けるか（委譲先: それを作るときの ADR）

## Consequences

- 今の送り手は、token の取り方も呼ぶ URL も変えずに、新しいペネロペに頼める。
- 届いた依頼はほかの出来事と同じ道でターンに入り、中身は `/sources/a2a/<送り手>/` に残る。backend とプロンプトに、A2A のための別の仕組みは増えない。
- 返事を `seq` で名指すので、エージェントは Task の ID を写さずに済む。一方で、送り手の依頼の文は inline でなければターンに無く、エージェントは `/sources` のファイルを読んで知る。
- 一方で、最初の配置は gated に依存する。gated の鍵が取れない間、gated の形が変わったとき、gated と backend の公開のホスト名が食い違ったときは、どの送り手も受けられない。gated の鍵を取りに行く外向きの通信が backend に増える。
- TokenReview を使う間は、呼び出しのたびに API server に尋ねる。API server が止まると受け口も止まる（ADR-0010 の Consequences のまま）。
- 催促をしないので、エージェントが返事を忘れた Task は、期限まで開いたまま残り、送り手には失敗として見える。
- 送り手の言葉は、オーナーの言葉と同じ文脈に入る。取り違えないことはモデルの判断に頼り、システムが止めるのは Sentinel を通る外への作用だけである。
- 送り手を足すには、allow-list の設定を変えて backend を作り直す。

## Alternatives Considered

- **ADR-0010 のとおり TokenReview だけで受ける**: gated の後ろでは今の送り手の token が backend に届かない。送り手の token の audience と呼ぶ道を先に変えるまで、つながらない。
- **gated の assertion だけで受ける**: 送り手を TokenReview に移す道が無くなり、gated への依存を外せない。
- **natsumi と同じく、Task ごとのディレクトリを作り、状態のファイルを書き換えて催促する**: `/sources` を書き換えることになり、ADR-0013 の「追記するだけ」と、受信元ごとに形を持たない方針に反する。
- **返事のツールで Task の ID か送り手の名前を名指す**: Task の ID は、`a2a` を inline にするとターンの入力から見えない。送り手の名前は、開いている Task が 2 つあると決まらない。

## Related ADRs

- Superseded（一部）: ADR-0010 人は GitHub OAuth で、A2A の送り手は ServiceAccount の token で確かめる（Decision 項 2（A2A は ServiceAccount の token を TokenReview で確かめる）の、TokenReview だけで確かめる点と、Ingress を gated の後ろに置かない点）
- Related: ADR-0002 出来事は取り込み口 1 つの待ち行列に入れ、sandbox の runner が取りにいく（A2A は backend の中の受信元）
- Related: ADR-0003 sandbox の外向きはすべて Sentinel を通し、既定は素通しで記録する
- Related: ADR-0005 承認待ちは Sentinel が持ち、オーナーは Web UI で答える
- Related: ADR-0008 プロンプトは事実と環境だけを伝え、やり方は任せる
- Related: ADR-0013 出来事の中身は backend が `/sources` に追記し、ターンには要約と場所だけを渡す
- Related: ADR-0017 ターンの入力は 1 行 1 件の JSON を `<events>` で囲み、1 件の型を契約にする
- Related（natsumi、このリポジトリの外）: ADR 0089「なつみも A2A の受け口を持ち、届いた依頼は /sources に置いて、返事のツールで閉じる」

## References

- natsumi ADR 0089（https://github.com/yuanying/natsumi/blob/main/docs/adr/0089-hearing-from-agents-over-a2a.md 、2026-11-14 確認）: Agent Card・依頼を送る呼び出し・Task を読む呼び出しの 3 つ、Task を SQLite に持つ、返事のツールで閉じるか聞き返す、催促の間隔 3 時間・期限 24 時間・送り手ごとの開いた Task の上限 3、送り手の確かめ方は gated の assertion か送り手ごとの Bearer の token
- natsumi の A2A の受け口の実装 `src/server/a2a-server.ts`（https://github.com/yuanying/natsumi/blob/main/src/server/a2a-server.ts 、2026-11-14 確認）: `@a2a-js/sdk` の JSON-RPC で A2A 1.0 を受ける
- gated ADR 0022「トークンをどう受け取り、どう照合するか」（https://github.com/yuanying/gated/blob/v0.5.1/docs/adr/0022-presenting-and-checking-a-token.md 、v0.5.1、2026-11-14 確認）: gated の audience で TokenReview が通った ServiceAccount の token は `Authorization` ごと落として転送し、別の audience・期限切れ・偽物はそのまま転送する
- gated ADR 0034「バックエンドに主体を署名付きで伝える」（https://github.com/yuanying/gated/blob/v0.5.1/docs/adr/0034-conveying-the-subject-to-the-backend.md 、v0.5.1、2026-11-14 確認）: 主体の決まった要求に EdDSA で署名した assertion を付ける。`sub` は `system:serviceaccount:<namespace>:<name>` など、`aud` は要求のホスト名（小文字、ポートなし）、期限は 60 秒
- gated ADR 0039「ServiceAccount を主体にし、その token を TokenReview で確かめる」（https://github.com/yuanying/gated/blob/v0.5.1/docs/adr/0039-serviceaccount-subject-and-tokenreview.md 、v0.5.1、2026-11-14 確認）: audience を API server 自身の audience にしてはならない（どの Pod も何もせずに通れるため）。`status.audiences` を確かめ直す
- fraction-agents ADR 0005「Claude・Codex・Pi からは公式の a2a-cli と共通のスキルで呼ぶ」（https://github.com/yuanying/fraction-agents/blob/main/docs/adr/0005-call-agents-with-a2a-cli-and-shared-skill.md 、2026-11-14 確認）: a2a-cli は A2A 1.0 に対応し、token は ServiceAccount の token
- fraction-agents ADR 0030「呼び出し元は gated 経由でも呼べるようにし、A2A の口でも gated のアサーションを確かめる」（https://github.com/yuanying/fraction-agents/blob/main/docs/adr/0030-callers-through-gated-assertions.md 、2026-11-14 確認）と `src/gated-assertion.ts`: assertion の確かめ方（`alg`・`typ`・鍵・署名・`iss`・`aud`・期限・`sub`）
- Kubernetes の TokenReview（https://kubernetes.io/docs/reference/kubernetes-api/authentication-resources/token-review-v1/ 、2026-11-14 確認）: `spec.audiences` を置いたときは `status.audiences` に合う audience があることを確かめる
