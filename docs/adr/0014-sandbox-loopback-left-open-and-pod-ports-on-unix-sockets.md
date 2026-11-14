# 0014. sandbox の loopback は sandbox に任せ、Pod の中の口は Unix socket だけで待ち受ける

- Date: 2026-11-14
- Status: Accepted

## Context

ADR-0003 は、sandbox の UID から同じ Pod の loopback へ直に届く道を塞ぐと決めた。backend の sandbox 向けの口へ、Sentinel を通らずに届かないようにするためである。

Pod の中のコンテナは、IP アドレスとポートを含む網の名前空間を共有し、互いに localhost で届く。そのため、backend や Sentinel が TCP で待ち受ける口は、sandbox からも loopback で届く。ADR-0003 は、これを loopback ごと塞いで防いでいた。

ところが sandbox は、なんでもできる開発の場所である（ADR-0011）。エージェントは、自分で立てた開発用のサーバー、テストの中で立てる HTTP のサーバー、手元のデータベースなどに localhost で話す。loopback を塞ぐと、これらがすべて使えない。

一方、ADR-0002 は、取り込み口を Unix socket にし、socket を置く volume を mount するコンテナだけが送れるようにしている。待ち受けを Unix socket にすれば、届く相手は volume の mount で決まり、網の規則には頼らない。

## Decision

本 ADR は、ADR-0003 の Decision「私用のアドレスも素通し、loopback とリンクローカルは止める」のうち、loopback を止める点を置き換える。ほかの点（私用のアドレスも既定の扱いに従うこと、止めた通信も記録に残すこと）は変えない。

### sandbox の loopback は止めない

- sandbox の UID から loopback への通信は、向け直しも止めもしない。sandbox の中で自由に使える。
- loopback の通信は Sentinel を通らないので、Sentinel の記録には残らない。

### Pod の中の口は Unix socket だけで待ち受ける

- Pod の中のコンテナどうしのための口（backend の取り込み口と sandbox 向けの口、Sentinel の管理口）は、TCP で待ち受けず、Unix socket だけで待ち受ける。socket は、その口を使うコンテナだけが mount する volume に置く。sandbox には mount しない。
- Sentinel は、backend の sandbox 向けの口へ、登録の上流として Unix socket でつなぐ。sandbox から backend への道は、これまでどおり Sentinel を通る（ADR-0002）。
- 例外は 2 つである。
  - Sentinel の向け直しの受け口。sandbox の外向きが向け直される先であり、sandbox から届くこと自体が外向きの道である。直に届いた通信（向け直される前の宛先が受け口そのもの）は、Sentinel が断る。
  - Pod の外から呼ばれる口（backend の UI 向けの API と A2A の受け口、receivers の webhook の受け口）。Pod の外から届くのと同じ確かめ（ログインのセッション、ServiceAccount の token、webhook の署名）を通す。sandbox からも loopback で届くが、外から届くのと同じ扱いである。

### リンクローカルは Sentinel が断って記録する

- リンクローカル（IPv4 の 169.254.0.0/16、IPv6 の fe80::/10）への通信は、ほかの外向きと同じく Sentinel へ向け直し、Sentinel が断って記録に残す。

### 守る対象と、失敗したときの倒し方

- 守る対象は、sandbox が Pod の中の口（取り込み口・sandbox 向けの口・管理口）へ、Sentinel を通らずに届かないことである。
- この口を TCP で待ち受ける設定は持たない。待ち受けの socket を作れないときは、そのコンテナは起動しない。

### 本 ADR で決定しないこと

- socket の置き場所と volume の分け方（委譲先: [Pod の形の仕様書](../pod.md)）
- 上流を Unix socket で指す欄の形（委譲先: [Sentinel の設定と記録の仕様書](../sentinel-config.md)）
- Pod の外から呼ばれる口の待ち受けのポート（委譲先: 各部品の実装の作業単位と配置のリポジトリ）

## Consequences

- sandbox の中で、開発用のサーバーやテストのサーバーに localhost で話せる。
- Pod の中の口に届く相手が、網の規則ではなく volume の mount で決まる。規則の書き漏れで口が開くことがない。
- 一方で、loopback の通信は記録に残らない。sandbox の中で閉じた通信は見えないことを受け入れる。
- Pod の外から呼ばれる口には、sandbox からも Sentinel を通らずに届く。外から届くのと同じ確かめを通すので、守りは変わらないが、その試みは Sentinel の記録に残らない。
- 部品を実装するときに、Pod の中の口を TCP で待ち受けないという制約が 1 つ増える。Sentinel は backend の socket を mount することになる。

## Alternatives Considered

- **loopback を塞いだままにする**: Pod の中の口は守れるが、sandbox で開発用のサーバーに話せない。
- **loopback は開け、Pod の中の口のポートだけを iptables で塞ぐ**: 口を足すたびに規則を直すことになり、書き漏れると口が開く。
- **sandbox を別の Pod にして網の名前空間を分ける**: loopback の問題は消えるが、ADR-0001 の 1 つの Pod の形が崩れ、取り込み口や `/memory` の共有の形が変わる。

## Related ADRs

- Supersedes（一部）: ADR-0003 sandbox の外向きはすべて Sentinel を通し、既定は素通しで記録する（Decision「私用のアドレスも素通し、loopback とリンクローカルは止める」の loopback を止める点）
- Related: ADR-0001 1 つの Pod に backend・Sentinel・sandbox・receivers を置き、Pi ごと sandbox の中で動かす
- Related: ADR-0002 出来事は取り込み口 1 つの待ち行列に入れ、sandbox の runner が取りにいく
- Related: ADR-0005 承認待ちは Sentinel が持ち、オーナーは Web UI で答える
- Related: ADR-0010 人は GitHub OAuth で、A2A の送り手は ServiceAccount の token で確かめる
- Related: ADR-0011 sandbox の image は開発の一式を持ち、汎用のユーザーの HOME で作業する

## References

- Kubernetes の文書「Pods」の「Pod networking」（https://kubernetes.io/docs/concepts/workloads/pods/ 、2026-11-14 確認）: Pod の中のコンテナは IP アドレスとポートを含む網の名前空間を共有し、localhost で互いに届く
