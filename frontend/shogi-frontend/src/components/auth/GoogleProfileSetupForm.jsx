import React, { useMemo, useState } from 'react';
import { t } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { DEFAULT_INITIAL_RATING, buildRatingOptions, ratingToRank24 } from '@/utils/rating24';
import { detectLegionCode } from '@/utils/legion';
import LegionPicker from '@/components/auth/LegionPicker';
import { authErrorMessage } from '@/i18n/authErrors';

const GoogleProfileSetupForm = ({ pending, onCancel, onComplete, embedded = false, containerClassName = '' }) => {
  const { completeGoogleSignup } = useAuth();

  const [username, setUsername] = useState('');
  const [rating, setRating] = useState(DEFAULT_INITIAL_RATING);
  const [legion, setLegion] = useState(detectLegionCode());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const options = useMemo(() => buildRatingOptions(), []);

  const email = pending?.prefill?.email || '';
  const name = pending?.prefill?.name || '';

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!pending?.signup_token) {
      setError(t('ui.components.auth.googleprofilesetupform.kb8119703'));
      return;
    }
    const u = username.trim();
    if (!u) {
      setError(t('ui.components.auth.googleprofilesetupform.k75e0bbad'));
      return;
    }
    if (u.length < 3) {
      setError(t('ui.components.auth.googleprofilesetupform.kcc33d636'));
      return;
    }
    if (!/^[a-zA-Z0-9_]+$/.test(u)) {
      setError(t('ui.components.auth.googleprofilesetupform.k9ef182e1'));
      return;
    }

    setLoading(true);
    setError('');

    try {
      const res = await completeGoogleSignup(pending.signup_token, u, rating, legion);

      if (res?.success) {
        onComplete && onComplete();
      } else {
        setError(authErrorMessage(res?.error_code || res?.code, res?.message) || t('ui.components.auth.googleprofilesetupform.k34cc378a'));
      }
    } catch (e2) {
      console.error('Google complete signup error:', e2);
      setError(t('ui.components.auth.googleprofilesetupform.k34cc378a'));
    } finally {
      setLoading(false);
    }
  };

  const header = (
    <CardHeader className="space-y-1">
      <CardTitle className="text-2xl font-bold text-center">{t("ui.components.auth.googleprofilesetupform.k12fb2708")}</CardTitle>
      <CardDescription className="text-center">{t("ui.components.auth.googleprofilesetupform.k2d8327f9")}</CardDescription>
    </CardHeader>
  );

  const content = (
    <div className="space-y-4">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {(email || name) ? (
          <div className="text-xs text-muted-foreground space-y-1">
            {name ? <div>{t("ui.common.google_name", { name })}</div> : null}
            {email ? <div>{email}</div> : null}
          </div>
        ) : null}

        <div className="space-y-2">
          <Label htmlFor="google-username">{t("ui.components.auth.googleprofilesetupform.k351d7f6c")}</Label>
          <Input
            id="google-username"
            value={username}
            onChange={(e3) => { setUsername(e3.target.value); if (error) setError(''); }}
            placeholder={t("ui.components.auth.googleprofilesetupform.k9809f8c9")}
            disabled={loading}
            className="w-full shogi-input"
            autoComplete="username"
          />
          <p className="text-xs text-muted-foreground">{t("ui.components.auth.googleprofilesetupform.kf072caa0")}</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="google-legion">{t("ui.components.auth.googleprofilesetupform.k9ba0c030")}</Label>
          <LegionPicker
            id="google-legion"
            value={legion}
            onChange={(code) => setLegion(code)}
            disabled={loading}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="google-rating">{t("ui.components.auth.googleprofilesetupform.ked1cb24d")}</Label>
          <select
            id="google-rating"
            value={rating}
            onChange={(e4) => setRating(parseInt(e4.target.value, 10))}
            disabled={loading}
            className="w-full h-10 rounded-md border border-input bg-background px-3 py-2 text-sm shogi-input"
          >
            {options.map((r) => (
              <option key={r} value={r}>
                {r}（{ratingToRank24(r)}）
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">{t("ui.components.auth.googleprofilesetupform.ka7e7e63e")}</p>
        </div>

        <Button type="submit" className="w-full shogi-btn" disabled={loading}>
          {loading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("ui.components.auth.googleprofilesetupform.kbbf3973e")}
            </>
          ) : (
            t("ui.components.auth.googleprofilesetupform.ka95bf2fe")
          )}
        </Button>

        <div className="text-center">
          <Button
            type="button"
            variant="link"
            className="p-0 h-auto font-normal shogi-btn"
            onClick={onCancel}
            disabled={loading}
          >
            {t("ui.components.auth.googleprofilesetupform.k60a1005b")}
          </Button>
        </div>
      </form>
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

export default GoogleProfileSetupForm;
