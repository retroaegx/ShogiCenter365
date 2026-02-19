import React, { useEffect, useState } from 'react';
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
  const [code, setCode] = useState(defaultCode || (options[0]?.code ?? ''));

  useEffect(() => {
    if (open) {
      setCode(defaultCode || (options[0]?.code ?? ''));
    }
  }, [open, defaultCode, options]);

  if (!open) return null;

  const titleText = (typeof title === 'string' && title.trim()) ? title : t('ui.components.lobby.offermodal.k1a9bf87b');

  const handleSubmit = () => {
    if (!code) return;
    if (onSubmit) {
      onSubmit(code);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[100] card-like shogi-merge">
      <div className="bg-white rounded-xl p-4 w-[340px]">
        <div className="text-lg font-semibold mb-2">{titleText}</div>

        {conditionText ? (
          <div className="mb-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1" style={{ fontFamily: 'serif' }}>
            {conditionText}
          </div>
        ) : null}

        <div className="text-sm mb-1">{t("ui.components.lobby.offermodal.k21e72ec7")}</div>
        <div className="flex flex-wrap gap-2 mb-2">
          {options.map((opt) => (
            <button
              key={opt.code}
              type="button"
              className={
                'px-3 py-1 rounded border text-sm ' +
                (code === opt.code ? 'bg-gray-200 border-gray-500' : 'bg-white border-gray-300')
              }
              onClick={() => setCode(opt.code)}
            >
              {opt.label ?? opt.name ?? opt.code}
            </button>
          ))}
        </div>

        {ratingNote && (
          <div className="mb-2 text-xs text-red-500">
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
    </div>
  );
}
