# 0042. 配置が一覧に載せる image の skill を選ぶ

- Date: 2026-11-19
- Status: Accepted

## Context

skill はエージェントが必要に応じて読む文書で、システムプロンプトの一覧には名前・説明・場所が載る。コネクタは配置ごとに渡す一方、sandbox の image に入れた skill はすべての配置で一覧の対象になる。そのため、コネクタを渡していない配置にも、たとえば Slack や GitHub の使い方が載る。

## Decision

ADR-0035 の Decision「道具の使い方は image の skill にする」のうち、image の skill をつねに一覧の対象にする点を置き換える。

- 配置は、一覧に載せる image の skill の名前を列挙する（allow-list）。設定しなければ従来どおりすべてが対象になり、空の設定なら 1 つも対象にしない。image にない名前は runner のログに出して飛ばし、セッションを止めない。
- 選択は本人・サブエージェント・夜の整理係のセッションに適用し、読み直しても保つ。オーナーと記憶の skill は対象外とし、同じ名前ならオーナー、記憶、image の順で先にあるものが載る。
- 絞るのは一覧だけであり、ファイルへのアクセスやコネクタの設定は変えない。

### 本 ADR で決定しないこと

- 配置が指定する設定の形式（委譲先: Pod の形の仕様書の「volume」）

## Consequences

- allow-list を指定した配置には、新しい image の skill（たとえば `signal`）を足しても、その配置が名前を書き足すまでは載らない。未設定の配置に変更は要らない。
- allow-list を指定した配置は、`self-portrait` や `goals` などの共通の skill も必要なものをすべて列挙する。後から追加された共通の skill も同じ扱いになる。
- 一覧に載せない skill のファイルも image の中には残る。エージェントがファイルを探して読むことはできる。

## Alternatives Considered

- **載せない名前を指定する（deny-list）**: 設定は短くなるが、新しく追加した image の skill はそのサービスを使わない配置にも自動で載る。
- **コネクタの名前から自動で選ぶ**: 配置が別途設定しなくて済むが、ADR-0035 の Decision「道具の使い方は image の skill にする」で決めた、image の skill とコネクタを名前で突き合わせない方針を崩す。

## Related ADRs

- Supersedes（一部）: [ADR-0035 道具の使い方とどの配置にも同じ skill は sandbox の image に skill として入れ、オーナー・記憶の後に並べる](0035-tool-usage-and-shared-skills-as-image-skills.md)（Decision「道具の使い方は image の skill にする」の、つねに一覧に載せる点）
- Related: [ADR-0049 配置ごとの目的に沿って記憶を知識ベースに育てる](0049-grow-memory-around-an-instance-purpose.md)（記憶の書き方は記憶の skill に置き、image の skill の選択は変えない）。

## References

- [runner の `openSession`](../../packages/runner/src/pi.ts)（2026-11-19 確認）: skill の置き場を Pi に渡す処理
- [`Dockerfile` の `sandbox` target](../../Dockerfile) と [image の skill](../../packages/runner/image/skills/)（2026-11-19 確認）: コネクタの設定とは別に、skill を一式 image に入れること
- [Pod の形の仕様書の「volume」](../pod.md#volume)（2026-11-19 確認）: 配置が使う設定の形式
