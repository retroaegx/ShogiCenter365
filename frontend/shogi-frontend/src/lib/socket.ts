// 方式A: Viteのプロキシを使わず、BE(:5000)へ直接WS接続するモジュール
// 使用方法：
//   import socket, { setAccessToken, BE_ORIGIN } from "./lib/socket";
//   // ログイン後にトークンを保存してるなら setAccessToken(token) 呼ぶと即再接続するよ。
//   socket.on("connected", (p) => console.log("connected", p));
//   socket.emit("join_lobby");
import { io, Socket } from "socket.io-client";

// .env で VITE_BE_ORIGIN を定義できるようにしておくと便利だよ
// 例: VITE_BE_ORIGIN=http://192.168.0.13:5000
const BE_ORIGIN = import.meta.env.VITE_BE_ORIGIN || "http://192.168.0.13:5000";

let _accessToken: string | null = null;
try {
  // 既存実装に合わせてどっちかに入ってる想定
  _accessToken = localStorage.getItem("access_token") || sessionStorage.getItem("access_token");
} catch {
  _accessToken = null;
}

function _authToken(): string | undefined {
  if (!_accessToken) return undefined;
  return _accessToken.startsWith("Bearer ") ? _accessToken : `Bearer ${_accessToken}`;
}

// NOTE: ここで BE 直指定（プロキシ使わない）
const socket: Socket = io(BE_ORIGIN, {
  path: "/socket.io",
  transports: ["websocket"],     // WebSocket優先
  withCredentials: true,         // Cookie併用ならtrueのまま
  auth: (cb) => cb({ token: _authToken() }), // ★ JWTはauth経由で渡す（WSはヘッダ経由だと落ちやすい）
});

// アプリ側でログイン直後にトークンを更新できるようにフックを出す
export function setAccessToken(token: string | null) {
  _accessToken = token;
  try {
    if (token) {
      localStorage.setItem("access_token", token);
    } else {
      localStorage.removeItem("access_token");
    }
  } catch {}
  // authを差し替えて再接続
  // socket.io v4 は connect前に socket.auth を更新して connect() で反映される
  // 既に接続中なら一度切ってから繋ぎ直す
  // @ts-ignore
  socket.auth = { token: _authToken() };
  if (socket.connected) {
    try { socket.disconnect(); } catch {}
  }
  socket.connect();
}

// デバッグ用ロギング（必要なら消してOK）
socket.on("connect_error", (err) => {
  console.warn("[ws] connect_error:", err?.message || err);
});
socket.on("disconnect", (reason) => {
  console.info("[ws] disconnected:", reason);
});

export { BE_ORIGIN };
export default socket;
