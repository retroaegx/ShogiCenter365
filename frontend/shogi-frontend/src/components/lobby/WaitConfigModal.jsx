import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';

const RATE_SPAN_OPTIONS = [100, 150, 200, 250, 300, 350, 400];

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

  const handleSubmit = () => {
    onSubmit?.({
      timeControl: value,
      rateSpan: useRange ? rateSpan : null,
    });
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-black/40 supports-[backdrop-filter]:bg-black/30 backdrop-blur-[2px]"
      onClick={() => onClose?.()}
    >
      <div
        className="bg-white rounded-xl shadow-xl w-[min(28rem,calc(100vw-2rem))] p-4"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3">
          <div className="text-base font-semibold">{t('ui.components.lobby.waitconfigmodal.kb313f5db')}</div>
          <div className="text-sm text-muted-foreground">{t('ui.components.lobby.waitconfigmodal.ka4d4601d')}</div>
        </div>

        <div className="space-y-3">
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
