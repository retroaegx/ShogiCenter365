# public/country（旗 SVG。Git には入れない）

このフォルダは **`.gitignore` 対象**です。
クローン直後は README だけになる想定なので、旗 SVG は **別途用意して配置**してください。

## ルール
- ファイル名: **小文字の国コード** + `.svg`
  - 例: `jp.svg`, `us.svg`, `fr.svg`
- 参照パス: `/country/<code>.svg`

## 最低限必要になりやすいもの
### UI 言語選択（`src/utils/language.js`）
- `jp.svg`（ja）
- `us.svg`（en）
- `cn.svg`（zh）
- `fr.svg`（fr）
- `de.svg`（de）
- `pl.svg`（pl）
- `it.svg`（it）
- `pt.svg`（pt）

### ロビー/プロフィールの地域表示（`src/utils/legion.js`）
- `jp.svg` `us.svg` `gb.svg` `fr.svg` `de.svg` `es.svg` `it.svg`
- `cn.svg` `kr.svg` `tw.svg` `hk.svg` `sg.svg` `th.svg` `vn.svg`
- `id.svg` `ph.svg` `in.svg` `au.svg` `ca.svg` `br.svg` `mx.svg`
- `ru.svg` `tr.svg` `sa.svg` `ae.svg` `nl.svg` `se.svg` `no.svg` `fi.svg` `ua.svg`

## 増やしたい場合
- 追加したい地域コード（ISO 3166-1 alpha-2 を想定）に合わせて、`<code>.svg` を増やしてください。
- 表示名（翻訳）は `src/i18n` 側で管理します。
