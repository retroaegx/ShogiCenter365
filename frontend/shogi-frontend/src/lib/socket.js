// 方式A: Viteのプロキシを使わず、BE(:5000)へ直接WS接続する（JS版）
import { io } from "socket.io-client";
const BE_ORIGIN = (import.meta && import.meta.env && import.meta.env.VITE_BE_ORIGIN) || "http://192.168.0.13:5000";

let _accessToken = null;
try {
  _accessToken = localStorage.getItem("access_token") || sessionStorage.getItem("access_token");
} catch { _accessToken = null; }

function _authToken() {
  if (!_accessToken) return undefined;
  return _accessToken.startsWith("Bearer ") ? _accessToken : `Bearer ${_accessToken}`;
}

const socket = io(BE_ORIGIN, {
  path: "/socket.io",
  transports: ["websocket"],
  withCredentials: true,
  auth: (cb) => cb({ token: _authToken() }),
});

export function setAccessToken(token) {
  _accessToken = token;
  try {
    if (token) localStorage.setItem("access_token", token);
    else localStorage.removeItem("access_token");
  } catch {}

  socket.auth = { token: _authToken() };
  if (socket.connected) {
    try { socket.disconnect(); } catch {}
  }
  socket.connect();
}

socket.on("connect_error", (err) => console.warn("[ws] connect_error:", err && err.message || err));
socket.on("disconnect", (reason) => console.info("[ws] disconnected:", reason));

export { BE_ORIGIN };
export default socket;
