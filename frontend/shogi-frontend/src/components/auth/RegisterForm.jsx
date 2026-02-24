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
import { detectLegionCode } from '@/utils/legion';
import LegionPicker from '@/components/auth/LegionPicker';
import { t } from '@/i18n';
import { authErrorMessage } from '@/i18n/authErrors';

const RegisterForm = ({
  onSwitchToLogin,
  onRegisterSuccess,
  onGoogleNeedsProfile,
  onGoogleSuccess,
  embedded = false,
  containerClassName = ''
}) => {
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    password: '',
    confirmPassword: '',
    initialRating: String(DEFAULT_INITIAL_RATING),
    legion: detectLegionCode()
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
      setError(t("ui.components.auth.registerform.kd4cad7b6"));
      return false;
    }

    if (formData.username.length < 3) {
      setError(t("ui.components.auth.registerform.kcc33d636"));
      return false;
    }

    if (!/^[a-zA-Z0-9_]+$/.test(formData.username)) {
      setError(t("ui.components.auth.registerform.k9ef182e1"));
      return false;
    }

    if (!formData.email.trim()) {
      setError(t("ui.components.auth.registerform.k5800bbcb"));
      return false;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      setError(t("ui.components.auth.registerform.k83cbe1ca"));
      return false;
    }

    if (!formData.password) {
      setError(t("ui.components.auth.registerform.k59e3d4cc"));
      return false;
    }
    if (!(passwordStrength.checks.length && passwordStrength.checks.uppercase && passwordStrength.checks.lowercase && passwordStrength.checks.number)) {
      setError(t("ui.components.auth.registerform.k8c3cfd81"));
      return false;
    }

    if (formData.password !== formData.confirmPassword) {
      setError(t("ui.components.auth.registerform.k2b6e54f6"));
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
      const result = await register(
        formData.username,
        formData.email,
        formData.password,
        Number(formData.initialRating),
        formData.legion
      );
      
      if (result.success) {
        const requireVerify = !!result.require_email_verification;
        const sent = result.verification_sent !== false; // undefined => treat as ok

        if (requireVerify && !sent) {
          setError(authErrorMessage(result?.error_code || result?.code, result?.message) || t("ui.components.auth.registerform.k9b998ec0"));
          return;
        }

        setSuccess(requireVerify
          ? t("ui.components.auth.registerform.kc3d706ad")
          : t("ui.components.auth.registerform.k06a57c3b"));

        setTimeout(() => {
          if (onRegisterSuccess) {
            onRegisterSuccess();
          } else {
            onSwitchToLogin();
          }
        }, 2000);
      } else {
        setError(authErrorMessage(result?.error_code || result?.code, result?.message) || t("ui.components.auth.registerform.k7662e475"));
      }
    } catch (error) {
      console.error('Register error:', error);
      const data = error?.response?.data;
      const code = data?.error_code || data?.code || error?.error_code;
      const fallback = data?.message || data?.error || error?.message || String(error);
      setError(authErrorMessage(code, fallback) || t("ui.components.auth.registerform.k7662e475"));
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
      setError(authErrorMessage(result?.error_code || result?.code, result?.message) || t("ui.components.auth.registerform.kf0922003"));
    } catch (_) {
      setError(t("ui.components.auth.registerform.kf0922003"));
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
      if (score < 2) return t("ui.components.auth.registerform.k6cd83d6d");
      if (score < 4) return t("ui.components.auth.registerform.k7cda072d");
      return t("ui.components.auth.registerform.kca169f1b");
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
            <span>{t("ui.components.auth.registerform.k4fec3335")}</span>
          </div>
          <div className={`flex items-center space-x-1 ${checks.uppercase ? 'text-green-600' : 'text-gray-400'}`}>
            {checks.uppercase ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
            <span>{t("ui.components.auth.registerform.k114f11cd")}</span>
          </div>
          <div className={`flex items-center space-x-1 ${checks.lowercase ? 'text-green-600' : 'text-gray-400'}`}>
            {checks.lowercase ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
            <span>{t("ui.components.auth.registerform.k185abce8")}</span>
          </div>
          <div className={`flex items-center space-x-1 ${checks.number ? 'text-green-600' : 'text-gray-400'}`}>
            {checks.number ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
            <span>{t("ui.components.auth.registerform.k7a4dc825")}</span>
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
          <Label htmlFor="username">{t("ui.components.auth.registerform.k7d25d9bc")}</Label>
          <Input
            id="username"
            name="username"
            type="text"
            value={formData.username}
            onChange={handleChange}
            placeholder={t("ui.components.auth.registerform.k25897d9d")}
            disabled={busy}
            className="w-full shogi-input"
            autoComplete="username"
          />
          <p className="text-xs text-muted-foreground">{t("ui.components.auth.registerform.k8f7cbf7e")}</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="email">{t("ui.components.auth.registerform.k893793b5")}</Label>
          <Input
            id="email"
            name="email"
            type="email"
            value={formData.email}
            onChange={handleChange}
            placeholder={t("ui.components.auth.registerform.k893793b5")}
            disabled={busy}
            className="w-full shogi-input"
            autoComplete="email"
          />
          <p className="text-xs text-muted-foreground">{t("ui.components.auth.registerform.mail_allow_notice")}</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="legion">{t("ui.components.auth.registerform.k9ba0c030")}</Label>
          <LegionPicker
            id="legion"
            value={formData.legion}
            onChange={(code) => setFormData((prev) => ({ ...prev, legion: code }))}
            disabled={busy}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="initialRating">{t("ui.components.auth.registerform.ked1cb24d")}</Label>
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
          <p className="text-xs text-muted-foreground">{t("ui.components.auth.registerform.ka7e7e63e")}</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="password">{t("ui.components.auth.registerform.ka9694dc2")}</Label>
          <div className="relative">
            <Input
              id="password"
              name="password"
              type={showPassword ? 'text' : 'password'}
              value={formData.password}
              onChange={handleChange}
              placeholder={t("ui.components.auth.registerform.ka9694dc2")}
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
          <Label htmlFor="confirmPassword">{t("ui.components.auth.registerform.k406cdaad")}</Label>
          <div className="relative">
            <Input
              id="confirmPassword"
              name="confirmPassword"
              type={showConfirmPassword ? 'text' : 'password'}
              value={formData.confirmPassword}
              onChange={handleChange}
              placeholder={t("ui.components.auth.registerform.kd8dc593b")}
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
            <p className="text-xs text-red-600">{t("ui.components.auth.registerform.k2b6e54f6")}</p>
          )}
        </div>

        <Button type="submit" className="w-full shogi-btn" disabled={busy || success}>
          {loading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />{
              t("ui.components.auth.registerform.k5c1a34ce")
            }</>
          ) : (
            t("ui.components.auth.registerform.k4c01856c")
          )}
        </Button>
      </form>

      <div className="mt-4 flex items-center gap-2">
        <div className="h-px flex-1 bg-border" />
        <div className="text-xs text-muted-foreground">{t("ui.components.auth.registerform.k6564bfb0")}</div>
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
          {t("ui.components.auth.registerform.kafd13895")}{' '}
          <Button
            variant="link"
            className="p-0 h-auto font-normal shogi-btn"
            onClick={onSwitchToLogin}
            disabled={busy}
          >{
            t("ui.components.auth.registerform.k417181d1")
          }</Button>
        </p>
      </div>
    </>
  );

  if (embedded) {
    // Embedded mode: parent controls the surrounding card/tabs.
    // Keep the layout width flexible (no max-w, no mx-auto).
    return <div className={'w-full ' + (containerClassName || '')}>{inner}</div>;
  }

  return (
    <Card className={'w-full max-w-md mx-auto shogi-auth account-form card-like p-4 ' + (containerClassName || '')}>
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl font-bold text-center">{t("ui.components.auth.registerform.k97012002")}</CardTitle>
        <CardDescription className="text-center">{t("ui.components.auth.registerform.k78aa123e")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">{inner}</CardContent>
    </Card>
  );
};

export default RegisterForm;
