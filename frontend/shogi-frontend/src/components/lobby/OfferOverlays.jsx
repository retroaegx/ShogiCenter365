import React from 'react';
import { t } from '@/i18n';
import '@/styles/shogi-form-theme.css';

export function DimLayer({ children }) {
  return (
    <div className="shogi-form-overlay" role="dialog" aria-modal="true">
      <div className="shogi-form-modal w-[460px] max-w-[92vw]">
        <div className="shogi-form-topbar" />
        <div className="shogi-form-corner shogi-form-corner-tl">◇</div>
        <div className="shogi-form-corner shogi-form-corner-tr">◇</div>
        <div className="shogi-form-inner">{children}</div>
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
      <div className="shogi-form-header">
        <div className="shogi-form-title">{t('ui.components.lobby.offeroverlays.k1a29a433')}</div>
      </div>
      <div className="text-sm mb-3" style={{ color: '#3d322a' }}>
        {t('ui.components.lobby.offeroverlays.k00673d15')} <b>{name}</b>
        {t('ui.common.rating.parens', { rating })}
      </div>
      <div className="shogi-form-actions" style={{ justifyContent: 'flex-end' }}>
        <button className="shogi-form-btn shogi-form-btn-ghost" onClick={onCancel}>
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
      <div className="shogi-form-header">
        <div className="shogi-form-title">{t('ui.components.lobby.offeroverlays.k3868ec7a')}</div>
      </div>
      <div className="text-sm mb-1" style={{ color: '#3d322a' }}>
        {t('ui.components.lobby.offeroverlays.kd00e22dc')} <b>{name}</b>
        {t('ui.common.rating.parens', { rating })}
      </div>
      <div className="shogi-form-subtitle mb-3" style={{ textAlign: 'left', color: '#8a7060' }}>{t('ui.components.lobby.offeroverlays.k4bc8c2ea')}</div>
      <div className="shogi-form-actions" style={{ justifyContent: 'flex-end' }}>
        <button className="shogi-form-btn shogi-form-btn-ghost" onClick={onDecline}>
          {t('ui.components.lobby.offeroverlays.k2d0cc45e')}
        </button>
        <button className="shogi-form-btn shogi-form-btn-primary" onClick={onAccept}>
          {t('ui.components.lobby.offeroverlays.k14380f3f')}
        </button>
      </div>
    </DimLayer>
  );
}
