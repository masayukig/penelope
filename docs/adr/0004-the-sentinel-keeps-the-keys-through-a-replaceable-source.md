# 0004. 本物の鍵は Sentinel が持ち、鍵の出どころは差し替えられる口にする

- Date: 2026-11-14
- Status: Accepted

## Context

sandbox の中のエージェントは、モデルの API、GitHub、VM の API、クラスタの API server、Slack などを使う。どれにも鍵が要る。一方で、sandbox は Pi の基本のツールで何でもでき、素通しの既定のあいだは中身をどの宛先にも出せる（ADR-0003）。本物の鍵が sandbox にあれば、そのまま外へ出せてしまう。

natsumi-sentinel では、鍵は関所とは別のプロセスの鍵の番（authd）が持つ。Muse（Meta の AI エージェント）も、資格情報の保管とサロゲートの扱いを authd という別のプロセスに持たせている。Muse で authd が分かれているのは、鍵を受け取る相手が複数あるためである。Sentinel のほか、組み込みのコネクタを動かす権限分離の worker、ブラウザから直接パスワードを入れる流れがあり、authd が「確かめた呼び手がどの鍵を受け取れるか」を 1 か所で決めている。

penelope で鍵を差し替えに使うのは Sentinel だけである。

オーナーは、後で「Web UI からオーナーがサービスをつなぎ、OAuth の token や API キーを入れる」機能を作りたいと考えている。入れた鍵はエージェントにも会話にも通らず、鍵の保管の場所へ直接入り、エージェントにはそのサービスのサロゲートだけが渡る、という形である。最初の版では作らないが、最初の設計がこれを塞いではならない。

ここで使う言葉は次のとおりである。

- **サロゲート**: 本物の鍵の代わりに sandbox に置く値。Sentinel はこれを見つけて本物に差し替える。
- **鍵の出どころ**: Sentinel が本物の鍵を取りにいく先。
- **鍵の登録**: 1 つの鍵について、どのホストで、要求のどこに置き、どのサロゲートと対にするかを決めたもの。

## Decision

### 鍵は Sentinel が持つ

- 本物の鍵は Sentinel が持つ。sandbox にはサロゲートだけを置く。
- 最初は、Sentinel のコンテナに mount した Secret のファイルを鍵の出どころにする。鍵のファイルは使うたびに読み直す（kubelet が作り直す ServiceAccount の token を指せるようにするため）。
- 鍵の保管の係（authd）は、最初は作らない。差し替えに鍵を使うのが Sentinel だけで、分ける理由が弱いためである。
- Pod は ServiceAccount の token を自動では mount しない。projected の token は、Sentinel と backend のコンテナにだけ明示して mount する。sandbox には、サロゲートを持つ kubeconfig だけを置く。

### 鍵の置き場所

- 最初から差し替えるのは、要求の次の 3 か所である。
  - `Authorization` ヘッダの Bearer と token
  - `Authorization` ヘッダの Basic のパスワードの部分（git の HTTPS）
  - 名前を決めたヘッダ（API キーのヘッダなど）
- query の値は、後から置き場所として足せる形にしておく。
- path に鍵を含める方式（Slack の incoming webhook など）は使わない。
- 要求の body に鍵を含めるもの（OAuth の refresh など）と、要求に署名するもの（SigV4・HMAC など）は、差し替えでは扱わない。そのホストのコネクタが自分で鍵を持って処理する。

### 後で UI からサービスをつなぐことを塞がない

- Sentinel は、鍵を鍵の出どころの口を通してだけ取る。後で保管の場所を別のプロセス（authd）に分けても、口の先を替えるだけで済むようにする。
- 鍵の登録は、設定のファイルに固めない。最初は設定のファイルに書くが、後から実行中に登録を足せる形を見込む。
- オーナーが UI で入れる鍵の値は、エージェントにも会話にも通さない。backend は鍵の値を残さない（保管の場所へ直接入れるか、backend は中継するだけにする）。
- OAuth の更新（refresh）は、鍵の出どころかコネクタのプラグインが持つ。

### 守る対象と、失敗したときの倒し方

