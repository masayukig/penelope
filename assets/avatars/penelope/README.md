# ペネロペのアバター

backend の設定で `PENELOPE_AVATAR=penelope` を選ぶと、最初の起動でこのディレクトリが記憶の `/memory/avatar/` に写り、Web UI の名前と表情のアイコンになる。写したあとはエージェントが記憶の中で育てる（[docs/backend.md](../../../docs/backend.md) の「アバター」）。`slackctl post --face` は Slack 用の PNG を投稿のアイコンにする（[docs/receivers.md](../../../docs/receivers.md) の「投稿の CLI」）。コードはどのアバターにも依存しない（[ADR-0001](../../../docs/adr/0001-one-pod-with-pi-inside-the-sandbox.md)）。

| ファイル | 中身 |
| --- | --- |
| `avatar.json` | ID・表示名と、表情ごとのアイコンと Slack 用の PNG の場所 |
| `icons/<表情>.webp` | 顔を切り出した 512×512 の WebP。Web UI が使う。neutral・happy・laughing・surprised・thinking・worried・sad・sleepy・angry の 9 種 |
| `slack/<表情>.png` | 同じ 9 種の 256×256 の PNG。Slack の投稿のアイコンに使う |
| `appearance.yaml` | 姿。自分の写った絵を描くときのプロンプトの元（skill `self-portrait`） |
| `sdctl-params.yaml` | 姿を描くときの `sdctl` の params の既定 |

## 出どころ

[yuanying/natsumi](https://github.com/yuanying/natsumi)（MIT）の `assets/avatars/penelope/` から、コミット `69ad229a1b7afd677a89f75c6e0c20e378078705` の `avatar.json` と `icons/*.webp` をそのまま写した。`slack/*.png` は、コミット `0187c41eafef444a89667ded34d4895f139a2a48` から同じくそのまま写し、その場所（`pngIcons`）を `avatar.json` に足した。生成の手順と設定は、写し元の README にある。

`appearance.yaml` と `sdctl-params.yaml` は、写し元のコミット `1052148854364aaa09f8a0b9847d70fb18dfa95a` のものをそのまま写した。

生成元の PNG、`personality.md` は写していない（性格は記憶の側で持つ）。
