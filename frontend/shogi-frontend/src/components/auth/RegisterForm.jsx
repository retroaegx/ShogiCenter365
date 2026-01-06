import React, { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, Eye, EyeOff, Check, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import GoogleGsiButton from '@/components/auth/GoogleGsiButton';
import { DEFAULT_INITIAL_RATING, buildRatingOptions, ratingToRank24 } from '@/utils/rating24';

const RegisterForm = ({ onSwitchToLogin, onRegisterSuccess, onGoogleNeedsProfile, onGoogleSuccess, embedded = false }) => {
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    password: '',
    confirmPassword: '',
    initialRating: String(DEFAULT_INITIAL_RATING)
  });
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const { register, loginWithGoogle } = useAuth();
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  const busy = loading || googleLoading;

  // パスワード強度チェック
  const getPasswordStrength = (password) => {
    const checks = {
      length: password.length >= 8,
      uppercase: /[A-Z]/.test(password),
      lowercase: /[a-z]/.test(password),
      number: /\d/.test(password)
    };
    
    const score = Object.values(checks).filter(Boolean).length;
    return { checks, score };
  };

  const passwordStrength = getPasswordStrength(formData.password);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
    // エラーをクリア
    if (error) setError('');
    if (success) setSuccess('');
  };

  const validateForm = () => {
    if (!formData.username.trim()) {
      setError('ユーザー名を入力してください');
      return false;
    }

    if (formData.username.length < 3) {
      setError('ユーザー名は3文字以上で入力してください');
      return false;
    }

    if (!/^[a-zA-Z0-9_]+$/.test(formData.username)) {
      setError('ユーザー名は英数字とアンダースコアのみ使用できます');
      return false;
    }

    if (!formData.email.trim()) {
      setError('メールアドレスを入力してください');
      return false;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      setError('有効なメールアドレスを入力してください');
      return false;
    }

    if (!formData.password) {
      setError('パスワードを入力してください');
      return false;
    }
    if (!(passwordStrength.checks.length && passwordStrength.checks.uppercase && passwordStrength.checks.lowercase && passwordStrength.checks.number)) {
      setError('パスワードは8文字以上で、大文字・小文字・数字を各1つ以上含めてください');
      return false;
    }

    if (formData.password !== formData.confirmPassword) {
      setError('パスワードが一致しません');
      return false;
    }

    return true;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!validateForm()) {
      return;
    }

    setLoading(true);
    setError('');
    setSuccess('');

    try {
      const result = await register(formData.username, formData.email, formData.password, Number(formData.initialRating));
      
      if (result.success) {
        const requireVerify = !!result.require_email_verification;
        const sent = result.verification_sent !== false; // undefined => treat as ok

        if (requireVerify && !sent) {
          setError(result.message || '確認メールの送信に失敗しました');
          return;
        }

        setSuccess(result.message || (requireVerify
          ? '確認メールを送信しました。メールのリンクを開いて認証してください。'
          : 'アカウントを作成しました。ログインしてください。'));

        setTimeout(() => {
          if (onRegisterSuccess) {
            onRegisterSuccess();
          } else {
            onSwitchToLogin();
          }
        }, 2000);
      } else {
        setError(result.message);
      }
    } catch (error) {
      console.error('Register error:', error);
      setError((error && (error.message || error.toString())) || 'アカウント作成に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleCredential = useCallback(async (cred) => {
    if (!cred) return;
    setGoogleLoading(true);
    setError('');
    setSuccess('');
    try {
      const result = await loginWithGoogle(cred);
      if (result?.success) {
        onGoogleSuccess && onGoogleSuccess();
        return;
      }
      if (result?.needs_profile) {
        onGoogleNeedsProfile && onGoogleNeedsProfile(result);
        return;
      }
      setError(result?.message || 'Google登録に失敗しました');
    } catch (_) {
      setError('Google登録に失敗しました');
    } finally {
      setGoogleLoading(false);
    }
  }, [loginWithGoogle, onGoogleNeedsProfile, onGoogleSuccess]);

  const PasswordStrengthIndicator = ({ checks, score }) => {
    const getStrengthColor = (score) => {
      if (score < 2) return 'bg-red-500';
      if (score < 4) return 'bg-yellow-500';
      return 'bg-green-500';
    };

    const getStrengthText = (score) => {
      if (score < 2) return '弱い';
      if (score < 4) return '普通';
      return '強い';
    };

    return (
      <div className="mt-2 space-y-2 shogi-auth account-form card-like p-4">
        <div className="flex items-center space-x-2">
          <div className="flex-1 bg-gray-200 rounded-full h-2">
            <div
              className={`h-2 rounded-full transition-all duration-300 ${getStrengthColor(score)}`}
              style={{ width: `${(score / 4) * 100}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground">
            {getStrengthText(score)}
          </span>
        </div>
        
        <div className="grid grid-cols-2 gap-1 text-xs">
          <div className={`flex items-center space-x-1 ${checks.length ? 'text-green-600' : 'text-gray-400'}`}>
            {checks.length ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
            <span>8文字以上</span>
          </div>
          <div className={`flex items-center space-x-1 ${checks.uppercase ? 'text-green-600' : 'text-gray-400'}`}>
            {checks.uppercase ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
            <span>大文字</span>
          </div>
          <div className={`flex items-center space-x-1 ${checks.lowercase ? 'text-green-600' : 'text-gray-400'}`}>
            {checks.lowercase ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
            <span>小文字</span>
          </div>
          <div className={`flex items-center space-x-1 ${checks.number ? 'text-green-600' : 'text-gray-400'}`}>
            {checks.number ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
            <span>数字</span>
          </div>
        </div>
      </div>
    );
  };

  const inner = (
    <>
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

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="username">ユーザー名</Label>
          <Input
            id="username"
            name="username"
            type="text"
            value={formData.username}
            onChange={handleChange}
            placeholder="ユーザー名（3文字以上）"
            disabled={busy}
            className="w-full shogi-input"
            autoComplete="username"
          />
          <p className="text-xs text-muted-foreground">英数字とアンダースコアのみ使用可能</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="email">メールアドレス</Label>
          <Input
            id="email"
            name="email"
            type="email"
            value={formData.email}
            onChange={handleChange}
            placeholder="メールアドレス"
            disabled={busy}
            className="w-full shogi-input"
            autoComplete="email"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="initialRating">初期レーティング</Label>
          <select
            id="initialRating"
            name="initialRating"
            value={formData.initialRating}
            onChange={handleChange}
            disabled={busy}
            className="w-full shogi-input h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {buildRatingOptions().map((v) => (
              <option key={v} value={v}>
                {v}（{ratingToRank24(v)}）
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">自己申告の初期値です。対局で増減します。</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="password">パスワード</Label>
          <div className="relative">
            <Input
              id="password"
              name="password"
              type={showPassword ? 'text' : 'password'}
              value={formData.password}
              onChange={handleChange}
              placeholder="パスワード"
              disabled={busy}
              className="w-full pr-10 shogi-input"
              autoComplete="new-password"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent shogi-btn"
              onClick={() => setShowPassword(!showPassword)}
              disabled={busy}
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
          </div>
          {formData.password && (
            <PasswordStrengthIndicator checks={passwordStrength.checks} score={passwordStrength.score} />
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="confirmPassword">パスワード確認</Label>
          <div className="relative">
            <Input
              id="confirmPassword"
              name="confirmPassword"
              type={showConfirmPassword ? 'text' : 'password'}
              value={formData.confirmPassword}
              onChange={handleChange}
              placeholder="パスワードを再入力"
              disabled={busy}
              className="w-full pr-10 shogi-input"
              autoComplete="new-password"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent shogi-btn"
              onClick={() => setShowConfirmPassword(!showConfirmPassword)}
              disabled={busy}
            >
              {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
          </div>
          {formData.confirmPassword && formData.password !== formData.confirmPassword && (
            <p className="text-xs text-red-600">パスワードが一致しません</p>
          )}
        </div>

        <Button type="submit" className="w-full shogi-btn" disabled={busy || success}>
          {loading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              作成中
            </>
          ) : (
            'アカウント作成'
          )}
        </Button>
      </form>

      <div className="mt-4 flex items-center gap-2">
        <div className="h-px flex-1 bg-border" />
        <div className="text-xs text-muted-foreground">または</div>
        <div className="h-px flex-1 bg-border" />
      </div>

      <div className="mt-4 flex justify-center">
        <GoogleGsiButton
          clientId={clientId}
          onCredential={handleGoogleCredential}
          text="signup_with"
          width={embedded ? 280 : 320}
        />
      </div>

      <div className="mt-6 text-center">
        <p className="text-sm text-muted-foreground">
          既にアカウントをお持ちの方は{' '}
          <Button
            variant="link"
            className="p-0 h-auto font-normal shogi-btn"
            onClick={onSwitchToLogin}
            disabled={busy}
          >
            ログイン
          </Button>
        </p>
      </div>
    </>
  );

  if (embedded) {
    return (
      <div className="w-full max-w-md mx-auto space-y-4">
        <div className="text-center">
          <div className="text-lg font-bold">新規登録</div>
          <div className="text-sm text-muted-foreground">アカウントを作成して将棋を始めよう</div>
        </div>
        {inner}
      </div>
    );
  }

  return (
    <Card className="w-full max-w-md mx-auto shogi-auth account-form card-like p-4">
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl font-bold text-center">新規登録</CardTitle>
        <CardDescription className="text-center">アカウントを作成して将棋を始めよう</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">{inner}</CardContent>
    </Card>
  );
};

export default RegisterForm;
