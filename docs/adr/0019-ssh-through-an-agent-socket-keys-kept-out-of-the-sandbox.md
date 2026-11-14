# 0019. ssh は別のコンテナの ssh-agent の socket で行い、鍵は sandbox に見せない

- Date: 2026-11-14
- Status: Superseded by ADR-0021

## Context

ペネロペは、自分で作った VM に ssh で入って作業する。そのための秘密鍵は、オーナーが用意して配置のリポジトリの Secret に置く。

sandbox には本物の鍵を置かない（ADR-0004 の Decision「鍵は Sentinel が持つ」）。HTTP の鍵は、Sentinel が選んだホストへの TLS を開いて、sandbox が持つサロゲートを本物の鍵に差し替える（ADR-0003 の Decision「開くのは選んだホストだけ」）。ssh はこの形に乗らない。ssh は HTTP ではなく、鍵は要求の中の 1 つのヘッダではなく、接続のたびの署名に使われる。Sentinel が ssh の接続を開いて署名を差し替えるには、ssh の中継を丸ごと作ることになる。

ssh-agent は、秘密鍵を持ったまま、Unix socket で頼まれた署名だけを返すプロセスである。OpenSSH の文書は、agent に届く者は鍵で認証する操作はできるが、鍵そのものは取り出せないとしている。また ssh-agent は、socket につないできたプロセスの UID が自分と違えば（root を除き）接続を断る。

Pod の中のコンテナは、同じ volume を mount すれば、その中の Unix socket を共有できる（ADR-0014 の Decision「Pod の中の口は Unix socket だけで待ち受ける」で使っている形）。

## Decision

本 ADR は ssh の秘密鍵だけを扱う。ADR-0004 の Decision「鍵は Sentinel が持つ」のうち、sandbox に本物の鍵を置かない点は ssh の鍵にもそのまま当てる。本物の鍵を持つのが Sentinel である点は、ssh の鍵に限り ssh-agent のコンテナに替える。HTTP の鍵の持ち方は変えない。

### 鍵は ssh-agent のコンテナにだけ置く

- ssh の秘密鍵は、Pod の中の ssh-agent のコンテナにだけ mount する。sandbox には mount しない。
- ssh-agent のコンテナは、起動のときに鍵を agent に入れ、agent の socket を sandbox と共有する volume に置く。sandbox には、その socket の場所だけを設定で伝える。
- sandbox の ssh の client は、その socket で agent に署名を頼む。sandbox から鍵のファイルは読めない。
- ssh-agent のコンテナは任意である。置かない配置では、sandbox に socket の設定が無く、ssh の鍵は無い。

### ssh-agent のコンテナは sandbox と同じ UID で動く

- ssh-agent は自分と違う UID からの接続を断るので、ssh-agent のコンテナは sandbox と同じ UID で動く。
- 網の向け直しは sandbox の UID で選ぶので（ADR-0003 の Decision「sandbox の外向きは 1 本の道」）、このコンテナの外向きも Sentinel へ向け直される。ssh-agent は外へつながないので、向け直されて困る通信は無い。向け直される側に倒れるので、Sentinel を通らない道も増えない。

### ssh の通信は Sentinel の既定の扱いに従う

- ssh の接続は、ほかの外向きと同じく Sentinel へ向け直され、Sentinel の既定の扱い（最初は素通しで記録だけ。ADR-0003 の Decision「既定の扱いは切り替えられる」）に従う。Sentinel は ssh を開かず、ssh のための仕組みも持たない。

### 守る対象と、失敗したときの倒し方

- 守る対象は ssh の秘密鍵である。sandbox が鍵の中身を読めないことを守る。
- ssh-agent のコンテナと sandbox は同じ UID なので、Pod はコンテナどうしでプロセスの名前空間を共有しない。共有すると、sandbox から同じ UID の agent のプロセスに手が届き、鍵を守る境目がファイルの mount だけではなくなる。
- 許す範囲は、sandbox が agent の鍵で認証すること（署名を頼むこと）までである。鍵を登録した先にだけ入れるのは、鍵を登録する側で決める。
- 鍵が無い、または agent に入れられないときも、agent は立てて何も署名しない。Pod の起動は止めない。ssh が認証できないだけになる。
- socket が無いときに、sandbox へ鍵を置いて代わりにすることはしない。

