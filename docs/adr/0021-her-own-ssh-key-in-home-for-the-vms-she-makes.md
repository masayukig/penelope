# 0021. 自分で作った VM への ssh の鍵は、エージェントが自分で HOME に作る

- Date: 2026-11-14
- Status: Accepted

## Context

ペネロペは、クラスタを試すための VM を VM の API で自分で作り、ssh で入って作業する。VM の API は、VM を作るときに cloud-init の設定を受け取り、そこに ssh の公開鍵を書けば VM に入れる。

ADR-0019 は、オーナーが用意した ssh の秘密鍵を別のコンテナの ssh-agent に置き、sandbox には socket だけを渡すと決めた。この形には次の重さがある。

- sandbox と同じ UID のコンテナが 1 つ増え、Pod のコンテナはそれぞれ別の UID にするという形の例外になる。
- オーナーが鍵を作り、配置の Secret に置き、公開鍵を VM の側へ配る手間がある。
- 守っている鍵で入れるのは、どのみちペネロペが自分で作った VM だけである。

sandbox の HOME は永続する（ADR-0011 の Decision「ユーザーと HOME」）。sandbox には ssh の client（`ssh-keygen` を含む）が入っている。

sandbox には本物の鍵を置かない（ADR-0004 の Decision「鍵は Sentinel が持つ」）。この「本物の鍵」は、オーナーが持ち、配置が渡すサービスの鍵である。

## Decision

### 鍵はエージェントが自分で作る

- 自分で作った VM へ ssh で入るための鍵は、エージェントが sandbox の中で自分で作り、HOME に置く。鍵を作り直すのもエージェントである。
- 公開鍵は、エージェントが VM の API で VM を作るときに cloud-init で入れる。
- 配置は ssh の鍵を用意しない。ssh-agent のコンテナ、ssh の鍵の Secret、公開鍵を配る仕組みは置かない。
- ssh の接続は、ほかの外向きと同じく Sentinel へ向け直され、既定の扱い（最初は素通しで記録だけ。ADR-0003 の Decision「既定の扱いは切り替えられる」）に従う。Sentinel は ssh を開かない。

### ADR-0004 との関係

- ADR-0004 の Decision「鍵は Sentinel が持つ」は、オーナーが持ち配置が渡す鍵について変えない。それらは sandbox に置かず、Sentinel が差し替える。
- 例外は、エージェントが自分で作り、自分で作った VM にだけ入れる ssh の鍵である。これは sandbox の HOME にある本物の秘密鍵である。
- この例外は、ssh の鍵を sandbox の外で持つ仕組み（Sentinel での ssh の扱い、短い期限の証明書の発行など）を作るまで続く。作ったら、その ADR がこの例外を閉じる。

### 守る対象と、失敗したときの倒し方

- 守る対象は、オーナーの鍵と、オーナーのホスト（クラスタのノード、オーナーの VM）である。この鍵はそこへ入れない。
- 許す範囲は、エージェントが自分で作った VM へ入ることまでである。公開鍵を入れられるのは、エージェントがすでに作れる、または入れる VM だけなので、この鍵で新しく届く先は増えない。
- 鍵が漏れたときに入られうるのは、エージェントが作った VM だけである。その VM は作り直せる。
- 鍵が無い、または HOME から消えたときは、エージェントが作り直し、新しい VM から使う。配置にも Pod の起動にも影響しない。

### 本 ADR で決定しないこと

- 鍵の種類、ファイルの場所、cloud-init の書き方、VM の API の使い方（委譲先: 配置のリポジトリの VM の API のコネクタの文書。ADR-0020）
- ssh の宛先を Sentinel の既定と違う扱い（ask・deny）にするかどうか（委譲先: [Sentinel の設定と記録の仕様書](../sentinel-config.md) の設定）

## Consequences

- ssh のためのコンテナと Secret が無くなり、Pod のコンテナは再びそれぞれ別の UID になる。オーナーが ssh の鍵を作って配る手間も無くなる。
- エージェントは、ssh の鍵を自分の道具として普通に扱える。
- 一方で、sandbox に本物の秘密鍵が 1 つ置かれる。sandbox の中身が外へ出れば、この鍵も出うる。害は、エージェントが作った VM に限られることを受け入れる。
- 鍵の作り直しや、古い VM に残った公開鍵の扱いは、エージェントに任される。
- ssh の中身は Sentinel に見えない。記録に残るのは宛先・ポート・量・時間までである（ADR-0019 と同じ）。

## Alternatives Considered

- **ssh-agent のコンテナに鍵を置く（ADR-0019）**: 鍵は sandbox に出ないが、守っている鍵で入れるのは自分で作った VM だけであり、コンテナと UID の例外とオーナーの手間に見合わない。
- **オーナーの鍵を sandbox に mount する**: オーナーの鍵が sandbox に出る。オーナーの鍵は Sentinel が持つという ADR-0004 の形が崩れる。
- **ssh の証明書を短い期限で発行する**: 漏れたときの害は小さくなるが、発行の仕組みと、VM の側で証明書を信じる設定が要る。上の例外を閉じる候補として残す。

## Related ADRs

- Supersedes: ADR-0019 ssh は別のコンテナの ssh-agent の socket で行い、鍵は sandbox に見せない
- Supersedes（一部）: ADR-0004 本物の鍵は Sentinel が持ち、鍵の出どころは差し替えられる口にする（Decision「鍵は Sentinel が持つ」の、sandbox に本物の鍵を置かない点を、エージェントが自分で作る ssh の鍵に限り）
- Related: ADR-0003 sandbox の外向きはすべて Sentinel を通し、既定は素通しで記録する
- Related: ADR-0011 sandbox の image は開発の一式を持ち、汎用のユーザーの HOME で作業する
- Related: ADR-0020 コネクタは Sentinel の登録と使い方の文書の組にし、文書の一覧をシステムプロンプトに出す

## References

- vmapi の ADR 0005「cloud-init の seed を vmapi が作る」（https://github.com/yuanying/vmapi/blob/main/docs/adr/0005-cloud-init-seed.md 、2026-11-14 確認）: VM を作るときに呼ぶ側が送った `user-data` を、そのまま VM の cloud-init に渡す
- OpenSSH の ssh-keygen(1)（https://man.openbsd.org/ssh-keygen.1 、2026-11-14 確認）
- cloud-init の「Module reference」の `ssh_authorized_keys`（https://cloudinit.readthedocs.io/en/latest/reference/modules.html 、2026-11-14 確認）: cloud-init の設定に書いた公開鍵を、既定のユーザーの `authorized_keys` に入れる
