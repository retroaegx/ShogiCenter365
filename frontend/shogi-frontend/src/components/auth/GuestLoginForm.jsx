import React, { useState } from 'react';
import { t } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { DEFAULT_INITIAL_RATING, buildRatingOptions, ratingToRank24 } from '@/utils/rating24';
import { detectLegionCode } from '@/utils/legion';
import { authErrorMessage } from '@/i18n/authErrors';
import LegionPicker from '@/components/auth/LegionPicker';

const GuestLoginForm = ({ onLoginSuccess, embedded = false, containerClassName = '' }) => {
  const { loginAsGuest } = useAuth();
  const [rating, setRating] = useState(String(DEFAULT_INITIAL_RATING));
  const [legion, setLegion] = useState(detectLegionCode());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const r = await loginAsGuest(Number(rating), legion);
      if (r?.success) {
        onLoginSuccess && onLoginSuccess();
      } else {
        setError(authErrorMessage(r?.error_code || r?.code, r?.message) || t('ui.components.auth.guestloginform.kc30465e0'));
      }
    } catch (e2) {
      const data = e2?.response?.data;
      const code = data?.error_code || data?.code || e2?.error_code;
      const fallback = data?.message || data?.error || e2?.message || String(e2);
      setError(authErrorMessage(code, fallback) || t('ui.components.auth.guestloginform.kc30465e0'));
    } finally {
      setLoading(false);
    }
  };

  const content = (
    <>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="guestRating">{t("ui.components.auth.guestloginform.ke496d813")}</Label>
          <select
            id="guestRating"
            name="guestRating"
            value={rating}
            onChange={(e) => setRating(e.target.value)}
            disabled={loading}
            className="w-full shogi-input h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {buildRatingOptions().map((v) => (
              <option key={v} value={v}>
                {v}（{ratingToRank24(v)}）
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="guestLegion">{t("ui.components.auth.guestloginform.k9ba0c030")}</Label>
          <LegionPicker
            id="guestLegion"
            value={legion}
            onChange={(code) => setLegion(code)}
            disabled={loading}
          />
        </div>

        <Button type="submit" className="w-full shogi-btn" disabled={loading}>
          {loading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("ui.components.auth.guestloginform.k0b6cfb44")}
            </>
          ) : (
            t("ui.components.auth.guestloginform.kdbb8b293")
          )}
        </Button>
      </form>
    </>
  );

  if (embedded) {
    // Embedded mode: parent controls the surrounding card/tabs.
    // Keep the layout width flexible (no max-w, no mx-auto).
    return <div className={'w-full ' + (containerClassName || '')}>{content}</div>;
  }

  return (
    <div className={'w-full max-w-md mx-auto shogi-auth account-form card-like p-4 ' + (containerClassName || '')}>
      {content}
    </div>
  );
};

export default GuestLoginForm;
