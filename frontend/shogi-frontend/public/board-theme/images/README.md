# public/board-theme/images（盤面/駒画像。Git には入れない）

このフォルダは **`.gitignore` 対象**です。
クローン直後は README だけになる想定なので、盤面/駒の画像は **別途用意して配置**してください。

## 参照元
- `frontend/shogi-frontend/public/board-theme/config.json` が、画像の URL を持っています。
- **`config.json` に書いてあるパスと、実ファイルを一致**させてください。

## 必須になりやすい構成（例）
`config.json` が `/board-theme/images/boards/...` と `/board-theme/images/pieces/...` を参照している場合:

- `boards/`（盤面背景）
  - 例: `boards/board_background_normal.png` など
- `pieces/`（駒セット）
  - 例: `pieces/normal/king.png` など

※ どのファイルが必要かは、最終的に `config.json` の参照一覧が正です。

## 素材をまとめて入れる方法
リポジトリに素材 ZIP が用意されている場合は、それを `public/` に展開します。

```bash
cd frontend/shogi-frontend
unzip -o public/distribute/board-theme.zip -d public
```

- ZIP に `board-theme/config.json` が入っている場合、展開で **`public/board-theme/config.json` も上書き**されます。
  - 「ZIP の `config.json` と画像」をセットで使うなら、そのままで OK です。
  - 既存の `config.json` を使い続けたい場合は、展開後に `config.json` を戻すか、ZIP の中身を調整してください。
