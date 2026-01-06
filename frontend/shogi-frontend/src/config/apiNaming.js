// src/config/apiNaming.js
// サーバー側の項目名に“合わせる”ための定義。UIは変更しない。
const apiNaming = {
  joinByUser: {
    path: '/lobby/join-by-user',
    opponentField: 'opponent_user_id',   // サーバーが受ける相手IDのキー名
    minutesField: 'minutes',             // サーバーが受ける持ち時間のキー名（使うなら）
    // UIが現在使っている可能性のあるキー（見つかったら server 側のキー名にリネームする）
    clientOpponentKeys: ['opponent_user_id','opponentId','opponent_id','to_user_id','user_id','opponent','target_user_id'],
    clientMinutesKeys: ['minutes','time','time_control'],
  },
};

// もしページ側で window.__SHOGI_API_NAMING__ を置けばここで上書きできる（任意）
if (typeof window !== 'undefined' && window.__SHOGI_API_NAMING__) {
  try {
    const o = window.__SHOGI_API_NAMING__;
    if (o?.joinByUser) apiNaming.joinByUser = { ...apiNaming.joinByUser, ...o.joinByUser };
  } catch {}
}

export default apiNaming;
