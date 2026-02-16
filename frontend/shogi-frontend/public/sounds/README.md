# public/sounds（効果音/環境音。Git には入れない）

このフォルダの **音声ファイル（`.m4a` / `.wav`）は `.gitignore` 対象**です。
クローン直後は README だけになる想定なので、必要な音源は **別途用意して配置**してください。

## 参照パス
- フロントは `/sounds/<filename>` を参照します。
- 定義は `frontend/shogi-frontend/src/config/sounds.js` です。

## デフォルトで参照しているファイル名
### 環境音（m4a）
- `login.m4a`
- `waiting_start.m4a`
- `offer_received.m4a`
- `game_start.m4a`
- `game_end.m4a`

### 効果音（m4a）
- `room_enter.m4a`
- `room_exit.m4a`
- `piece_action.m4a`

### 時間関連（wav）
- `time_up.wav`（持ち時間が 0 になった瞬間）
- `countdown_10s.wav`（秒読み/猶予時間で残り 1 分未満になったら 10 秒ごと）
- `countdown_1s.wav`（残り 9 秒〜 0 秒で 1 秒ごと）

## 音源を差し替えたい場合
- ファイル名を合わせる（上の名前で置く）か、`src/config/sounds.js` の `url` を変更してください。
- `.m4a` / `.wav` 以外（例: `.mp3`）を使う場合も、`url` を変更すれば動きます。
