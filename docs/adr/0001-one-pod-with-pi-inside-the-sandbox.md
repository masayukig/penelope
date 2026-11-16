# 0001. 1 つの Pod に backend・Sentinel・sandbox・receivers を置き、Pi ごと sandbox の中で動かす

- Date: 2026-11-14
- Status: Accepted

## Context

penelope は、1 人のオーナーのために 1 本の長いセッションで動き続ける Coding Agent である。最初の利用者は、オーナーの Kubernetes クラスタの運用係「ペネロペ」で、今は natsumi（Pi Coding Agent の SDK を使う個人アシスタント）の 1 インスタンスとして動いている。

今の natsumi の形には、次の制約がある。

- natsumi の server が sandbox の外で Pi を回し、sandbox での作業は shell を 1 つずつ渡すツールと、インスタンスごとに設定で宣言したツールで行う。Pi が持つ基本のツール（読む・書く・編集・bash）を、そのまま sandbox の中で使うことはできない。
- 外向きの通信は、関所（natsumi-sentinel）の既定 deny の表と、オーナーの許しで絞っている。新しい宛先を使うたびに表か許しを足す必要がある。
- server のコードには、ツール・検査・プロンプトの特例が積み重なっている。システムプロンプトは 1 ファイルで 511 行・約 58KB ある。

オーナーは、これに代えて「最初からなんでもできる Coding Agent」を求めている。Pi の基本のツールはそのまま使い、開発の道具を最初から持ち、絞るのはネットワークの宛先だけにする。外界とのやりとりはすべてツール越しに行い、セッションは 1 本で、記憶は今の `/memory` と互換に保つ。

ここで使う言葉は次のとおりである。

- **sandbox**: エージェントが作業するコンテナ。本物の鍵を持たない。
- **Sentinel**: sandbox の外向きの通信をすべて受け、記録し、選んだホストでは鍵を差し替えて送る中継（ADR-0003）。
- **backend**: 出来事の待ち行列、UI 向けの API、夜の切り替えを持つ server（ADR-0002、ADR-0007、ADR-0009）。
- **receivers**: Slack などの外部から出来事を受け取るプラグインを載せるプロセス（ADR-0002）。
- **runner**: sandbox の中で Pi の SDK を使ってセッションを回す小さなプロセス。

## Decision

### Pi ごと sandbox の中で動かす

- Pi のプロセスと、それを回す runner は sandbox の中で動く。Pi の基本のツールは、そのまま sandbox の中で使う。
- モデルの API への通信も sandbox の外向きの通信の 1 つであり、Sentinel を通る。モデルの API の鍵も sandbox の外にある（ADR-0004）。
- backend は薄く保つ。持つのは、出来事の待ち行列、UI 向けの API、夜の切り替え、記憶のコミット、承認の窓口だけである。考えることとツールの実行は sandbox の中にある。

### 1 つの Pod に 4 つのコンテナ

- backend・Sentinel・sandbox・receivers を、Kubernetes の 1 つの Pod の別々のコンテナにする。
- sandbox の UID の外向きは、初期化のコンテナが張るネットワークの規則で Sentinel へ向け直す。常駐するコンテナは、その規則を書き換える権限を持たない（ADR-0003）。
- 永続する場所は Pod の永続ボリュームに置く。sandbox では `/memory`・HOME・Pi のセッションの記録、backend ではその状態のファイルである（ADR-0002、ADR-0006、ADR-0011）。
- Docker・テスト用のクラスタのような重い作業は、今と同じく VM の API で作る VM で行う。sandbox はそれらを中に持たない。

### 1 つのリポジトリ、言語は 2 つ

- backend・Web UI・Sentinel・sandbox の image・receivers を、すべてこのリポジトリに置く。ADR・CI・リリースは 1 つで、image はリリースごとにコンテナの種類の数だけ作る。
- Sentinel は Go、それ以外（backend・runner・receivers・Web UI）は TypeScript で書く。Pi の SDK と Web UI が TypeScript であり、型を共有できるためである。Sentinel は natsumi-sentinel の Go の部品を写す（ADR-0003）。
- natsumi のコードは、アーキテクチャを先に決め、それに合うものだけを写す。natsumi の構造をそのまま持ち込まない。
- リポジトリは public で、MIT ライセンスとする。内側のドメインの名前、使うホストの一覧、鍵の置き場の値は、配置のリポジトリにだけ書く。このリポジトリには設定の形と、架空の値による例だけを置く。
- 特定のサービスや受信元に特化した処理は、プラグインとして差し込む形にする。本体に特例を書かない。

### コードはキャラクターに依存させない

