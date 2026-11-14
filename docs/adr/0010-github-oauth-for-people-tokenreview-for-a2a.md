# 0010. 人は GitHub OAuth で、A2A の送り手は ServiceAccount の token で確かめる

- Date: 2026-11-14
- Status: Accepted

## Context

backend には、外から 2 種類の呼び手が来る。オーナーが Web UI から使う呼び手と、ほかのエージェントが A2A で頼みごとをする呼び手である（ADR-0002）。

今の natsumi では、次のようになっている。

- オーナーのログインは、server の GitHub OAuth で行う。
- A2A の受け口は、2 つの確かめ方を持つ。1 つは、クラスタの入口の認証の前段（gated）が送り手の ServiceAccount の token を確かめて落とし、代わりに付ける署名付きの assertion を確かめる方式である。もう 1 つは、送り手ごとの Bearer の token である。
- 今のペネロペに頼みごとをしている送り手は、クラスタの中の ServiceAccount の token で呼んでいる。

オーナーは、penelope から gated に依存しているところを無くしたいと考えている。一方で、今の送り手は変えずにつなぎたい。

## Decision

### オーナーは GitHub OAuth

- オーナーのログインは、backend の GitHub OAuth で行う。通すのはオーナーの GitHub アカウントだけである。
- natsumi のログインの部分を写す。OAuth App は penelope のために新しく作る。
- Mac・iPhone のアプリを後でつなぐときは、Bearer の token で確かめる。

### A2A は ServiceAccount の token を TokenReview で確かめる

- A2A の受け口は、送り手の ServiceAccount の token を受け取り、backend が Kubernetes の TokenReview で確かめる。
- 通す送り手は、設定の allow-list（ServiceAccount の名前）で決める。
- 受ける token の audience は設定で選べる。今の送り手が使っている audience も受けられるようにし、送り手を変えずにつなぐ。
- backend の ServiceAccount に、TokenReview を呼ぶ権限を与える。
- penelope の Ingress は、gated の後ろではないふつうの Ingress にする。

### 出ていく向きも gated を知らない

- ペネロペが gated の後ろのサービスを呼ぶときの ServiceAccount の token は、サロゲートにして Sentinel が本物に差し替える（ADR-0004）。ペネロペは gated の存在を知らない。
- 相手のサービスから gated を外すことは、penelope の範囲外とする。

### 守る対象と、失敗したときの倒し方

- 守る対象は、backend の UI 向けの API と、A2A の受け口である。
- GitHub のアカウントがオーナーのものと一致しないときは、ログインさせない。オーナーのアカウントが設定されていなければ、誰もログインできない。
- TokenReview が失敗したとき、または答えが得られないときは、A2A の要求を受けない。allow-list が空なら、どの送り手も受けない。

### 本 ADR で決定しないこと

- ログインのセッションの寿命と cookie の扱い（委譲先: backend の仕様書。実装の作業単位で `docs/` に置く）
- allow-list に載せる個別の送り手と、受ける audience の値（委譲先: 配置のリポジトリの設定）
- Mac・iPhone のアプリ向けの token の発行の仕方（委譲先: アプリをつなぎ直すときの ADR）

## Consequences

- penelope は gated に依存しない。受ける向きも出ていく向きも、gated の形が変わっても penelope のコードは変わらない。
- 今の送り手は token の取り方を変えずに頼みごとを続けられる。
- 一方で、TokenReview は API server への問い合わせなので、API server が止まると A2A の受け口も止まる。
- 送り手ごとの Bearer の token を持たないので、クラスタの外のエージェントからは、そのままでは受けられない。
- gated の後ろではない Ingress になるので、backend の UI 向けの API と A2A の受け口が、そのまま入口に出る。backend 自身の確かめ方だけが守りになる。

## Alternatives Considered

- **送り手ごとの Bearer の token**: 送り手を変える必要があり、token の配り直しと失効の管理が増える。
- **ServiceAccount の token の署名を JWKS で backend が自分で確かめる**: API server を呼ばずに済むが、取り消した token を見分けにくい。

## Related ADRs

- Related: ADR-0002 出来事は取り込み口 1 つの待ち行列に入れ、sandbox の runner が取りにいく（A2A の受け口は backend の中の受信元）
- Related: ADR-0004 本物の鍵は Sentinel が持ち、鍵の出どころは差し替えられる口にする
- Related: ADR-0009 最初の UI は Web だけにし、新しい API と Astryx で作る
- Related（natsumi、このリポジトリの外）: ADR 0006「GitHub ログイン・セッション・HTTPS/WSS の待ち受け」、ADR 0084「gated の後ろの係は、gated の audience の token で呼ぶ」

## References

- natsumi の README の A2A の受け口の節（https://github.com/yuanying/natsumi/blob/main/README.md 、2026-11-14 確認）: 認証は gated の assertion か `Authorization: Bearer`。gated の後ろで受けるなら、送り手は gated の audience の ServiceAccount の token で呼び、gated が token を落として assertion に置き換える
- natsumi ADR 0006（https://github.com/yuanying/natsumi/blob/main/docs/adr/0006-github-login-and-transport.md 、2026-11-14 確認）
- natsumi ADR 0084（https://github.com/yuanying/natsumi/blob/main/docs/adr/0084-calling-agents-behind-gated-with-its-audience.md 、2026-11-14 確認）
- Kubernetes の TokenReview（https://kubernetes.io/docs/reference/kubernetes-api/authentication-resources/token-review-v1/ 、2026-11-14 確認）
