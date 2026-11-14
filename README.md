# penelope

A coding agent with one long-lived session, a sandbox and a sentinel at its egress

penelope は、1 人のオーナーのために 1 本の長いセッションで動き続ける Coding Agent です。
[Pi Coding Agent](https://github.com/earendil-works/pi) を基本のツールごと sandbox の中で動かし、開発の道具を最初から持たせます。
sandbox から外へ出る通信は、返事も含めてすべて Sentinel を通ります。Sentinel は通信を記録し、選んだホストでは sandbox が持つ代わりの値を本物の鍵に差し替えます。
出来事（オーナーの発言、Slack、webhook、予約した時刻、ほかのエージェントからの頼み）は backend の 1 つの取り込み口に集まり、記憶は git の Markdown として育ちます。

設計の判断は [docs/adr/](docs/adr/README.md) にあります。
