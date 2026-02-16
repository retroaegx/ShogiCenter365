import React, { useEffect, useState } from 'react';
import { t } from '@/i18n';

export default function InviteLinkModal({ open, url, onClose }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) setCopied(false);
  }, [open]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore; user can copy manually
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[120]">
      <div className="bg-white rounded-xl p-4 w-[360px] max-w-[92vw]">
        <div className="text-lg font-semibold mb-2">{t('ui.components.lobby.invitelinkmodal.k5a7451f8')}</div>
        <div className="text-xs text-gray-600 mb-2">{t('ui.components.lobby.invitelinkmodal.kbe9b9a0c')}</div>

        <input
          className="w-full border rounded px-2 py-2 text-sm"
          value={url || ''}
          readOnly
          onFocus={(e) => e.target.select()}
        />

        <div className="flex justify-end gap-2 mt-3">
          <button className="px-3 py-1 border rounded" onClick={onClose}>
            {t('ui.components.lobby.invitelinkmodal.k3da5c185')}
          </button>
          <button
            className="px-3 py-1 border rounded bg-amber-800 text-amber-100 hover:bg-amber-900"
            onClick={copy}
            disabled={!url}
          >
            {copied ? t('ui.components.lobby.invitelinkmodal.k019c346d') : t('ui.components.lobby.invitelinkmodal.ke94c2107')}
          </button>
        </div>
      </div>
    </div>
  );
}
