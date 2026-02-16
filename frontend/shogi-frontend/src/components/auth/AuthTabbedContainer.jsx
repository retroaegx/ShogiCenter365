import React from 'react';
import { t } from '@/i18n';

/**
 * Tab header + panel that looks like a single connected card.
 * - Tabs share the same width and align with the panel below.
 * - Intended for Login/Register/Guest selectors (Top / Invite).
 */
export default function AuthTabbedContainer({
  tabs,
  activeKey,
  onChange,
  children,
  ariaLabel = t('ui.components.auth.authtabbedcontainer.k7a36931a'),
  className = '',
  tabListClassName = '',
  panelClassName = '',
}) {
  return (
    <div
      className={
        'w-full overflow-hidden rounded-2xl shogi-auth ' + (className || '')
      }
    >
      <div
        className={
          'flex w-full items-stretch border-b border-black/10 bg-white/35 ' +
          (tabListClassName || '')
        }
        role="tablist"
        aria-label={ariaLabel}
      >
        {(tabs || []).map((t, idx) => {
          const isActive = activeKey === t.key;
          const isDisabled = !!t.disabled;
          const isFirst = idx === 0;
          const isLast = idx === (tabs?.length || 0) - 1;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              disabled={isDisabled}
              onClick={() => {
                if (isDisabled) return;
                onChange && onChange(t.key);
              }}
              className={
                'flex-1 px-3 py-2 text-sm font-semibold transition-colors duration-150 ' +
                (idx > 0 ? 'border-l border-black/10 ' : '') +
                (isFirst ? 'rounded-tl-2xl ' : '') +
                (isLast ? 'rounded-tr-2xl ' : '') +
                (isDisabled
                  ? 'cursor-not-allowed opacity-50 '
                  : 'cursor-pointer hover:bg-white/55 ') +
                (isActive
                  ? 'bg-amber-200/80 text-amber-950 -mb-px border-b-2 border-amber-500 shadow-sm '
                  : 'text-black/70 border-b border-black/10 ') +
                (isActive
                  ? 'focus-visible:ring-2 focus-visible:ring-amber-500/40 '
                  : 'focus-visible:ring-2 focus-visible:ring-black/20 ') +
                'focus:outline-none'
              }
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div className={'w-full p-4 ' + (panelClassName || '')} role="tabpanel">
        {children}
      </div>
    </div>
  );
}