- エージェントの名前・ID・アバター・オーナーの呼び方は、設定と記憶から取る。コード・システムプロンプト・UI の表示に、決め打ちの名前（「ペネロペ」を含む）を書かない。
- 1 つの配置で動くエージェントは 1 人である。複数のキャラクターを 1 つの配置で動かす機能は作らない。
- リポジトリと image の名前は `penelope` とする。

### 本 ADR で決定しないこと

- 各コンテナの資源の上限と、永続ボリュームの大きさ（委譲先: 配置のリポジトリの設定）
- penelope を natsumi のほかのキャラクターに広げるか（委譲先: ペネロペで使った後に書く ADR）
  - 2026-11-16 追記: ADR-0026 で、なつみ・ミャオ・アキも 1 人 1 つの配置で penelope に移すと決めた。
- Sentinel を別のリポジトリに切り出すか（委譲先: ほかのキャラクターに Sentinel を使うと決めたときの ADR）
  - 2026-11-16 追記: ADR-0026 で、切り出さず、どの配置もこのリポジトリの Sentinel を使うと決めた。

## Consequences

- Pi の基本のツールと開発の道具が、そのまま使える。ツールを 1 つずつ宣言して足す必要がなくなる。
- backend が薄くなり、エージェントの振る舞いのほとんどが Pi とプロンプトと記憶で決まる。
- 一方で、Pi のプロセスとセッションの記録は sandbox の中にある。sandbox が乗っ取られれば、モデルへの経路とセッションの中身に手が届く。鍵は外にあるので漏れないが、モデルの呼び出しはエージェントの名で行える。Sentinel の記録で気づくことを前提にする（ADR-0003）。
- 4 つのコンテナが 1 つの Pod にあるので、配置と網の規則は 1 か所で済む。代わりに、どれか 1 つを入れ替えるときも Pod 全体が作り直される。
- 言語が 2 つになり、CI とリリースは両方を扱う必要がある。
- 名前を設定から取ることで、表示に別のキャラクターの名前が残る、という今の違和感はなくなる。

## Alternatives Considered

- **Pi を sandbox の外の server で回す（今の natsumi の形）**: Pi の基本のツールを sandbox の中で使うには、ツールごとに sandbox への中継を書く必要がある。「基本のツールをそのまま」の求めに合わない。
- **sandbox を VM の API の VM にする**: なんでもできる形に近いが、網の設定と VM の運用が増える。今の Pod の形と周りの仕組みを使い回せる方を採った。
- **backend・UI・Sentinel を別のリポジトリにする**: 部品の間の契約を変えるたびに、複数のリポジトリの PR が要る。

## Related ADRs

- Related: ADR-0002 出来事は取り込み口 1 つの待ち行列に入れ、sandbox の runner が取りにいく
- Related: ADR-0003 sandbox の外向きはすべて Sentinel を通し、既定は素通しで記録する
- Related: ADR-0004 本物の鍵は Sentinel が持ち、鍵の出どころは差し替えられる口にする
- Related: ADR-0006 記憶は `/memory` の形を保ち、検査をやめ、コミットだけを sandbox の外で行う
- Related: ADR-0007 セッションは 1 本にし、夜に振り返り・整理係・新しいセッションの 3 段で切り替える
- Related: ADR-0009 最初の UI は Web だけにし、新しい API と Astryx で作る
- Related: ADR-0011 sandbox の image は開発の一式を持ち、汎用のユーザーの HOME で作業する
- Related: ADR-0026 なつみ・ミャオ・アキも 1 人 1 つの配置で penelope に移し、記憶は履歴ごと写して、戻し道は持たない（「本 ADR で決定しないこと」の 2 つに答える）

## References

- natsumi `src/server/prompts.ts`（https://github.com/yuanying/natsumi/blob/main/src/server/prompts.ts 、511 行・58,095 バイト、2026-11-14 確認）
- natsumi ADR 0019「記憶の道具をやめ、なつみの作業環境にする」（https://github.com/yuanying/natsumi/blob/main/docs/adr/0019-a-workspace-not-a-memory-tool.md 、2026-11-14 確認）
- natsumi ADR 0075「インスタンスに特有のツールを config で宣言する」（https://github.com/yuanying/natsumi/blob/main/docs/adr/0075-tools-declared-in-the-config.md 、2026-11-14 確認）
- natsumi ADR 0094「コマンドは選んだ秒数だけ待って裏に回し、ターンの中で知らせを待てるようにする」（https://github.com/yuanying/natsumi/blob/main/docs/adr/0094-background-commands-and-waiting-for-news-within-a-turn.md 、2026-11-14 確認）
- natsumi-sentinel ADR 0002「作業環境の外向きの通信を透過で関所に通し、宛先ごとに扱いを決める」（https://github.com/yuanying/natsumi-sentinel/blob/main/docs/adr/0002-transparent-egress-through-the-gate.md 、2026-11-14 確認）
