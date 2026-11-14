# ペネロペのアバター

backend の設定で `PENELOPE_AVATAR=penelope` を選ぶと、Web UI の名前と表情のアイコンがこのアバターになる（[docs/backend.md](../../../docs/backend.md) の「設定」）。コードはどのアバターにも依存しない（[ADR-0001](../../../docs/adr/0001-one-pod-with-pi-inside-the-sandbox.md)）。

| ファイル | 中身 |
| --- | --- |
| `avatar.json` | ID・表示名と、表情ごとのアイコンの場所 |
| `icons/<表情>.webp` | 顔を切り出した 512×512 の WebP。neutral・happy・laughing・surprised・thinking・worried・sad・sleepy・angry の 9 種 |

## 出どころ

[yuanying/natsumi](https://github.com/yuanying/natsumi)（MIT）の `assets/avatars/penelope/` から、コミット `69ad229a1b7afd677a89f75c6e0c20e378078705` の `avatar.json` と `icons/*.webp` をそのまま写した。生成の手順と設定は、写し元の README にある。

Slack 用の PNG、生成元の PNG、`appearance.yaml`、`sdctl-params.yaml`、`personality.md` は写していない（性格は記憶の側で持つ）。
