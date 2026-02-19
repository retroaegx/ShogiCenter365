import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { t } from '@/i18n';

const RATE_SPAN_OPTIONS = [100, 150, 200, 250, 300, 350, 400];

const GAME_TYPE_OPTIONS = [
  { value: 'rating', labelKey: 'ui.components.lobby.waitconfigmodal.gameType.rating' },
  { value: 'free', labelKey: 'ui.components.lobby.waitconfigmodal.gameType.free' },
];

const HANDICAP_OPTIONS = [
  { value: 'even_lower_first', labelKey: 'ui.components.lobby.waitconfigmodal.handicap.evenLowerFirst' },
  { value: 'lance', labelKey: 'ui.components.lobby.waitconfigmodal.handicap.lance' },
  { value: 'double_lance', labelKey: 'ui.components.lobby.waitconfigmodal.handicap.doubleLance' },
  { value: 'bishop', labelKey: 'ui.components.lobby.waitconfigmodal.handicap.bishop' },
  { value: 'rook', labelKey: 'ui.components.lobby.waitconfigmodal.handicap.rook' },
  { value: 'rook_lance', labelKey: 'ui.components.lobby.waitconfigmodal.handicap.rookLance' },
  { value: 'rook_double_lance', labelKey: 'ui.components.lobby.waitconfigmodal.handicap.rookDoubleLance' },
  { value: 'two_piece', labelKey: 'ui.components.lobby.waitconfigmodal.handicap.twoPiece' },
  { value: 'four_piece', labelKey: 'ui.components.lobby.waitconfigmodal.handicap.fourPiece' },
  { value: 'six_piece', labelKey: 'ui.components.lobby.waitconfigmodal.handicap.sixPiece' },
  { value: 'eight_piece', labelKey: 'ui.components.lobby.waitconfigmodal.handicap.eightPiece' },
  { value: 'ten_piece', labelKey: 'ui.components.lobby.waitconfigmodal.handicap.tenPiece' },
];

const handicapOptionLabel = (o) => {
  // ロビー表示は短くしたいので、待機開始の選択肢だけ詳細名にする。
  if (o?.value === 'even_lower_first') return t('ui.components.lobby.waitconfigmodal.handicap.evenLowerFirstDetail');
  return t(o?.labelKey);
};

