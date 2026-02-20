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
  // 待機開始の選択肢だけ詳細名にする。
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

  // open のたびに initial を反映する
  useEffect(() => {
    if (!open) return;
    const candidate = initial?.timeControl ?? initial?.value ?? (normalized[0]?.value ?? null);
    if (candidate && value !== candidate) setValue(candidate);

    const gt = initial?.gameType ?? initial?.game_type;
    if (gt === 'free' || gt === 'rating') {
      if (gameType !== gt) setGameType(gt);
    }

    const rv = initial?.reservedWait ?? initial?.reserved ?? initial?.hasReservation;
    if (typeof rv === 'boolean') {
      if (reservedWait !== rv) setReservedWait(rv);
    }

    const he = initial?.handicapEnabled ?? initial?.handicap_enabled;
    if (typeof he === 'boolean') {
      if (handicapEnabled !== he) setHandicapEnabled(he);
    }
    const ht = initial?.handicapType ?? initial?.handicap_type;
    if (typeof ht === 'string' && ht.trim()) {
      const s = ht.trim();
      if (handicapType !== s) setHandicapType(s);
    }

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
      className="fixed inset-0 z-[2000] bg-black/35 flex items-start sm:items-center justify-center overflow-y-auto px-4"
      style={{
        paddingTop: "calc(1rem + env(safe-area-inset-top))",
        paddingBottom: "calc(1rem + env(safe-area-inset-bottom))",
      }}
      onClick={() => onClose?.()}
    >
      <div
        className="shogi-dialog-surface w-[min(32rem,calc(100vw-2rem))] p-4 sm:p-6 flex flex-col max-h-[calc(100vh-2rem)]"
        role="dialog"
        aria-modal="true"
        style={{ maxHeight: "calc(100dvh - 2rem)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="min-h-0 flex-1 overflow-y-auto pr-1" style={{ WebkitOverflowScrolling: "touch" }}>
        <div className="mb-4 text-center">
          <div className="text-xl font-semibold" style={{ fontFamily: 'serif', letterSpacing: '0.12em' }}>
            {t('ui.components.lobby.waitconfigmodal.kb313f5db')}
          </div>
        </div>

        <div className="space-y-4">
          {/* 対局種別 */}
          <div className="space-y-2">
            <div className="shogi-section-label">{t('ui.components.lobby.waitconfigmodal.gameType.label')}</div>
            <div className="shogi-seg" role="tablist" aria-label={t('ui.components.lobby.waitconfigmodal.gameType.label')}>
              {GAME_TYPE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={"shogi-seg-btn " + (gameType === opt.value ? 'is-active' : '')}
                  onClick={() => setGameType(opt.value)}
                  aria-pressed={gameType === opt.value}
                >
                  {t(opt.labelKey)}
                </button>
              ))}
            </div>
          </div>

          {/* 持ち時間 */}
          <div className="space-y-2">
            <div className="shogi-section-label">{t('ui.components.lobby.waitconfigmodal.k492bb9b8')}</div>
            <div className="shogi-chip-row" role="group" aria-label={t('ui.components.lobby.waitconfigmodal.k492bb9b8')}>
              {normalized.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={"shogi-chip " + (value === opt.value ? 'is-active' : '')}
                  onClick={() => setValue(opt.value)}
                  aria-pressed={value === opt.value}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* レーティング範囲 */}
          <div className="pt-1">
            <div className="flex items-center gap-3">
              <div className="shogi-section-label flex-1 min-w-0">{t('ui.components.lobby.waitconfigmodal.kd6be5af6')}</div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-muted-foreground">{t('ui.components.lobby.waitconfigmodal.kc0db98b8')}</span>
                <Switch
                  className="shogi-switch"
                  checked={useRange}
                  onCheckedChange={(v) => setUseRange(!!v)}
                  aria-label={t('ui.components.lobby.waitconfigmodal.kc0db98b8')}
                />
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-sm">±</span>
              <select
                disabled={!useRange}
                value={rateSpan}
                onChange={(e) => setRateSpan(Number(e.target.value))}
                className="shogi-input w-28 px-2 py-1 text-sm"
              >
                {RATE_SPAN_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* 先約待ち */}
          <div className="shogi-card-row flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">{t('ui.components.lobby.waitconfigmodal.reserved.label')}</div>
            </div>
            <Switch
              className="shogi-switch"
              checked={reservedWait}
              onCheckedChange={(v) => setReservedWait(!!v)}
              aria-label={t('ui.components.lobby.waitconfigmodal.reserved.label')}
            />
          </div>

          {/* 駒落ち */}
          <div className={"shogi-card-row space-y-2 " + (handicapToggleDisabled ? 'is-muted' : '')}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium">{t('ui.components.lobby.waitconfigmodal.handicap.label')}</div>
              </div>
              <Switch
                disabled={handicapToggleDisabled}
                checked={handicapEnabled && !handicapToggleDisabled}
                onCheckedChange={(v) => setHandicapEnabled(!!v)}
                aria-label={t('ui.components.lobby.waitconfigmodal.handicap.label')}
                className="shogi-switch"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">{t('ui.components.lobby.waitconfigmodal.handicap.condition')}</span>
              <select
                disabled={handicapSelectDisabled}
                value={handicapType}
                onChange={(e) => setHandicapType(e.target.value)}
                className="shogi-input flex-1 px-2 py-1 text-sm"
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
        </div>

        <div className="shogi-dialog-footer flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onClose?.()}
            className="border-[rgba(201,168,76,0.35)] bg-[rgba(255,255,255,0.6)] hover:bg-[rgba(201,168,76,0.10)]"
          >
            {t('ui.components.lobby.waitconfigmodal.k18ca8614')}
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={!value}
            className="bg-[#2e1c0a] text-[#e8c97a] hover:bg-[#1e1208] shadow-sm"
          >
            {t('ui.components.lobby.waitconfigmodal.kb313f5db')}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
