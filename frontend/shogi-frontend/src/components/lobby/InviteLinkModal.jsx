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
    <div className="fixed inset-0 z-[2000] bg-black/35 flex items-center justify-center overflow-y-auto py-6 px-4" onClick={onClose}>
      <div className="shogi-dialog-surface p-4 sm:p-6 w-[min(28rem,calc(100vw-2rem))] max-h-[calc(100vh-3rem)] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="text-center mb-4">
          <div className="text-lg font-semibold" style={{ fontFamily: 'serif', letterSpacing: '0.10em' }}>{t('ui.components.lobby.invitelinkmodal.k5a7451f8')}</div>
          <div className="text-xs text-muted-foreground mt-1">{t('ui.components.lobby.invitelinkmodal.kbe9b9a0c')}</div>
        </div>

        <input
          className="w-full shogi-input px-3 py-2 text-sm"
          value={url || ''}
          readOnly
          onFocus={(e) => e.target.select()}
        />

        <div className="mt-5 pt-4 border-t border-[rgba(201,168,76,0.18)] flex justify-end gap-2">
          <button className="px-4 py-2 border rounded-md text-sm border-[rgba(201,168,76,0.35)] bg-[rgba(255,255,255,0.6)] hover:bg-[rgba(201,168,76,0.10)]" onClick={onClose}>
            {t('ui.components.lobby.invitelinkmodal.k3da5c185')}
          </button>
          <button
            className="px-4 py-2 border rounded-md text-sm shadow-sm bg-[#2e1c0a] text-[#e8c97a] hover:bg-[#1e1208] disabled:opacity-50"
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