export default function WaitConfigModal({ open, onClose, onSubmit, initial = {}, options = [] }) {
  const normalized = useMemo(() => {
    const arr = Array.isArray(options) ? options : [];
    return arr.map((o) => {
      if (typeof o === 'string') return { label: o, value: o };
      const label = (o && (o.name ?? o.label ?? String(o.code ?? o.value ?? ''))) || '';
      const value = (o && (o.code ?? o.value ?? o.name)) ?? '';
      return { label: String(label), value: String(value) };
    });
  }, [options]);

  const [value, setValue] = useState(() => {
    if (initial && typeof initial === 'object') return initial.timeControl ?? initial.value ?? initial.time ?? null;
    return null;
  });

  const [gameType, setGameType] = useState(() => {
    const gt = initial?.gameType ?? initial?.game_type ?? 'rating';
    return (gt === 'free' || gt === 'rating') ? gt : 'rating';
  });

  const [reservedWait, setReservedWait] = useState(() => {
    const v = initial?.reservedWait ?? initial?.reserved ?? initial?.hasReservation;
    return !!v;
  });

  const [handicapEnabled, setHandicapEnabled] = useState(() => {
    const v = initial?.handicapEnabled ?? initial?.handicap_enabled;
    return !!v;
  });

  const [handicapType, setHandicapType] = useState(() => {
    const v = initial?.handicapType ?? initial?.handicap_type;
    return (typeof v === 'string' && v.trim()) ? v.trim() : (HANDICAP_OPTIONS[0]?.value ?? 'even_lower_first');
  });

  // rating range (±). null means "no limit"
  const [useRange, setUseRange] = useState(() => {
    if (initial && typeof initial === 'object') {
      const v = initial.useRange;
      if (v === false) return false;
    }
    return true;
  });
  const [rateSpan, setRateSpan] = useState(() => {
    const v = initial && typeof initial === 'object' ? initial.rateSpan ?? initial.ratingRange ?? initial.rating_range : undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) return 300;
    const m = Math.floor(n);
    return RATE_SPAN_OPTIONS.includes(m) ? m : 300;
  });

  // open のたびに initial を反映する（localStorage等から渡す想定）
  useEffect(() => {
    if (!open) return;
    const candidate = initial?.timeControl ?? initial?.value ?? (normalized[0]?.value ?? null);
    if (candidate && value !== candidate) setValue(candidate);

    // game type
    const gt = initial?.gameType ?? initial?.game_type;
    if (gt === 'free' || gt === 'rating') {
      if (gameType !== gt) setGameType(gt);
    }

    // reserved
    const rv = initial?.reservedWait ?? initial?.reserved ?? initial?.hasReservation;
    if (typeof rv === 'boolean') {
      if (reservedWait !== rv) setReservedWait(rv);
    }

    // handicap
    const he = initial?.handicapEnabled ?? initial?.handicap_enabled;
    if (typeof he === 'boolean') {
      if (handicapEnabled !== he) setHandicapEnabled(he);
    }
    const ht = initial?.handicapType ?? initial?.handicap_type;
    if (typeof ht === 'string' && ht.trim()) {
      const s = ht.trim();
      if (handicapType !== s) setHandicapType(s);
    }

    // rating range
    const initUseRange = initial && typeof initial === 'object' ? initial.useRange : undefined;
    if (initUseRange === false) {
      if (useRange !== false) setUseRange(false);
    } else if (initUseRange === true) {
      if (useRange !== true) setUseRange(true);
    }

    const v = initial && typeof initial === 'object' ? initial.rateSpan ?? initial.ratingRange ?? initial.rating_range : undefined;
    const n = Number(v);
    if (Number.isFinite(n)) {
      const m = Math.floor(n);
      const next = RATE_SPAN_OPTIONS.includes(m) ? m : 300;
      if (rateSpan !== next) setRateSpan(next);
    }
  }, [open, normalized, initial]);

  // Rating対局なら駒落ちは強制OFF（UI・送信の両方）
  useEffect(() => {
    if (!open) return;
    if (gameType !== 'free' && handicapEnabled) {
      setHandicapEnabled(false);
    }
  }, [open, gameType, handicapEnabled]);

  useEffect(() => {
    if (!open) return;
    try {
      document.body.classList.add('modal-open');
    } catch {}
    return () => {
      try {
        document.body.classList.remove('modal-open');
      } catch {}
    };
  }, [open]);

  if (!open) return null;

  const handicapToggleDisabled = gameType !== 'free';
  const handicapSelectDisabled = handicapToggleDisabled || !handicapEnabled;

  const handleSubmit = () => {
    const isFree = gameType === 'free';
    const he = isFree ? !!handicapEnabled : false;
    const ht = (isFree && he) ? handicapType : null;

    onSubmit?.({
      timeControl: value,
      rateSpan: useRange ? rateSpan : null,
      gameType,
      reservedWait: !!reservedWait,
      handicapEnabled: he,
      handicapType: ht,
    });
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-black/40 supports-[backdrop-filter]:bg-black/30 backdrop-blur-[2px]"
      onClick={() => onClose?.()}
    >
      <div
        className="bg-white rounded-xl shadow-xl w-[min(30rem,calc(100vw-2rem))] p-4"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3">
          <div className="text-base font-semibold">{t('ui.components.lobby.waitconfigmodal.kb313f5db')}</div>
          <div className="text-sm text-muted-foreground">{t('ui.components.lobby.waitconfigmodal.ka4d4601d')}</div>
        </div>

        <div className="space-y-4">
          {/* 対局種別 */}
          <div className="space-y-2">
            <div className="text-sm text-muted-foreground">{t('ui.components.lobby.waitconfigmodal.gameType.label')}</div>
            <div className="flex flex-wrap gap-2">
              {GAME_TYPE_OPTIONS.map((opt) => (
                <Button
                  key={opt.value}
                  type="button"
                  variant={gameType === opt.value ? 'default' : 'outline'}
                  onClick={() => setGameType(opt.value)}
                  className="px-3"
                >
                  {t(opt.labelKey)}
                </Button>
              ))}
            </div>
          </div>

          {/* 持ち時間 */}
          <div className="space-y-2">
            <div className="text-sm text-muted-foreground">{t('ui.components.lobby.waitconfigmodal.k492bb9b8')}</div>
            <div className="flex flex-wrap gap-2">
              {normalized.map((opt) => (
                <Button
                  key={opt.value}
                  type="button"
                  variant={value === opt.value ? 'default' : 'outline'}
                  onClick={() => setValue(opt.value)}
                  className="px-3"
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          </div>

          {/* レーティング範囲 */}
          <div className="pt-2 border-t">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm text-muted-foreground">{t('ui.components.lobby.waitconfigmodal.kd6be5af6')}</div>
              <label className="text-sm flex items-center gap-2 select-none">
                <input
                  type="checkbox"
                  checked={useRange}
                  onChange={(e) => setUseRange(!!e.target.checked)}
                />
                {t('ui.components.lobby.waitconfigmodal.kc0db98b8')}
              </label>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-sm">±</span>
              <select
                disabled={!useRange}
                value={rateSpan}
                onChange={(e) => setRateSpan(Number(e.target.value))}
                className="w-28 border rounded px-2 py-1"
              >
                {RATE_SPAN_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <span className="text-sm text-muted-foreground">{t('ui.components.lobby.waitconfigmodal.kca1778de')}</span>
            </div>
          </div>

          {/* 先約待ち（下側へ配置） */}
          <div className="flex items-start justify-between gap-3 border rounded-md px-3 py-2">
            <div className="min-w-0">
              <div className="text-sm font-medium">{t('ui.components.lobby.waitconfigmodal.reserved.label')}</div>
              <div className="text-xs text-muted-foreground">{t('ui.components.lobby.waitconfigmodal.reserved.help')}</div>
            </div>
            <Switch
              checked={reservedWait}
              onCheckedChange={(v) => setReservedWait(!!v)}
              aria-label={t('ui.components.lobby.waitconfigmodal.reserved.label')}
            />
          </div>

          {/* 駒落ち（下側へ配置） */}
          <div className="border rounded-md px-3 py-2 space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium">{t('ui.components.lobby.waitconfigmodal.handicap.label')}</div>
                <div className="text-xs text-muted-foreground">{t('ui.components.lobby.waitconfigmodal.handicap.help')}</div>
              </div>
              <Switch
                disabled={handicapToggleDisabled}
                checked={handicapEnabled && !handicapToggleDisabled}
                onCheckedChange={(v) => setHandicapEnabled(!!v)}
                aria-label={t('ui.components.lobby.waitconfigmodal.handicap.label')}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">{t('ui.components.lobby.waitconfigmodal.handicap.condition')}</span>
              <select
                disabled={handicapSelectDisabled}
                value={handicapType}
                onChange={(e) => setHandicapType(e.target.value)}
                className="flex-1 border rounded px-2 py-1"
              >
                {HANDICAP_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {handicapOptionLabel(o)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onClose?.()}>
            {t('ui.components.lobby.waitconfigmodal.k18ca8614')}
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={!value}>
            {t('ui.components.lobby.waitconfigmodal.kb313f5db')}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
