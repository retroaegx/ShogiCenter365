import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Globe, X } from 'lucide-react';
import {
  SUPPORTED_LANGUAGES,
  ensurePreferredLanguage,
  getFlagAssetPath,
  getLanguageMeta,
  normalizeLanguage,
  setPreferredLanguage,
} from '@/utils/language';
import { t, notifyLanguageChange } from '@/i18n';

const FlagIcon = ({ code, className = '' }) => {
  const c = normalizeLanguage(code);
  const src = getFlagAssetPath(c);

  return (
    <span className={'inline-block h-5 w-5 overflow-hidden rounded-full border ' + className}>
      <img
        src={src}
        alt=""
        aria-hidden="true"
        className="h-full w-full object-cover"
        draggable={false}
        onError={(e) => {
          // Fallback to US flag if the asset is missing.
          try {
            const el = e.currentTarget;
            if (el && el.src && !el.src.includes('/country/us.svg')) {
              el.src = '/country/us.svg';
            }
          } catch {
            // ignore
          }
        }}
      />
    </span>
  );
};

// Small top-right language picker for the Top screen.
// - Shows a globe icon + current language icon.
// - Clicking either opens a small overlay panel.
const LanguagePicker = ({ className = '' }) => {
  const [open, setOpen] = useState(false);
  const [lang, setLang] = useState(() => ensurePreferredLanguage());
  const panelRef = useRef(null);

  const meta = useMemo(() => getLanguageMeta(lang), [lang]);

  // literal t() so gen-i18n picks up keys
  const nativeName = {
    ja: t('ui.language.native.ja'),
    en: t('ui.language.native.en'),
    zh: t('ui.language.native.zh'),
    fr: t('ui.language.native.fr'),
    de: t('ui.language.native.de'),
    pl: t('ui.language.native.pl'),
    it: t('ui.language.native.it'),
    pt: t('ui.language.native.pt'),
  };
  const labelName = {
    ja: t('ui.language.label.ja'),
    en: t('ui.language.label.en'),
    zh: t('ui.language.label.zh'),
    fr: t('ui.language.label.fr'),
    de: t('ui.language.label.de'),
    pl: t('ui.language.label.pl'),
    it: t('ui.language.label.it'),
    pt: t('ui.language.label.pt'),
  };
  const currentCode = meta?.code || lang;
  const currentTitle = nativeName[currentCode] || labelName[currentCode] || '';

  useEffect(() => {
    // Close on outside click
    const onDown = (e) => {
      if (!open) return;
      const el = panelRef.current;
      if (!el) return;
      if (el.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown, { passive: true });
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [open]);

  const choose = (code) => {
    const next = setPreferredLanguage(code);
    setLang(next);
    setOpen(false);
    notifyLanguageChange();
  };

  return (
    // NOTE:
    // The static top pages inject a sticky header (z-index: 30) via static_shell.js.
    // On desktop, the header nav can fully cover the top-right area.
    // Use an explicit inline zIndex so this picker is always above the header.
    // Mobile: the static header injects a top-right menu button.
    // Keep enough spacing on small screens so the picker does not overlap with the menu button.
    <div className={'fixed top-3 right-14 sm:right-3 ' + (className || '')} style={{ zIndex: 9999 }}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={t('ui.components.top.languagepicker.kc5b3a0ce')}
          className="inline-flex h-9 w-9 items-center justify-center rounded-full border bg-white/80 backdrop-blur hover:bg-white"
          onClick={() => setOpen((v) => !v)}
        >
          <Globe className="h-5 w-5" />
        </button>

        <button
          type="button"
          aria-label={t('ui.components.top.languagepicker.k0c5a5d1b')}
          className="inline-flex h-9 min-w-9 items-center justify-center rounded-full border bg-white/80 px-2 backdrop-blur hover:bg-white"
          onClick={() => setOpen((v) => !v)}
          title={currentTitle}
        >
          <FlagIcon code={meta?.code || lang} />
        </button>
      </div>

      {open && (
        <div
          ref={panelRef}
          className="mt-2 w-[260px] rounded-xl border bg-white shadow-lg"
          role="dialog"
          aria-label={t('ui.components.top.languagepicker.k95f05a46')}
        >
          <div className="flex items-center justify-between border-b px-3 py-2">
            <div className="text-sm font-medium">{t('ui.components.top.languagepicker.keb9f0071')}</div>
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
              aria-label={t('ui.components.top.languagepicker.k7a0d0b6b')}
              onClick={() => setOpen(false)}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="max-h-[320px] overflow-auto p-2">
            {SUPPORTED_LANGUAGES.map((x) => {
              const active = x.code === (meta?.code || lang);
              return (
                <button
                  key={x.code}
                  type="button"
                  onClick={() => choose(x.code)}
                  className={
                    'flex w-full items-center justify-between rounded-lg px-3 py-2 text-left hover:bg-muted ' +
                    (active ? 'bg-muted' : '')
                  }
                >
                  <div className="flex items-center gap-2">
                    <FlagIcon code={x.code} />
                    <div className="leading-tight">
                      <div className="text-sm font-medium">{nativeName[x.code] || ''}</div>
                      <div className="text-xs text-muted-foreground">{labelName[x.code] || ''}</div>
                    </div>
                  </div>
                  {active ? <span className="text-xs text-muted-foreground">{t('ui.components.top.languagepicker.kb4dffb70')}</span> : null}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default LanguagePicker;
