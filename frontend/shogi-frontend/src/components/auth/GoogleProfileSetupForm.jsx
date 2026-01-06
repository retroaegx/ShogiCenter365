import React, { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { DEFAULT_INITIAL_RATING, buildRatingOptions, ratingToRank24 } from '@/utils/rating24';

const GoogleProfileSetupForm = ({ pending, onCancel, onComplete }) => {
  const { completeGoogleSignup } = useAuth();

  const [username, setUsername] = useState('');
  const [rating, setRating] = useState(DEFAULT_INITIAL_RATING);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const options = useMemo(() => buildRatingOptions(), []);

  const email = pending?.prefill?.email || '';
  const name = pending?.prefill?.name || '';

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!pending?.signup_token) {
      setError('Google登録情報が見つかりません');
      return;
    }
    const u = username.trim();
    if (!u) {
      setError('表示名を入力してください');
      return;
    }
    if (u.length < 3) {
      setError('ユーザー名は3文字以上で入力してください');
      return;
    }
    if (!/^[a-zA-Z0-9_]+$/.test(u)) {
      setError('ユーザー名は英数字とアンダースコアのみ使用できます');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const res = await completeGoogleSignup(pending.signup_token, u, rating);

      if (res?.success) {
        onComplete && onComplete();
      } else {
        setError(res?.message || '登録に失敗しました');
      }
    } catch (e2) {
      console.error('Google complete signup error:', e2);
      setError('登録に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="w-full max-w-md mx-auto shogi-auth account-form card-like p-4">
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl font-bold text-center">Googleで初期設定</CardTitle>
        <CardDescription className="text-center">
          表示名と初期レーティングを決めます
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {(email || name) ? (
            <div className="text-xs text-muted-foreground space-y-1">
              {name ? <div>Google: {name}</div> : null}
              {email ? <div>{email}</div> : null}
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="google-username">表示名（ユーザー名）</Label>
            <Input
              id="google-username"
              value={username}
              onChange={(e3) => { setUsername(e3.target.value); if (error) setError(''); }}
              placeholder="例: shogi_user"
              disabled={loading}
              className="w-full shogi-input"
              autoComplete="username"
            />
            <p className="text-xs text-muted-foreground">英数字と_のみ、3文字以上</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="google-rating">初期レーティング</Label>
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
            <p className="text-xs text-muted-foreground">自己申告の初期値です。対局で増減します。</p>
          </div>

          <Button type="submit" className="w-full shogi-btn" disabled={loading}>
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                登録中
              </>
            ) : (
              '開始'
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
              戻る
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
};

export default GoogleProfileSetupForm;
