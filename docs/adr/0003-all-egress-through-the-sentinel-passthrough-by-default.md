# 0003. sandbox の外向きはすべて Sentinel を通し、既定は素通しで記録する

- Date: 2026-11-14
- Status: Accepted

## Context

penelope の sandbox では、Pi の基本のツールと開発の道具が自由に動く（ADR-0001）。オーナーが絞りたいのはネットワークの宛先だけで、それも「最初は基本すべて許し、使ってみてから徐々に絞る」形を求めている。最初から固く守ると、何に使うかが分かる前に表を書くことになるためである。

今の natsumi の関所（natsumi-sentinel）は、この逆の前提で作られている。

- 宛先の扱いは既定が deny で、表とオーナーの許しにあるものだけが通る。
- コードの半分以上は、既定 deny のための部品（操作の表、許しの台帳、承認、宛先の許し、GitHub の操作の解析、知らせ）である。
- 鍵の持ち方は、鍵の番（authd）が上流へ送る形から、関所が送り authd は鍵を渡す形へ改められ、その移行の途中にある。

ここに既定の素通しを足すと、素通しが判定の層の中の特例になる。一方で、透過の向け直し、元の宛先の取り方、TLS の SNI の読み取り、証明書の生成、上流へ送る部品は、既定がどちらでも使える。

ここで使う言葉は次のとおりである。

- **素通し（passthrough）**: TLS を開かずに、元の宛先へそのまま中継すること。記録は宛先・ポート・量・時間までになる。
- **開く（MITM）**: Sentinel の CA で TLS を終端して要求を読み、記録し、必要なら鍵を差し替えて上流へ送ること。
- **コネクタ**: 1 つのホストに特化した判定や処理を、Sentinel に差し込むプラグイン。

## Decision

### sandbox の外向きは 1 本の道

- sandbox の UID の外向きの通信は、名前解決も含めてすべて Sentinel へ向け直す（透過）。道具は本物の URL に話し、道具の側の協力に頼らない。
- オーナーへの返事・途中経過（backend 宛て）も、Slack への投稿も、ほかの通信と同じく sandbox から出る HTTP の通信として Sentinel を通す（ADR-0002）。返事のための専用の口は作らない。
- 返事や投稿のためのツールは、HTTP を呼ぶだけの薄いものにする。宛先ごとの判定は、そのホストのコネクタとして Sentinel に差し込む。

### Sentinel は penelope に小さく新しく書く

- Sentinel はこのリポジトリに新しく書く。natsumi-sentinel からは低い層だけを写す。写すのは、透過の向け直しと元の宛先の取り方（IPv4・IPv6）、SNI の読み取り、証明書の生成、上流へ送る部品（flush・Upgrade・hop-by-hop の扱い）、サロゲートの置き場所の形である。
- 判定（コネクタ）と鍵の差し替えは、プラグインの形で新しく書く。
- natsumi-sentinel は、natsumi のキャラクターたちのために残す。

### 既定の扱いは切り替えられる

- 開くと決めていないホストの扱いの既定は、設定で選べる。選べるのは、素通し（記録だけ）、ask（オーナーに聞く。ADR-0005）、deny である。
- 最初は既定を素通しにする。使うホストが分かってきたら、素通しでよいホストを allow として書き、既定を ask に切り替える。
- 素通しの通信も、開く通信も、止めた通信も、すべて Sentinel の記録に残す。

### 開くのは選んだホストだけ

- 鍵を差し替える必要のあるホストだけを開く。最初に開くのは、次の役割のホストである。
  - モデルの API
  - GitHub（REST・GraphQL の API と、git の HTTPS）
  - VM の API
  - クラスタの API server
  - クラスタの中の、認証の前段の後ろにあるサービス（脆弱性の追跡、リリースの遅れの追跡、監視の警報、ほかのエージェント）
  - backend（同じ Pod の中）
  - Slack