### 本 ADR で決定しないこと

- ssh-agent のコンテナの image、socket の置き場所、鍵の mount の形（委譲先: [Pod の形の仕様書](../pod.md) の「ssh-agent のコンテナ（任意）」と配置のリポジトリ）
- 鍵を登録する VM とそのユーザー（委譲先: 配置のリポジトリの運用手順）
- ssh の宛先を Sentinel の既定と違う扱い（ask・deny）にするかどうか（委譲先: [Sentinel の設定と記録の仕様書](../sentinel-config.md) の設定）

## Consequences

- VM への ssh を、鍵を sandbox に見せずに使える。sandbox の中身がどこへ出ても、鍵そのものは出ない。
- ssh の仕組みを Sentinel に足さずに済む。Sentinel は ssh を、ほかの読まない通信と同じく記録するだけである。
- 一方で、sandbox は agent が動いている間、鍵で認証する操作は何度でもできる。鍵を登録した先の範囲で、その操作を許すことを受け入れる。
- ssh の中身は Sentinel に見えない。記録に残るのは宛先・ポート・量・時間までである。
- sandbox と同じ UID のコンテナが 1 つ増え、Pod のコンテナはそれぞれ別の UID にするという形の例外になる。

## Alternatives Considered

- **鍵を sandbox に mount する**: いちばん単純だが、sandbox に本物の鍵を置かないという ADR-0004 の Decision「鍵は Sentinel が持つ」の形が崩れる。
- **Sentinel に ssh の中継を作り、署名を差し替える**: 鍵を Sentinel に集められるが、ssh の中継を丸ごと作ることになり、Sentinel を小さく保てない。
- **ssh の証明書を短い期限で発行する**: 鍵が漏れたときの害は小さくなるが、発行の仕組みと、VM の側で証明書を信じる設定が要る。

## Related ADRs

- Superseded by: ADR-0021 自分で作った VM への ssh の鍵は、エージェントが自分で HOME に作る
- Supersedes（一部）: ADR-0004 本物の鍵は Sentinel が持ち、鍵の出どころは差し替えられる口にする（Decision「鍵は Sentinel が持つ」の、本物の鍵を Sentinel が持つ点を ssh の秘密鍵に限り）
- Related: ADR-0001 1 つの Pod に backend・Sentinel・sandbox・receivers を置き、Pi ごと sandbox の中で動かす
- Related: ADR-0003 sandbox の外向きはすべて Sentinel を通し、既定は素通しで記録する
- Related: ADR-0014 sandbox の loopback は sandbox に任せ、Pod の中の口は Unix socket だけで待ち受ける
- Related（natsumi、このリポジトリの外）: ADR 0085「作業環境から鍵の要る API とノードへ、鍵を見せずに中継で出る」（ssh の秘密鍵は ssh-agent のコンテナにだけ mount する）

## References

- OpenSSH の ssh(1) の `-A` の項（https://man.openbsd.org/ssh.1 、2026-11-14 確認）: agent に届く者は鍵の素材を取り出せないが、agent の鍵で認証する操作はできる
- OpenSSH の ssh-agent(1) の `-a`・`-D` と `SSH_AUTH_SOCK` の項（https://man.openbsd.org/ssh-agent.1 、2026-11-14 確認）
- natsumi ADR 0085（https://github.com/yuanying/natsumi/blob/main/docs/adr/0085-relays-that-add-the-keys-for-the-workspace.md 、2026-11-14 確認）
- OpenSSH portable の `ssh-agent.c` の `handle_socket_read`（https://github.com/openssh/openssh-portable/blob/master/ssh-agent.c 、2026-11-14 確認）: つないできたプロセスの UID が agent と違えば、root を除き接続を断る
