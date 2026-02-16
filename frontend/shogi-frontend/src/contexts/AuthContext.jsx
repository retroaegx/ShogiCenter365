import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import api from '../services/apiClient';
import { ensurePreferredLanguage, getPreferredLanguage } from '../utils/language';
import { t } from '@/i18n';

const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }) => {
  // Ensure a language is chosen at least once (defaults to system language, otherwise English).
  useEffect(() => {
    try { ensurePreferredLanguage(); } catch { /* ignore */ }
  }, []);
  // APIのベースURL（絶対URL）
  // - 開発: Vite(5173) からBE(5000)を直接叩きたいケース用に :5000 をデフォルト
  // - 本番: 同一originで /api を提供する想定のため window.location.origin をデフォルト
  // - 上書きしたい場合: VITE_API_BASE_URL を指定
  const API_BASE_URL = (() => {
    try {
      const envBase = (typeof import.meta !== 'undefined' && import.meta.env)
        ? (import.meta.env.VITE_API_BASE_URL || '')
        : ''
      if (envBase) return String(envBase)

      if (typeof window === 'undefined') return 'http://localhost:5000'

      const { protocol, hostname, origin } = window.location
      if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEV) {
        return `${protocol}//${hostname}:5000`
      }
      return origin
    } catch {
      return 'http://localhost:5000'
    }
  })();

  // 起動時に localStorage から復元（どちらのキーでも拾う）
  const [token, setToken] = useState(() =>
    (typeof window !== 'undefined')
      ? (window.localStorage.getItem('access_token') || window.localStorage.getItem('token') || null)
      : null
  );
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // プロフィール取得（/api/user/profile）
  const fetchProfile = useCallback(async () => {
    const res = await api.get('/user/profile');
    const u = res?.data?.profile || res?.data?.user || res?.data;

    // Normalize to canonical shape used across app: user.user_id (string)
    if (u) {
      if (u.user_id == null && u.id != null) u.user_id = u.id;
      if (u.user_id != null) u.user_id = String(u.user_id);
    }

    setUser(u || null);
    return u;
  }, []);

  const persistTokenAndLoadProfile = useCallback(async (t) => {
    if (!t) return null;

    setToken(t);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('access_token', t);
      window.localStorage.setItem('token', t);
    }

    // Presence/keepalive (best-effort)
    try { await api.post('/lobby/touch?force=1'); } catch (e) { /* ignore */ }

    return await fetchProfile();
  }, [fetchProfile]);

  // 新規登録
  const register = useCallback(async (username, email, password, rating, legion) => {
    const payload = { username, email, password };
    payload.language = getPreferredLanguage();
    if (rating != null && Number.isFinite(Number(rating))) payload.rating = Number(rating);
    if (legion) payload.legion = String(legion);
    const res = await api.post('/auth/register', payload);
    return res?.data;
  }, []);

  // ログイン
  const login = useCallback(async (identifier, password) => {
    try {
      const res = await api.post('/auth/login', { username: identifier, password, language: getPreferredLanguage() });
      const token = res?.data?.access_token;
      if (res?.data?.login_warning) {
        try { window.sessionStorage.setItem('login_warning', String(res.data.login_warning)) } catch (e) {}
      }
      if (token) await persistTokenAndLoadProfile(token);
      return res?.data;
    } catch (e) {
      // Allow the UI to display server-provided message (e.g. email_unverified)
      const data = e?.response?.data;
      if (data) return data;
      return { success: false, message: (e && (e.message || e.toString())) || t('ui.contexts.authcontext.k2b0acc0f') };
    }
  }, [persistTokenAndLoadProfile]);

  // メール認証の再送
  const resendVerification = useCallback(async (email) => {
    const res = await api.post('/auth/resend-verification', { email });
    return res?.data;
  }, []);

  // パスワードリセット（案内メールの送信）
  const requestPasswordReset = useCallback(async (email) => {
    const res = await api.post('/auth/request-password-reset', { email });
    return res?.data;
  }, []);

  // パスワードリセット（トークンで更新）
  const resetPassword = useCallback(async (token, newPassword) => {
    const res = await api.post('/auth/reset-password', { token, new_password: newPassword });
    return res?.data;
  }, []);

  // ゲストログイン（24時間で自動削除される temporary account）
  const loginAsGuest = useCallback(async (rating, legion) => {
    const payload = {}
    payload.language = getPreferredLanguage()
    if (rating != null && Number.isFinite(Number(rating))) payload.rating = Number(rating)
    if (legion) payload.legion = String(legion)
    const res = await api.post('/auth/guest', payload)
    const t = res?.data?.access_token
    if (res?.data?.login_warning) {
      try { window.sessionStorage.setItem('login_warning', String(res.data.login_warning)) } catch (e) {}
    }
    if (t) await persistTokenAndLoadProfile(t)
    return res?.data
  }, [persistTokenAndLoadProfile])

  // Googleログイン（Sign in with Google ID token）
  const loginWithGoogle = useCallback(async (idToken) => {
    const res = await api.post('/auth/google', { id_token: idToken, language: getPreferredLanguage() });
    const t = res?.data?.access_token;
    if (res?.data?.login_warning) {
      try { window.sessionStorage.setItem('login_warning', String(res.data.login_warning)) } catch (e) {}
    }
    if (t) await persistTokenAndLoadProfile(t);
    return res?.data;
  }, [persistTokenAndLoadProfile]);

  // Google新規登録完了（表示名・レーティング入力後）
  const completeGoogleSignup = useCallback(async (signupToken, username, rating, legion) => {
    const payload = { signup_token: signupToken, username, rating, language: getPreferredLanguage() }
    if (legion) payload.legion = String(legion)
    const res = await api.post('/auth/google/complete', payload);
    const t = res?.data?.access_token;
    if (res?.data?.login_warning) {
      try { window.sessionStorage.setItem('login_warning', String(res.data.login_warning)) } catch (e) {}
    }
    if (t) await persistTokenAndLoadProfile(t);
    return res?.data;
  }, [persistTokenAndLoadProfile]);

  // ログアウト
  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem('access_token');
      window.localStorage.removeItem('token');
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        if (token) await fetchProfile();
      } catch (_) {
        logout();
      } finally {
        setLoading(false);
      }
    })();
  }, [token, fetchProfile, logout]);

  const isAuthenticated = Boolean(token);

  // 401などで有効期限切れを検知したら、確実にログアウトさせる（フォールバックなし）
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.__onAuthExpired = () => {
        try { logout(); } catch {}
      };
    }
    return () => {
      if (typeof window !== 'undefined') delete window.__onAuthExpired;
    };
  }, [logout]);

  const value = {
    API_BASE_URL,
    token,
    user,
    isAuthenticated,
    loading,
    register,
    login,
    loginAsGuest,
    logout,
    fetchProfile,
    loginWithGoogle,
    completeGoogleSignup,
    resendVerification,
    requestPasswordReset,
    resetPassword,
    setToken,
    setUser,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export default AuthContext;
