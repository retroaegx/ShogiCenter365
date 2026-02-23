import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from '@/i18n';

export default function OfferModal({
  open,
  onClose,
  onSubmit,
  defaultCode,
  options = [],
  title,
  ratingNote,
  conditionText,
}) {
  // options は呼び出し側によって {code,label}/{value,label}/string[] が混在するので正規化する
  const normalizedOptions = useMemo(() => {
    return (options || [])
      .map((o) => {
        if (typeof o === 'string') return { code: o, label: o };
        if (!o) return null;
        const code = o.code ?? o.value ?? o.name;
        if (!code) return null;
        const label = o.label ?? o.name ?? code;
        return { code, label };
      })
      .filter(Boolean);
  }, [options]);

  const [code, setCode] = useState(defaultCode || (normalizedOptions[0]?.code ?? ''));

  useEffect(() => {
    if (open) {
      setCode(defaultCode || (normalizedOptions[0]?.code ?? ''));
    }
  }, [open, defaultCode, normalizedOptions]);

  // モーダル表示中は body スクロールを止める
  useEffect(() => {
    if (!open) return;
    const prev = document?.body?.style?.overflow;
    if (document?.body?.style) document.body.style.overflow = 'hidden';
    return () => {
      if (document?.body?.style) document.body.style.overflow = prev || '';
    };
  }, [open]);

  // ESC で閉じる
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const titleText = (typeof title === 'string' && title.trim()) ? title : t('ui.components.lobby.offermodal.k1a9bf87b');

  const handleSubmit = () => {
    if (!code) return;
    if (onSubmit) {
      onSubmit(code);
    }
  };

  // 祖先要素に transform 等があると fixed が崩れるので、常に body 直下へポータルする
  return createPortal(
    <div
      className="fixed inset-0 z-[4000] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        // backdrop クリックで閉じる
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div className="bg-white rounded-xl p-4 w-[min(92vw,420px)] shadow-2xl">
        <div className="text-lg font-semibold mb-2">{titleText}</div>

        {conditionText ? (
          <div className="mb-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1" style={{ fontFamily: 'serif' }}>
            {conditionText}
          </div>
        ) : null}

        <div className="text-sm mb-1">{t("ui.components.lobby.offermodal.k21e72ec7")}</div>
        <div className="flex flex-wrap gap-2 mb-2">
          {normalizedOptions.map((opt) => (
            <button
              key={opt.code}
              type="button"
              className={
                'px-3 py-1 rounded border text-sm ' +
                (code === opt.code ? 'bg-gray-200 border-gray-500' : 'bg-white border-gray-300')
              }
              onClick={() => setCode(opt.code)}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {ratingNote && (
          <div className="mb-2 text-xs text-red-500 whitespace-pre-line">
            {ratingNote}
          </div>
        )}

        <div className="flex justify-end gap-2 mt-2">
          <button
            type="button"
            className="px-3 py-1 rounded border border-gray-300 text-sm"
            onClick={onClose}
          >
            {t("ui.components.lobby.offermodal.k269b0f92")}
          </button>
          <button
            type="button"
            className="px-3 py-1 rounded bg-blue-500 text-white text-sm disabled:opacity-50"
            onClick={handleSubmit}
            disabled={!code}
          >
            {t("ui.components.lobby.offermodal.k53ea5d46")}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