- 守る対象は本物の鍵の値である。鍵の値は sandbox・会話・記録・ログのどこにも出さない。
- 差し替えるのは、鍵の登録のホストへの通信だけである。
- 鍵の出どころから鍵が読めないときは、その要求を上流へ送らずに断る。

### 本 ADR で決定しないこと

- サロゲートが、登録の無いホストや登録に無い置き場所で出ていくときの扱い（断るか、そのまま送るか）（委譲先: [Sentinel の設定と記録の仕様書](../sentinel-config.md)）
- 鍵の登録の設定の形と、サロゲートの値の形（委譲先: [Sentinel の設定と記録の仕様書](../sentinel-config.md)）
- UI からサービスをつなぐ機能そのもの（どのサービスを、どの画面で、OAuth の流れをどう持つか）（委譲先: その機能を作るときの ADR）
- 鍵の保管を authd に分ける時期と、その呼び手ごとの ACL（委譲先: Sentinel のほかに鍵を使う相手が出てきたときの ADR）
- 個別のホストへどの鍵を割り当てるか（委譲先: 配置のリポジトリの設定）

## Consequences

- 鍵は sandbox の外にあるので、sandbox が乗っ取られても鍵の値は漏れない。漏れるのはサロゲートだけである。
- 最初の Sentinel は、鍵の保管と差し替えを 1 つのプロセスで持つ。部品が 1 つ減る。
- 一方で、Sentinel は入力（sandbox の要求）を読むプロセスと鍵を持つプロセスを兼ねる。Sentinel に穴があれば鍵に届く。natsumi-sentinel が authd を分けて得ていた「入力を解くプロセスに鍵の値が無い」守りは、最初は持たない。
- 鍵の出どころを口にしておくので、後で authd を分けても、UI からサービスをつなぐ機能を足しても、差し替えの部分は変わらない。
- サロゲートを持つ要求は、エージェントの名で本物の操作になる。鍵が漏れないことは、操作を止めることではない。操作の判定は、既定を ask に切り替えた後のコネクタで行う（ADR-0003）。

## Alternatives Considered

- **最初から authd を分ける（natsumi-sentinel・Muse の形）**: 鍵を受け取る相手が Sentinel だけのうちは、ACL を置く場所が要らない。口を差し替えられる形にしておけば、後から分けられる。

## Related ADRs

- Related: ADR-0002 出来事は取り込み口 1 つの待ち行列に入れ、sandbox の runner が取りにいく（backend への鍵もサロゲートにする）
- Related: ADR-0003 sandbox の外向きはすべて Sentinel を通し、既定は素通しで記録する（鍵を差し替えるホストを開く）
- Related: ADR-0009 最初の UI は Web だけにし、新しい API と Astryx で作る
- Related（natsumi-sentinel、このリポジトリの外）: ADR-0003「道具にはいつもサロゲートを持たせ、authd だけが本物に差し替えて送る」、ADR-0007「関所が判定して自分で上流へ送り、authd は鍵を保管して要求ごとに渡す」

## References

- Meta AI Research「How We Built Safety Into Muse」（https://muse.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse 、2026-11-14 確認）: authd は OAuth の token を含む資格情報の保管とサロゲートを扱う。"Authd decides which credential material the authenticated caller can receive"。権限分離の worker は cgroup で見分けられ、それぞれに資格情報の allow-list がある。ブラウザの資格情報の流れは authd へ向かう
- natsumi-sentinel ADR 0003（https://github.com/yuanying/natsumi-sentinel/blob/main/docs/adr/0003-surrogate-keys-swapped-only-by-authd.md 、2026-11-14 確認）
- natsumi-sentinel ADR 0007（https://github.com/yuanying/natsumi-sentinel/blob/main/docs/adr/0007-the-gate-sends-upstream-and-authd-keeps-the-keys.md 、2026-11-14 確認）: 関所と authd を分けて得るのは、入力を解くプロセスに鍵の値が無いことである
- natsumi-sentinel `docs/authd-registration.md` の「鍵のファイル」（https://github.com/yuanying/natsumi-sentinel/blob/main/docs/authd-registration.md 、2026-11-14 確認）: 鍵のファイルは使うたびに読み直す。置き場所は Bearer・Basic・名前を決めたヘッダ
