# 0016. 最初の Web UI からアバターと expression を出し、アバターは 1 つの部品に閉じる

- Date: 2026-11-14
- Status: Accepted

## Context

ADR-0009 の Decision「Astryx と React 19」は、最初の Web UI にアバターを出さず、返事の API に表情（expression）の欄だけを残すと決めた。画面の見た目は、オーナーが Claude design で詰めるまで決まっていなかった。

その後、オーナーは Claude design で画面を詰め、アバターと expression を最初の版から出すと決めた。決まった見た目は、このリポジトリの `docs/design/`（デザインの手引きと、採用した画面）にある。手引きでは、アバターは PC の右のパネル、PC の上の帯、スマートフォンで上に浮く位置、下からのシート、返事の名前の横、ログインの画面に出る。expression は、アバターに添える文字の札と、返事の名前の横の文字で示す。

アバターの絵はまだ 1 枚しか無く、expression の語の一覧も決まっていない。オーナーは、ゆくゆくはアバターを expression ごとの絵や 3D のモデルに替えたいと考えている。

## Decision

本 ADR は、ADR-0009 の Decision「Astryx と React 19」のうち「最初の Web UI にアバターは出さない」の点を置き換える。返事の API に expression の欄があること、エージェントの名前とアイコンを設定から出すこと（ADR-0001）は変えない。

- 最初の Web UI から、アバターと expression を出す。どこにどの大きさで出すかは `docs/design/` の手引きに従う。
- 最初の版のアバターは、設定から入る固定のアイコン 1 枚である。expression は絵を替えず、文字で添える。
- アバターは Web UI の中の 1 つの部品に閉じる。部品が受け取るのは expression と大きさだけで、アイコンと名前は設定から入る。絵の描き方を替えるときは、この部品の中だけを替え、画面の側は変えない。
- 表示する expression は、エージェントの最新の返事の expression である。expression の無い返事は、それまでの expression を変えない。

### 本 ADR で決定しないこと

- expression の語の一覧と、アバターの実際の絵（委譲先: `docs/design/` の手引きの「まだ決めていないこと」）
- expression ごとの絵や 3D のモデルに替える時期と方式（委譲先: そのときの ADR）
- Mac・iPhone のアプリでのアバター（委譲先: ADR-0009 の「本 ADR で決定しないこと」の、つなぎ直す時期の ADR）

## Consequences

- オーナーは最初の版から、エージェントの返事とともに表情を見られる。返事の API に残してあった expression の欄が使われる。
- アバターを 1 つの部品に閉じるので、絵を替えるときに画面の側を書き換えずに済む。
- 一方で、expression の語の一覧が決まらないまま、エージェントが付けた語がそのまま札に出る。語が揃わない間は、札の文字がまちまちになることを受け入れる。
- 画面にアバターの置き場所が増えるので、絵を替えるときは、どの大きさでも見分けられる絵にする必要がある。

## Related ADRs

- Supersedes（一部）: ADR-0009 最初の UI は Web だけにし、新しい API と Astryx で作る（Decision「Astryx と React 19」の、最初の Web UI にアバターを出さない点）
- Related: ADR-0001 1 つの Pod に backend・Sentinel・sandbox・receivers を置き、Pi ごと sandbox の中で動かす

## References

- Web UI のデザインの手引き `docs/design/README.md` の「6. アバター」（2026-11-14 確認）
