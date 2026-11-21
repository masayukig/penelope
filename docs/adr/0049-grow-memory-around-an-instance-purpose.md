# 0049. 配置ごとの目的に沿って記憶を知識ベースに育てる

- Date: 2026-11-21
- Status: Accepted

## Context

`/memory` は git で履歴を持つ Markdown の記憶である。日中にエージェントがトピックを書き、夜に照合係が記述を原本で確かめ、整理係が見つけやすく組み直す。日中のエージェントと夜の係には配置ごとの役目が伝わるが、その役目を果たすために何を知っているべきかは伝わらない。たとえば、クラスタを運用する役目だけでは、運用を続けるうえでどの判断に根拠を残すべきかまでは分からない。

`goals/` には長く続く目標や日課、今日の計画が入る。計画はその日にすることを決めるためにあり、数年にわたってどんな知識を身につけるべきかの基準とは異なる。

## Decision

### 1. トピックをそのまま知識ベースにする

既存の `/memory` 直下の自由なトピックを知識ベースとし、`knowledge/` は設けない。日中にエージェントがトピックを書くことを主とし、夜は書き漏らしを拾い、日をまたぐパターンを知識にまとめ、探しやすくする。ページ構成を固定するのではなく、これらの判断に使う目的を配置ごとに渡す。

### 2. 知識の目的は `/memory/PURPOSE.md` に置く

`PURPOSE.md` を任意の固定名として足す。「何を知っているべきか」と、その知識で「答えられるべき問い」を書く。「何をするか」は `goals/` に残し、`PURPOSE.md` は `goals/` がなくても成り立つ。日中のシステムプロンプトには `personality.md`、`always.md`、`handoff.md` に続く 4 つ目の「毎回読む層」として本文を入れる。ファイルがなければ入れず、各ファイルがプロンプトに入る大きさの上限は変えない。

エージェントから目的の追加や変更を持ちかけてよいが、オーナーの同意を得てから書く。夜の係は目的を書き換えない。これは skill で伝える運用上の約束であり、書き手の検査、コミットの拒否、強制的な差し戻しは設けない。

### 3. 書き方は記憶の skill に置く

`/memory/skills/memory/SKILL.md` はオーナーが種を入れ、エージェントが育てる。トピックには今の状態を書き、変化があればその記述を更新する。経緯は日記に残し、文ごとに主語を書き、関係するページにリンクする。runner は夜の係にこの skill の場所を伝える。image の skill の選択や優先順位は変えない。

例外として、変わりうる事実にはいつの時点か、何で確かめたかを書く、という 1 行だけを日中と夜の係のシステムプロンプトに置く。記録時に残さなければ後から補えないことがあるため、記憶の形の説明に含める。確かめ方は指示せず、モデル別の手順を日中に広げることもしない。

### 本 ADR で決定しないこと

- プロンプトの文面（委譲先: runner のプロンプトの実装）
- 配置ごとの `PURPOSE.md` と記憶の skill の種の文面（委譲先: オーナー。エージェントとの共同作成も可）
- 種を入れる順序・検証期間・事前のバックアップの手順（委譲先: 配置の運用）

## Consequences

- エージェントと夜の係が同じ目的を使い、配置ごとに異なる知識を育てられる。新しい階層を作らないので、既存のトピックやリンクは移さなくてよい。
- `PURPOSE.md` は毎回の入力を増やす。目的が曖昧だったり役目の変化に追従しなかったりすれば、昼夜ともに見当違いの知識を育てる。目的はオーナーとの合意で見直す必要がある。
- オーナーの同意は仕組みで強制しない。約束に反した変更を未然に止めず、発見したときに履歴で確認し戻せるほうを選ぶ。

## Related ADRs

- Supersedes（一部）: [ADR-0006 記憶は `/memory` の形を保ち、検査をやめ、コミットだけを sandbox の外で行う](0006-memory-kept-compatible-without-checks-committed-outside.md) の Decision「`/memory` の形を保つ」に任意の固定名を追加し、「検査をやめる」のうち書き手の決まりを置かない点に、検査で強制しない合意の約束を加える。「プロンプトに入れるときだけ長さを見る」は維持する。
- Supersedes（一部）: [ADR-0008 プロンプトは事実と環境だけを伝え、やり方は任せる](0008-prompts-state-facts-and-leave-the-how.md) の Decision のうち、プロンプトに足す記憶の範囲と、書き方の規則を置かない点に上記の例外を設ける。
- Related: [ADR-0035 道具の使い方とどの配置にも同じ skill は sandbox の image に skill として入れ、オーナー・記憶の後に並べる](0035-tool-usage-and-shared-skills-as-image-skills.md) と [ADR-0042 配置が一覧に載せる image の skill を選ぶ](0042-select-image-skills-per-deployment.md) の扱う image の `goals` skill は仕事の計画を扱う。記憶の書き方は記憶の skill に置く。
- Related: [ADR-0045 夜のプロンプトは目的を伝え、印の付いたモデルだけに手順を足す](0045-tell-nightly-roles-their-goals-and-add-guidance-by-model.md)。時点と根拠の 1 行は共通の記憶の形であり、モデル別の手順の層は変えない。
- Related: [ADR-0050 夜は記憶の見取り図を渡し、棚卸しで中身と構成を分けて見直す](0050-organize-memory-with-a-map-and-a-weekly-review.md)（夜に目的を使う）。
- Related: [ADR-0052 棚卸しで移動した記憶への参照は runner が直す](0052-keep-memory-links-working-after-moves.md)（目的の本文の意味は変えず、移動したファイルへの参照だけを runner が修正する）。
- Related: [ADR-0053 目的に沿った問いで記憶を評価する CLI を持つ](0053-evaluate-memory-with-purpose-questions.md)（目的に置いた問いを CLI の評価に使う）。

## References

- [runner のプロンプト](../../packages/runner/src/prompts.ts) の `MEMORY_SHAPE`・`PROMPT_FILES`・`systemPrompt`・`verifierSystemPrompt`・`curatorSystemPrompt`、[runner の設定](../../packages/runner/src/config.ts) の `readConfig`（2026-11-21 確認）: トピックの扱い、毎回読む 3 ファイル、配置の役目と夜の目的、1 ファイルあたりの既定の上限 65,536 バイト。
- [goals skill](../../packages/runner/image/skills/goals/SKILL.md) の「Goals and today's plan」「Your owner's agreement」（2026-11-21 確認）: 計画の目的とオーナーの同意の扱い。
- Anthropic [The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory) の「Steering Claude to write memory」「Dreaming can focus memory on a specific goal」（2026-11-21 確認）: 覚え方を細かく縛らず、何に役立つ記憶かを伝える。
