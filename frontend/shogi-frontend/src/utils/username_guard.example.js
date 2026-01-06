// 例: 認証ユーザーの表示で username 未定義に強い書き方
const user = auth?.user || {};
const username = user.username ?? user.name ?? user.displayName ?? 'ゲスト';