- 最初は判定のコネクタを入れない。開いたホストでも、鍵を差し替えて送り、記録するだけである。コネクタは、既定を ask に切り替えるときに要るものから足す。
- 具体的なホスト名の一覧は、配置のリポジトリの設定に書く。

### ホストの扱いは汎用の設定で

- 特定のホストを特別扱いするコードを書かない。クラスタの API server も、設定の 1 件として扱う。
- 開くホストの登録ごとに、上流の証明書を確かめる CA を指定できる。省けばシステムの CA を使う。
- Upgrade の中継（exec・port-forward・WebSocket など）を汎用に扱う。
- 名前で SNI を決めるため、sandbox の道具には IP ではなく名前で宛先を書かせる（クラスタの API server なら、クラスタの中の Service の名前）。

### CA は image で信頼させる

- Sentinel の CA を、sandbox の image でシステムの信頼の置き場に入れる。あわせて、Node と Python が自前の CA の束を使わないよう、システムの束を指す環境変数を image に設定する。
- 自前の CA の束を持つ道具で証明書の誤りが出たときのために、システムの束の場所をシステムプロンプトに 1 行だけ書く（ADR-0008）。
- プロンプトだけで伝えない。Pi 自身が sandbox の中にいるので、モデルの API への最初の通信には、プロンプトより前に CA が要るためである。

### 私用のアドレスも素通し、loopback とリンクローカルは止める

- 名前が私用のアドレス（家の中・クラスタの中）に解決される通信も、既定の扱いに従う。私用のアドレスだけを既定で止めることはしない。守りは、後から NetworkPolicy と網の Firewall で整える。
- sandbox の UID から同じ Pod の loopback へは直に届かないようにする。backend への道を Sentinel 越しに限るためである（ADR-0002）。
- リンクローカル（IPv4 の 169.254.0.0/16、IPv6 の fe80::/10）への通信は止める。クラウドの metadata の類を指すためである。
- 止めた通信も記録に残す。

### 守る対象と、失敗したときの倒し方

- 守る対象は、本物の鍵（ADR-0004）と、sandbox の外向きを必ず記録に通すことである。素通しの既定のあいだ、記憶や作業の中身がどの宛先へも出せることは受け入れる。
- Sentinel が止まっているときは、sandbox の外向きはどこへも出ない。向け直しの規則は Sentinel が動いていなくても残るためである。
- Sentinel の設定が読めないときは、Sentinel は起動しない。動いている最中に読み直しに失敗したときは、前の設定のまま動き続ける。

### 本 ADR で決定しないこと

- 記録の形式と保存期間、記録の見方（委譲先: Sentinel の仕様書。実装の作業単位で `docs/` に置く）
- コネクタの差し込み口の形と、最初に作るコネクタ（委譲先: 既定を ask に切り替えるときの ADR）
- allow・ask・deny の判定の規則の書き方（method・path などの扱い）（委譲先: 既定を ask に切り替えるときの ADR）
- NetworkPolicy と網の Firewall の中身（委譲先: 配置のリポジトリ）
- 鍵の差し替え（委譲先: ADR-0004）

## Consequences

- sandbox から出る通信は、どの道具からでも、どの宛先でも記録に残る。何に出ようとしたかを見てから絞り方を決められる。
- 最初の Sentinel は、透過の中継・記録・鍵の差し替えだけの小さなものになる。既定 deny のための部品を持たない。
- 一方で、素通しの既定のあいだは、記憶や作業の中身をどの宛先にも出せる。中にあるのはサロゲートだけなので鍵は漏れないが、情報は漏れうる。記録で気づくことに頼る。
- 私用のアドレスを止めないので、NetworkPolicy が入るまで、クラスタの中・家の中のサービスに素通しで届く。クラスタの中の Service へは API server を通らないので、RBAC・アドミッションの床・監査のログを経ない。Sentinel の記録には残る。オーナーはこれを、NetworkPolicy と Firewall を整える動機として受け入れた。
- natsumi-sentinel と penelope の Sentinel が別々に育つ。低い層の直しを両方に入れる手間を受け入れる。
- 返事も Sentinel を通るので、Sentinel の故障はエージェントが黙ることとして現れる。

