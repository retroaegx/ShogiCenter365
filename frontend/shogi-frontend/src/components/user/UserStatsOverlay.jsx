import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Loader2 } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { fetchUserPublicProfile } from '@/services/userPublicProfile';
import { t } from '@/i18n';

// Hover capability is a device-level property. Keep it global to avoid
// installing matchMedia listeners per-row in the lobby.
const _hoverStore = (() => {
  const canUse = typeof window !== 'undefined' && typeof window.matchMedia === 'function';
  const listeners = new Set();

  let mq = null;
  let current = false;

  const init = () => {
    if (!canUse || mq) return;
    mq = window.matchMedia('(hover: hover) and (pointer: fine)');
    current = Boolean(mq.matches);

    const onChange = (e) => {
      current = Boolean(e.matches);
      listeners.forEach((fn) => {
        try {
          fn();
        } catch {
          /* ignore */
        }
      });
    };

    try {
      mq.addEventListener('change', onChange);
    } catch {
      // Safari
      mq.addListener(onChange);
    }
  };

  const subscribe = (cb) => {
    init();
    listeners.add(cb);
    return () => listeners.delete(cb);
  };

  const getSnapshot = () => {
    init();
    return current;
  };

  const getServerSnapshot = () => false;
  return { subscribe, getSnapshot, getServerSnapshot };
})();

function useHoverCapable() {
  return useSyncExternalStore(_hoverStore.subscribe, _hoverStore.getSnapshot, _hoverStore.getServerSnapshot);
}

function winRateText(profile) {
  if (!profile) return '—';
  const wins = Number(profile.wins ?? 0);
  const losses = Number(profile.losses ?? 0);
  const draws = Number(profile.draws ?? 0);
  const total = wins + losses + draws;

  let wr = profile.win_rate;
  if (wr == null && total > 0) wr = wins / total;
  const n = Number(wr);
  if (!Number.isFinite(n) || total <= 0) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

function StatsBody({ profile, loading, error }) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground" style={{ fontFamily: 'serif' }}>
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('ui.components.user.userstatsoverlay.kd1c13ac5')}
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-sm text-red-600" style={{ fontFamily: 'serif' }}>
        {t('ui.components.user.userstatsoverlay.k6bb5e7f0')}
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="text-sm text-muted-foreground" style={{ fontFamily: 'serif' }}>
        {t('ui.components.user.userstatsoverlay.k903dc0b9')}
      </div>
    );
  }

  const wins = Number(profile.wins ?? 0);
  const losses = Number(profile.losses ?? 0);
  const draws = Number(profile.draws ?? 0);

  return (
    <div className="space-y-2" style={{ fontFamily: 'serif' }}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="font-semibold truncate">{profile.username ?? '—'}</div>
        <div className="text-sm text-muted-foreground tabular-nums">R {profile.rating ?? '—'}</div>
      </div>

      <div className="text-xs text-muted-foreground">{t('ui.components.user.userstatsoverlay.k12d63ecc')}</div>
      <div className="text-sm tabular-nums">
        {t('ui.components.user.userstatsoverlay.kecbc7a03', { wins, losses, draws })}
      </div>

      <div className="text-sm">
        <span className="text-xs text-muted-foreground">{t('ui.components.user.userstatsoverlay.kbab1876f')}</span>
        <span className="ml-2 tabular-nums">{winRateText(profile)}</span>
      </div>
    </div>
  );
}

/**
 * Hover (desktop) / Tap (touch devices) overlay showing a user's public stats.
 *
 * Usage:
 *   <UserStatsOverlay userId={id}><button>name</button></UserStatsOverlay>
 */
export default function UserStatsOverlay({ userId, children, contentClassName = '', align = 'start' }) {
  const id = useMemo(() => (userId == null ? '' : String(userId)), [userId]);
  const hoverCapable = useHoverCapable();

  // Force an opaque white background so text doesn't visually collide with the board behind.
  // (Theme tokens like bg-popover may be transparent if CSS variables and Tailwind config are mismatched.)
  const contentClass = useMemo(() => {
    const extra = contentClassName ? String(contentClassName) : '';
    return ['bg-white', 'text-gray-900', extra].filter(Boolean).join(' ');
  }, [contentClassName]);

  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    if (!open || !id) return;

    setLoading(true);
    setError('');
    fetchUserPublicProfile(id)
      .then((p) => {
        if (cancelled) return;
        setProfile(p);
      })
      .catch((e) => {
        if (cancelled) return;
        setError((e && (e.message || String(e))) || 'failed');
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, id]);

  // No id (e.g. not logged in yet) -> render children as-is.
  if (!id) return <>{children}</>;

  const content = <StatsBody profile={profile} loading={loading} error={error} />;

  if (hoverCapable) {
    return (
      <HoverCard open={open} onOpenChange={setOpen}>
        <HoverCardTrigger asChild>{children}</HoverCardTrigger>
        <HoverCardContent align={align} className={contentClass}>
          {content}
        </HoverCardContent>
      </HoverCard>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className={contentClass}>
        {content}
      </PopoverContent>
    </Popover>
  );
}
