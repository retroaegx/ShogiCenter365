# src/assets（Git には入れない素材）

このフォルダは **`.gitignore` 対象**です。
クローン直後は中身が空（README だけ）になる想定なので、ビルド/起動に必要な素材は **別途用意して配置**してください。

## 使い道
- `@/assets/...` の形でフロント（Vite/React）から import される、軽量な SVG/画像置き場です。
- ファイル名を変える場合は、import 側も合わせて変更してください。

## 最低限必要になりやすいファイル
現状の実装で参照しているもの（不足すると build で落ちる/表示が崩れることがあります）:

- `react.svg`
- `icons/eye.svg`
- `icons/eye-slash.svg`
- `icons/chat_bubble.svg`
- `icons/left.svg`
- `icons/flag.svg`

## 配置ルール
- ここに置く素材は **小さめ**（UI 用）を想定しています。
- 画像が重い場合は、`public/` 側に置いて URL 参照に寄せたほうが扱いやすいです。
