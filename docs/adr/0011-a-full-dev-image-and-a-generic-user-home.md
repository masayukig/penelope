# 0011. sandbox の image は開発の一式を持ち、汎用のユーザーの HOME で作業する

- Date: 2026-11-14
- Status: Accepted

## Context

penelope は、最初からなんでもできる Coding Agent である（ADR-0001）。オーナーは、gh・curl・go・python などの開発の道具を最初からすべて持たせたいと考えている。ペネロペはクラスタの運用係なので、Kubernetes の運用の道具と、VM の API の CLI も使う。

sandbox で永続する場所は、`/memory`、作業の場所、Pi のセッションの記録である。オーナーは、作業の場所に `/work` のような専用のディレクトリを作るより、ユーザーの HOME を積極的に使わせたいと考えている。道具とモデルの慣習が HOME を前提にしているためである。

コードはキャラクターに依存させない（ADR-0001）。image も、エージェントの名前に依存させたくない。

## Decision

### 最初から持つ道具

- sandbox の image は、次の一式で始める。
  - 土台: Debian、Node 24、bash、git、curl、jq、ripgrep、fd、make、ssh の client
  - 言語: Node、Go、Python 3（uv）、Ruby
  - 運用: kubectl、helm、kustomize、sops、VM の API の CLI、クラスタの運用の手引きで使う道具
  - GitHub: gh
  - 頼みごと: A2A の CLI（Sentinel を通して呼ぶ）
- image に入れるのは、毎回要るものと、後から入れにくいものだけにする。ほかの道具は、エージェントが sandbox の中で自由に足す。
- Sentinel の CA は image でシステムの信頼の置き場に入れる（ADR-0003 の Decision「CA は image で信頼させる」）。

### ユーザーと HOME

- image は、すべてのインスタンスで 1 つにする。
- Unix のユーザーは汎用の名前で固定する（例: `agent`、UID 1000、HOME は `/home/agent`）。passwd に書いておく。
- エージェントの名前は設定と記憶から取り、Unix のユーザー名には使わない。
- 永続する作業の場所は HOME の 1 つにする。`/work` は作らない。短い名前の作業の場所が欲しければ、HOME の下に作る。
- 永続する場所は、`/memory`、HOME、Pi のセッションの記録である。

### 本 ADR で決定しないこと

- 各道具の版と、その上げ方（委譲先: sandbox の image の Dockerfile と Renovate の設定。repo-bootstrap の作業単位で入れる）
- 汎用のユーザー名を `agent` にするかどうかの最終の名前（委譲先: sandbox の image の実装の PR）
- Pi のセッションの記録を HOME の下に置くか、別の永続ボリュームにするか（委譲先: sandbox の image の実装の PR）

## Consequences

- エージェントは、最初からほとんどの作業を道具を足さずに始められる。
- HOME に作業の場所と道具の設定が集まるので、道具の既定の置き場所がそのまま使える。
- image が 1 つなので、ほかのキャラクターに広げるときも image を作り直さずに済む。
- 一方で、image は大きくなり、作り直しと取得に時間がかかる。
- エージェントが sandbox の中で足した道具は HOME の外に入ると、Pod を作り直したときに消える。HOME の下に入れるか、image に足すかを使いながら決める。
- 汎用のユーザー名なので、プロセスやファイルの持ち主の名前からはキャラクターが分からない。

## Alternatives Considered

- **起動のときに設定の名前で passwd を作る**: キャラクターの名前が Unix のユーザーにも出るが、起動のときの仕掛けが要る。
- **作業の場所を `/work` に置く**: 道具とモデルの慣習が HOME を前提にしており、2 つの場所を使い分けることになる。

## Related ADRs

- Related: ADR-0001 1 つの Pod に backend・Sentinel・sandbox・receivers を置き、Pi ごと sandbox の中で動かす
- Related: ADR-0003 sandbox の外向きはすべて Sentinel を通し、既定は素通しで記録する
- Related（natsumi、このリポジトリの外）: ADR 0099「作業環境に GitHub の CLI の gh を入れ、token は image に持たせない」

## References

- natsumi ADR 0099（https://github.com/yuanying/natsumi/blob/main/docs/adr/0099-gh-in-the-workspace.md 、2026-11-14 確認）
