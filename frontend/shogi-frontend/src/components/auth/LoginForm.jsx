import React, { useCallback, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import GoogleGsiButton from '@/components/auth/GoogleGsiButton';

const LoginForm = ({ onSwitchToRegister, onLoginSuccess, onGoogleNeedsProfile, embedded = false }) => {
  const [formData, setFormData] = useState({ username: '', password: '' });
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

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!formData.username.trim() || !formData.password.trim()) {
      setError('ユーザー名とパスワードを入力してください');
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
        setError(result?.message || 'ログインに失敗しました');
      }
    } catch (e2) {
      setError('ログインに失敗しました');
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
      setError('有効なメールアドレスを入力してください');
      return;
    }
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      const result = await requestPasswordReset(v);
      if (result?.success) {
        setSuccess(result?.message || 'パスワード再設定の案内を送信しました。メールをご確認ください。');
      } else {
        setError(result?.message || '送信に失敗しました');
      }
    } catch (_) {
      setError('送信に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmitResend = async (e) => {
    e.preventDefault();
    const v = (email || '').trim();
    if (!isEmail(v)) {
      setError('有効なメールアドレスを入力してください');
      return;
    }
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      const result = await resendVerification(v);
      if (result?.success) {
        setSuccess(result?.message || '確認メールを送信しました。メールをご確認ください。');
      } else {
        setError(result?.message || '送信に失敗しました');
      }
    } catch (_) {
      setError('送信に失敗しました');
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
      setError(result?.message || 'Googleログインに失敗しました');
    } catch (_) {
      setError('Googleログインに失敗しました');
    } finally {
      setLoading(false);
    }
  }, [loginWithGoogle, onLoginSuccess, onGoogleNeedsProfile]);

  return (
    <Card className="w-full max-w-md mx-auto shogi-auth account-form card-like p-4">
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl text-center">
          {mode === 'forgot' ? 'パスワード再設定' : mode === 'resend' ? '確認メール再送' : 'ログイン'}
        </CardTitle>
        <CardDescription className="text-center">
          {mode === 'forgot'
            ? '登録メールアドレスへ再設定リンクを送ります'
            : mode === 'resend'
              ? '登録メールアドレスへ確認メールを再送します'
              : 'アカウントにログインしてください'}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
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
                <Label htmlFor="username">ユーザー名またはメールアドレス</Label>
                <Input
                  id="username"
                  name="username"
                  type="text"
                  placeholder="ユーザー名 または you@example.com"
                  value={formData.username}
                  onChange={handleChange}
                  disabled={loading}
                  required
                  autoComplete="username"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">パスワード</Label>
                <div className="relative">
                  <Input
                    id="password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    placeholder="パスワードを入力"
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
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ログイン中...
                  </>
                ) : (
                  'ログイン'
                )}
              </Button>

              <div className="flex items-center justify-between text-sm">
                <Button
                  type="button"
                  variant="link"
                  className="px-0"
                  onClick={switchToForgot}
                  disabled={loading}
                >
                  パスワードを忘れた
                </Button>
                <Button
                  type="button"
                  variant="link"
                  className="px-0"
                  onClick={switchToResend}
                  disabled={loading}
                >
                  確認メール再送
                </Button>
              </div>

              {lastLoginCode === 'email_unverified' && (
                <Alert>
                  <AlertDescription>
                    メール認証が完了していません。<Button
                      type="button"
                      variant="link"
                      className="px-0"
                      onClick={switchToResend}
                      disabled={loading}
                    >
                      確認メールを再送
                    </Button>
                  </AlertDescription>
                </Alert>
              )}
            </form>

            {canUseGoogle && (
              <>
                <div className="flex items-center gap-2">
                  <div className="h-px flex-1 bg-border" />
                  <div className="text-xs text-muted-foreground">または</div>
                  <div className="h-px flex-1 bg-border" />
                </div>

                <div className="flex justify-center">
                  <GoogleGsiButton
                    clientId={clientId}
                    onCredential={handleGoogleCredential}
                    text="signin_with"
                    width={320}
                  />
                </div>
              </>
            )}

            <div className="text-center text-sm">
              アカウントをお持ちでないですか？{' '}
              <Button
                variant="link"
                className="px-0"
                onClick={onSwitchToRegister}
                disabled={loading}
              >
                新規登録
              </Button>
            </div>
          </>
        ) : (
          <form onSubmit={mode === 'forgot' ? handleSubmitForgot : handleSubmitResend} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">メールアドレス</Label>
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
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  送信中...
                </>
              ) : (
                '送信'
              )}
            </Button>

            <Button type="button" variant="ghost" className="w-full" onClick={switchToLogin} disabled={loading}>
              戻る
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
};

export default LoginForm;
