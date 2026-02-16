ここに効果音/環境音ファイルを置きます。

参照パス（例）
  /sounds/login.m4a

デフォルトで参照しているファイル名は以下です（src/config/sounds.js）：

  login.m4a
  waiting_start.m4a
  offer_received.m4a
  game_start.m4a
  game_end.m4a
  room_enter.m4a
  room_exit.m4a
  piece_action.m4a

  time_up.wav
  countdown_10s.wav
  countdown_1s.wav

時間系（すべて効果音 / category: sfx）
  - time_up.wav        : 持ち時間が0になった瞬間
  - countdown_10s.wav   : 秒読み/猶予時間で残り1分未満になったら10秒ごと
  - countdown_1s.wav    : 残り9秒〜0秒で1秒ごと

※ m4a / mp3 は互換性が高めです。wav は容量が大きくなりがちです。
