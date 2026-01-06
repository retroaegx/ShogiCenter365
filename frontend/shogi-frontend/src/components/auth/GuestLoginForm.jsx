import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { DEFAULT_INITIAL_RATING, buildRatingOptions, ratingToRank24 } from '@/utils/rating24';

const GuestLoginForm = ({ onLoginSuccess }) => {
  const { loginAsGuest } = useAuth();
  const [rating, setRating] = useState(String(DEFAULT_INITIAL_RATING));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const r = await loginAsGuest(Number(rating));
      if (r?.success) {
        onLoginSuccess && onLoginSuccess();
      } else {
        setError(r?.message || 'ゲストログインに失敗しました');
      }
    } catch (e2) {
      setError((e2 && (e2.message || String(e2))) || 'ゲストログインに失敗しました');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full max-w-md mx-auto shogi-auth account-form card-like p-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="guestRating">レーティング</Label>
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

        <Button type="submit" className="w-full shogi-btn" disabled={loading}>
          {loading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ログイン中
            </>
          ) : (
            'ゲストでログイン'
          )}
        </Button>
      </form>
    </div>
  );
};

export default GuestLoginForm;
