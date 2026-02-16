import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import GoogleGsiButton from '@/components/auth/GoogleGsiButton';
import { t } from '@/i18n';
import { authErrorMessage } from '@/i18n/authErrors';

const LoginForm = ({ onSwitchToRegister, onLoginSuccess, onGoogleNeedsProfile, embedded = false, containerClassName = '' }) => {
  // Keep UX consistent across entry points (Top / Invite, etc.)
  // - identifier: remember last entered (username/email)
  // - password: rely on browser password manager (we never store it)
  const LS_LAST_IDENTIFIER = 'shogi_last_login_identifier';
  const [formData, setFormData] = useState(() => {
    let remembered = '';
    try {
      if (typeof window !== 'undefined') {
        remembered = (window.localStorage.getItem(LS_LAST_IDENTIFIER) || '').trim();
      }
    } catch {
      remembered = '';
    }
    return { username: remembered, password: '' };
  });
  const [mode, setMode] = useState('login'); // login | forgot | resend
  const [email, setEmail] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [lastLoginCode, setLastLoginCode] = useState('');

  const { login, loginWithGoogle, resendVerification, requestPasswordReset } = useAuth();
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;

  const isEmail = useCallback((s) => {
    const v = String(s || '').trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  }, []);

  const canUseGoogle = useMemo(() => !!clientId, [clientId]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    if (error) setError('');
    if (success) setSuccess('');
    if (lastLoginCode) setLastLoginCode('');
  };

  useEffect(() => {
    // Persist last identifier for auto-fill (best-effort)
    try {
      if (typeof window !== 'undefined') {
        const v = (formData.username || '').trim();
        if (v) window.localStorage.setItem(LS_LAST_IDENTIFIER, v);
      }
    } catch {
      // ignore
    }
  }, [formData.username]);

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!formData.username.trim() || !formData.password.trim()) {
      setError(t("ui.components.auth.loginform.kdb09d6c7"));
      return;
    }

    setLoading(true);
    setError('');
    setSuccess('');
    setLastLoginCode('');
    try {
      const result = await login(formData.username, formData.password);
      if (result?.success) {
        onLoginSuccess && onLoginSuccess();
      } else {
        const code = result?.code || '';
        setLastLoginCode(code);
        setError(authErrorMessage(result?.error_code || result?.code, result?.message) || t("ui.components.auth.loginform.k2b0acc0f"));
      }
    } catch (e2) {
      setError(t("ui.components.auth.loginform.k2b0acc0f"));
    } finally {
      setLoading(false);
    }
  };

  const switchToForgot = () => {
    setMode('forgot');
    const id = (formData.username || '').trim();
    if (isEmail(id)) setEmail(id);
    setError('');
    setSuccess('');
    setLastLoginCode('');
  };

  const switchToResend = () => {
    setMode('resend');
    const id = (formData.username || '').trim();
    if (isEmail(id)) setEmail(id);
    setError('');
    setSuccess('');
    setLastLoginCode('');
  };

  const switchToLogin = () => {
    setMode('login');
    setError('');
    setSuccess('');
    setLastLoginCode('');
  };

  const handleSubmitForgot = async (e) => {
    e.preventDefault();
    const v = (email || '').trim();
    if (!isEmail(v)) {
      setError(t("ui.components.auth.loginform.k83cbe1ca"));
      return;
    }
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      const result = await requestPasswordReset(v);
      if (result?.success) {
        setSuccess(t("ui.components.auth.loginform.kf75a1c74"));
      } else {
        setError(authErrorMessage(result?.error_code || result?.code, result?.message) || t("ui.components.auth.loginform.k03786b0c"));
      }
    } catch (_) {
      setError(t("ui.components.auth.loginform.k03786b0c"));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmitResend = async (e) => {
    e.preventDefault();
    const v = (email || '').trim();
    if (!isEmail(v)) {
      setError(t("ui.components.auth.loginform.k83cbe1ca"));
      return;
    }
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      const result = await resendVerification(v);
      if (result?.success) {
        setSuccess(t("ui.components.auth.loginform.k3ecf50cd"));
      } else {
        setError(authErrorMessage(result?.error_code || result?.code, result?.message) || t("ui.components.auth.loginform.k03786b0c"));
      }
    } catch (_) {
      setError(t("ui.components.auth.loginform.k03786b0c"));
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleCredential = useCallback(async (cred) => {
    setLoading(true);
    setError('');
    try {
      const result = await loginWithGoogle(cred);
      if (result?.success) {
        onLoginSuccess && onLoginSuccess();
        return;
      }
      if (result?.needs_profile) {
        onGoogleNeedsProfile && onGoogleNeedsProfile(result);
        return;
      }
      setError(authErrorMessage(result?.error_code || result?.code, result?.message) || t("ui.components.auth.loginform.k5de850f2"));
    } catch (_) {
      setError(t("ui.components.auth.loginform.k5de850f2"));
    } finally {
      setLoading(false);
    }
  }, [loginWithGoogle, onLoginSuccess, onGoogleNeedsProfile]);

  const header = (
    <>
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl text-center">
          {mode === 'forgot' ? t("ui.components.auth.loginform.kffaa3e6f") : mode === 'resend' ? t("ui.components.auth.loginform.kfd240a51") : t("ui.components.auth.loginform.k417181d1")}
        </CardTitle>
        <CardDescription className="text-center">
          {mode === 'forgot'
            ? t("ui.components.auth.loginform.k3da057b2") : mode === 'resend' ? t("ui.components.auth.loginform.kbb47027e") : t("ui.components.auth.loginform.k699e7b24")}
        </CardDescription>
      </CardHeader>
    </>
  );

  const content = (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {success && (
        <Alert className="border-green-200 bg-green-50">
          <AlertDescription className="text-green-800">{success}</AlertDescription>
        </Alert>
      )}

      {mode === 'login' ? (
        <>
          <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="username">{t("ui.components.auth.loginform.k09d076c2")}</Label>
                <Input
                  id="username"
                  name="username"
                  type="text"
                  placeholder={t("ui.components.auth.loginform.kf19cbd19")}
                  value={formData.username}
                  onChange={handleChange}
                  disabled={loading}
                  required
                  autoComplete="username"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">{t("ui.components.auth.loginform.ka9694dc2")}</Label>
                <div className="relative">
                  <Input
                    id="password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    placeholder={t("ui.components.auth.loginform.k6084b771")}
                    value={formData.password}
                    onChange={handleChange}
                    disabled={loading}
                    required
                    autoComplete="current-password"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                    onClick={() => setShowPassword(!showPassword)}
                    disabled={loading}
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>

              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />{
                    t("ui.components.auth.loginform.k213d1113")}</>
                ) : (
                  t("ui.components.auth.loginform.k417181d1")
                )}
              </Button>

              {/*
                i18n/mobile: link labels can get long (e.g. FR). The default Button style uses
                whitespace-nowrap, so a single-row flex can force the panel width to grow and
                then get clipped by the rounded container (overflow-hidden).
                On small screens we stack links; from sm+ we keep a single row.
              */}
              <div className="flex flex-col gap-2 text-sm sm:flex-row sm:items-center sm:justify-between">
                <Button
                  type="button"
                  variant="link"
                  className="px-0 h-auto py-0 whitespace-normal text-left"
                  onClick={switchToForgot}
                  disabled={loading}
                >{
                  t("ui.components.auth.loginform.ke9b6f0d8")}</Button>
                <Button
                  type="button"
                  variant="link"
                  className="px-0 h-auto py-0 whitespace-normal text-left sm:text-right"
                  onClick={switchToResend}
                  disabled={loading}
                >{
                  t("ui.components.auth.loginform.kfd240a51")}</Button>
              </div>

              {lastLoginCode === 'email_unverified' && (
                <Alert>
                  <AlertDescription>{
                    t("ui.components.auth.loginform.k9e45ffb9")}<Button
                      type="button"
                      variant="link"
                      className="px-0 h-auto py-0 whitespace-normal align-baseline"
                      onClick={switchToResend}
                      disabled={loading}
                    >{
                      t("ui.components.auth.loginform.kad653ca0")}</Button>
                  </AlertDescription>
                </Alert>
              )}
            </form>

          {canUseGoogle && (
            <>
              <div className="flex items-center gap-2">
                <div className="h-px flex-1 bg-border" />
                <div className="text-xs text-muted-foreground">{t("ui.components.auth.loginform.k6564bfb0")}</div>
                <div className="h-px flex-1 bg-border" />
              </div>

              <div className="flex justify-center">
                <GoogleGsiButton
                  clientId={clientId}
                  onCredential={handleGoogleCredential}
                  text="signin_with"
                  width={embedded ? 280 : 320}
                />
              </div>
            </>
          )}

            {typeof onSwitchToRegister === 'function' && (
              <div className="text-center text-sm">
                {t("ui.components.auth.loginform.k83a083af")}{' '}
                <Button
                  variant="link"
                  className="px-0"
                  onClick={onSwitchToRegister}
                  disabled={loading}
                >{
                  t("ui.components.auth.loginform.k97012002")}</Button>
              </div>
            )}
        </>
      ) : (
        <form onSubmit={mode === 'forgot' ? handleSubmitForgot : handleSubmitResend} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">{t("ui.components.auth.loginform.k893793b5")}</Label>
              <Input
                id="email"
                name="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (error) setError('');
                  if (success) setSuccess('');
                }}
                disabled={loading}
                required
                autoComplete="email"
              />
            </div>

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />{
                  t("ui.components.auth.loginform.kf71157ab")}</>
              ) : (
                t("ui.components.auth.loginform.k58aa7961")
              )}
            </Button>

            <Button type="button" variant="ghost" className="w-full" onClick={switchToLogin} disabled={loading}>{
              t("ui.components.auth.loginform.k60a1005b")}</Button>
        </form>
      )}
    </div>
  );

  if (embedded) {
    // Embedded mode: parent controls the surrounding card/tabs.
    // Keep the layout width flexible (no max-w, no mx-auto).
    return <div className={'w-full ' + (containerClassName || '')}>{content}</div>;
  }

  return (
    <Card className={'w-full max-w-md mx-auto shogi-auth account-form card-like p-4 ' + (containerClassName || '')}>
      {header}
      <CardContent>{content}</CardContent>
    </Card>
  );
};

export default LoginForm;