## Alternatives Considered

- **natsumi-sentinel を伸ばして既定の素通しを足す**: 透過・CA・鍵・台帳・GitHub のコネクタがすでにあるが、素通しが既定 deny の判定の層の中の特例になる。鍵の持ち方の移行の途中でもある。
- **すべてのホストを開く**: 中身まで記録できるが、証明書を独自に確かめる道具や、HTTP でない通信が壊れる。鍵を差し替える必要の無いホストを開く理由が無い。
- **私用のアドレスは内側のドメインの名前だけに届かせる（今のペネロペの決定）**: 引き継がなかった。守りを網の層で整える方を採った。
- **CA はプロンプトで伝える**: Pi 自身の最初の通信に間に合わない。

## Related ADRs

- Related: ADR-0001 1 つの Pod に backend・Sentinel・sandbox・receivers を置き、Pi ごと sandbox の中で動かす
- Related: ADR-0002 出来事は取り込み口 1 つの待ち行列に入れ、sandbox の runner が取りにいく
- Related: ADR-0004 本物の鍵は Sentinel が持ち、鍵の出どころは差し替えられる口にする
- Related: ADR-0005 承認待ちは Sentinel が持ち、オーナーは Web UI で答える
- Related: ADR-0008 プロンプトは事実と環境だけを伝え、やり方は任せる
- Related: ADR-0011 sandbox の image は開発の一式を持ち、汎用のユーザーの HOME で作業する
- Related（natsumi-sentinel、このリポジトリの外）: ADR-0002「作業環境の外向きの通信を透過で関所に通し、宛先ごとに扱いを決める」、ADR-0007「関所が判定して自分で上流へ送り、authd は鍵を保管して要求ごとに渡す」、ADR-0008「表に無い宛先は、断った名前を関所が覚え、本人が許せば台帳の許しで通す」

## References

- natsumi-sentinel ADR 0002（https://github.com/yuanying/natsumi-sentinel/blob/main/docs/adr/0002-transparent-egress-through-the-gate.md 、2026-11-14 確認）: 既定 deny、透過の向け直し、扱いを開く・passthrough・deny の 3 つに分ける
- natsumi-sentinel ADR 0007（https://github.com/yuanying/natsumi-sentinel/blob/main/docs/adr/0007-the-gate-sends-upstream-and-authd-keeps-the-keys.md 、2026-11-14 確認）: 鍵の持ち方を改め、次の版から関所が上流へ送る
- natsumi-sentinel ADR 0008（https://github.com/yuanying/natsumi-sentinel/blob/main/docs/adr/0008-unlisted-destinations-allowed-by-the-owner.md 、2026-11-14 確認）
- natsumi-sentinel のコード（https://github.com/yuanying/natsumi-sentinel 、`internal/origdst`・`internal/certs`・`internal/upstream`・`internal/gate/passthrough.go`、2026-11-14 確認）。テストを除く Go のコード 12,572 行のうち、`internal/approvals`・`internal/ledger`・`internal/decide`・`internal/github`・`internal/notice`・`internal/routes`・`internal/observe`・`internal/domains`・`internal/gate/granted.go` が 7,410 行
- Meta AI Research「How We Built Safety Into Muse」（https://muse.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse 、2026-11-14 確認）: 経路は forward proxy と Linux の網の制御。L4 では名前・解決したアドレス・ポート・プロトコル、L7 では method・path・要求の中身を見る。公の名前が私用のアドレスに解決されるのを防ぐ制限がある。TLS をどう開くか、CA をどう信頼させるかは書かれていない
