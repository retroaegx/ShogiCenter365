import React, { useEffect } from 'react';

/**
 * DoubleLineActionButton
 * 添付の double-line-button.jsx を、画面内で使える汎用ボタンに調整したもの。
 */
export default function DoubleLineActionButton({
  label,
  onClick,
  disabled = false,
  size = 110,
  backgroundColor = '#0a0a0f',
  borderColor = '#ffffff',
  innerBorderColor = 'rgba(255,255,255,0.4)',
  hoverFillColor,
  textColor = '#ffffff',
  hoverTextColor,
  letterSpacing = '0.12em',
  className = '',
  ariaLabel,
  title,
}) {
  // 一度だけフォントを読み込む（重複挿入を避ける）
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const id = 'space-mono-font';
    if (document.getElementById(id)) return;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap';
    document.head.appendChild(link);
  }, []);

  const fill = hoverFillColor ?? borderColor;
  const hoverText = hoverTextColor ?? backgroundColor;

  // Circle button label may overflow in some locales.
  // Heuristic: allow wrapping and slightly shrink typography for longer labels.
  const fit = (() => {
    const raw = (label === null || label === undefined) ? '' : String(label);
    const len = raw.length;

    let fontSizePx = 12;
    let letter = letterSpacing;
    let padX = 10;

    if (len >= 13) {
      fontSizePx = 11;
      letter = '0.09em';
      padX = 9;
    }
    if (len >= 17) {
      fontSizePx = 10;
      letter = '0.07em';
      padX = 8;
    }
    if (len >= 22) {
      fontSizePx = 9;
      letter = '0.05em';
      padX = 7;
    }
    if (len >= 28) {
      fontSizePx = 8;
      letter = '0.03em';
      padX = 6;
    }

    return { fontSizePx, letter, padX };
  })();

  return (
    <>
      <style>{`
        .dl-btn {
          border-radius: 9999px;
          background: var(--dl-bg);
          border: 2px solid var(--dl-border);
          cursor: pointer;
          position: relative;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          transition: transform 0.25s ease, filter 0.25s ease;
          overflow: hidden;
          font-family: 'Space Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
          user-select: none;
          -webkit-tap-highlight-color: transparent;
        }
        .dl-btn::before {
          content: '';
          position: absolute;
          inset: 6px;
          border: 1px solid var(--dl-inner);
          border-radius: 9999px;
          transition: all 0.35s ease;
        }
        .dl-btn::after {
          content: '';
          position: absolute;
          inset: 0;
          background: var(--dl-hover-fill);
          transform: scale(0);
          border-radius: 9999px;
          transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .dl-btn:hover::before { border-color: transparent; }
        .dl-btn:hover::after { transform: scale(1); }
        .dl-btn:active { transform: scale(0.96); }
        .dl-btn:focus-visible { outline: 2px solid rgba(255,255,255,0.75); outline-offset: 3px; }
        .dl-btn .dl-text {
          font-size: var(--dl-text-size);
          font-weight: 700;
          color: var(--dl-text);
          letter-spacing: var(--dl-letter);
          position: relative;
          z-index: 1;
          transition: color 0.35s ease;
          text-align: center;
          line-height: 1.15;
          padding: 0 var(--dl-text-pad);
          max-width: calc(100% - 8px);
          white-space: normal;
          overflow-wrap: anywhere;
          word-break: break-word;
          text-wrap: balance;
        }
        .dl-btn:hover .dl-text { color: var(--dl-hover-text); }
        .dl-btn[aria-disabled='true'] {
          cursor: not-allowed;
          filter: grayscale(0.25) opacity(0.7);
        }
        .dl-btn[aria-disabled='true']::after { transform: scale(0) !important; }
        .dl-btn[aria-disabled='true']:active { transform: none; }
      `}</style>

      <button
        type="button"
        className={`dl-btn ${className}`}
        style={{
          width: size,
          height: size,
          ['--dl-bg']: backgroundColor,
          ['--dl-border']: borderColor,
          ['--dl-inner']: innerBorderColor,
          ['--dl-hover-fill']: fill,
          ['--dl-text']: textColor,
          ['--dl-hover-text']: hoverText,
          ['--dl-letter']: fit.letter,
          ['--dl-text-size']: `${fit.fontSizePx}px`,
          ['--dl-text-pad']: `${fit.padX}px`,
        }}
        onClick={disabled ? undefined : onClick}
        aria-label={ariaLabel ?? label}
        title={title ?? label}
        aria-disabled={disabled ? 'true' : 'false'}
      >
        <span className="dl-text">{label}</span>
      </button>
    </>
  );
}
