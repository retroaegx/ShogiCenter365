import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';

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
  useEffect(() => {
    if (!open) return;
    const candidate = initial?.timeControl ?? initial?.value ?? (normalized[0]?.value ?? null);
    if (candidate && value !== candidate) setValue(candidate);
  }, [open, normalized, initial]);

const [value, setValue] = useState(() => {
    if (initial && typeof initial === 'object') return initial.timeControl ?? initial.value ?? initial.time ?? null;
    return null;
  });
useEffect(() => {
    if (!open) return;
    try { document.body.classList.add('modal-open'); } catch {}
    return () => { try { document.body.classList.remove('modal-open'); } catch {} };
  }, [open]);

  if (!open) return null;

  const handleSubmit = () => {
    onSubmit?.({ timeControl: value });
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/40 supports-[backdrop-filter]:bg-black/30 backdrop-blur-[2px]" onClick={() => onClose?.()}>
      <div
        className="bg-white rounded-xl shadow-xl w-[min(28rem,calc(100vw-2rem))] p-4"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3">
          <div className="text-base font-semibold">対局申請</div>
          <div className="text-sm text-muted-foreground">待ち時間を選んで申請してね</div>
        </div>

        <div className="space-y-3">
          <div className="text-sm text-muted-foreground">待ち時間</div>
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

        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onClose?.()}>やめる</Button>
          <Button type="button" onClick={handleSubmit} disabled={!value}>申請する</Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
