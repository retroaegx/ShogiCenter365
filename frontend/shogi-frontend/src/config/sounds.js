// src/config/sounds.js
// サウンド定義（config）
// - 音源は public/sounds/ 配下に置く想定（例: public/sounds/login.m4a）
// - 互換のため、2種類の形式を export します
//    - SOUND_DEFS  : { category: 'env'|'sfx', url: string }
//    - SOUND_CONFIG: { type: 'env'|'sfx', src: string }

export const SOUND_KEYS = {
  LOGIN: 'login',
  WAITING_START: 'waiting_start',
  OFFER_RECEIVED: 'offer_received',
  GAME_START: 'game_start',
  GAME_END: 'game_end',

  ROOM_ENTER: 'room_enter',
  ROOM_EXIT: 'room_exit',
  // 旧名互換（以前のパッチで room_leave を使っていた場合）
  ROOM_LEAVE: 'room_leave',

  PIECE_ACTION: 'piece_action',

  // 時間関連（効果音）
  TIME_UP: 'time_up',
  COUNTDOWN_10S: 'countdown_10s',
  COUNTDOWN_1S: 'countdown_1s',
};

// ここを差し替えるだけで音源を変更できます
const BASE = {
  // 環境音
  [SOUND_KEYS.LOGIN]:         { category: 'env', url: '/sounds/login.m4a' },
  [SOUND_KEYS.WAITING_START]: { category: 'env', url: '/sounds/waiting_start.m4a' },
  [SOUND_KEYS.OFFER_RECEIVED]:{ category: 'env', url: '/sounds/offer_received.m4a' },
  [SOUND_KEYS.GAME_START]:    { category: 'env', url: '/sounds/game_start.m4a' },
  [SOUND_KEYS.GAME_END]:      { category: 'env', url: '/sounds/game_end.m4a' },

  // 効果音
  [SOUND_KEYS.ROOM_ENTER]:    { category: 'sfx', url: '/sounds/room_enter.m4a' },
  [SOUND_KEYS.ROOM_EXIT]:     { category: 'sfx', url: '/sounds/room_exit.m4a' },
  [SOUND_KEYS.PIECE_ACTION]:  { category: 'sfx', url: '/sounds/piece_action.m4a' },

  // 時間関連（効果音）
  [SOUND_KEYS.TIME_UP]:       { category: 'sfx', url: '/sounds/time_up.wav' },
  [SOUND_KEYS.COUNTDOWN_10S]: { category: 'sfx', url: '/sounds/countdown_10s.wav' },
  [SOUND_KEYS.COUNTDOWN_1S]:  { category: 'sfx', url: '/sounds/countdown_1s.wav' },
};

// 旧名互換: room_leave -> room_exit と同じ音にする
BASE[SOUND_KEYS.ROOM_LEAVE] = BASE[SOUND_KEYS.ROOM_EXIT];

// v3 SoundManager (src/services/soundManager.js) が参照する形式
export const SOUND_DEFS = BASE;

// v1 SoundManager (src/sound/SoundManager.js) が参照する形式（互換）
export const SOUND_CONFIG = Object.fromEntries(
  Object.entries(BASE).map(([k, v]) => {
    return [k, { type: v.category, src: v.url }];
  })
);

export default SOUND_DEFS;
