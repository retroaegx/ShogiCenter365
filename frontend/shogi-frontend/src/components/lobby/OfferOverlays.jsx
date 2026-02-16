import React from 'react';
import { t } from '@/i18n';

export function DimLayer({ children }) {
  return (
    <div className="fixed inset-0 z-[1000]">
      <div className="absolute inset-0 bg-black/40 pointer-events-auto"></div>
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="bg-white rounded-xl shadow-lg p-4 w-[360px] pointer-events-auto">
          {children}
        </div>
      </div>
    </div>
  );
}

export function SendOfferOverlay({ open, opponent, onCancel }) {
  if (!open) return null;
  const name = opponent?.username ?? '—';
  const rating = opponent?.rating ?? 0;

  return (
    <DimLayer>
      <div className="text-lg font-semibold mb-2">{t('ui.components.lobby.offeroverlays.k1a29a433')}</div>
      <div className="text-sm mb-3">
        {t('ui.components.lobby.offeroverlays.k00673d15')} <b>{name}</b>
        {t('ui.common.rating.parens', { rating })}
      </div>
      <div className="flex gap-2 justify-end">
        <button className="px-3 py-1 border rounded" onClick={onCancel}>
          {t('ui.components.lobby.offeroverlays.k39746775')}
        </button>
      </div>
    </DimLayer>
  );
}

export function ReceiveOfferOverlay({ open, fromUser, onAccept, onDecline }) {
  if (!open) return null;
  const name = fromUser?.username ?? '—';
  const rating = fromUser?.rating ?? 0;

  return (
    <DimLayer>
      <div className="text-lg font-semibold mb-2">{t('ui.components.lobby.offeroverlays.k3868ec7a')}</div>
      <div className="text-sm mb-1">
        {t('ui.components.lobby.offeroverlays.kd00e22dc')} <b>{name}</b>
        {t('ui.common.rating.parens', { rating })}
      </div>
      <div className="text-xs text-gray-600 mb-3">{t('ui.components.lobby.offeroverlays.k4bc8c2ea')}</div>
      <div className="flex gap-2 justify-end">
        <button className="px-3 py-1 border rounded" onClick={onDecline}>
          {t('ui.components.lobby.offeroverlays.k2d0cc45e')}
        </button>
        <button className="px-3 py-1 border rounded" onClick={onAccept}>
          {t('ui.components.lobby.offeroverlays.k14380f3f')}
        </button>
      </div>
    </DimLayer>
  );
}
