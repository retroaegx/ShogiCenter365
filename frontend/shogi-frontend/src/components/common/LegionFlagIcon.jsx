import React from 'react';
import { getLegionFlagAssetPath, normalizeLegionCode } from '@/utils/legion';

export default function LegionFlagIcon({ code, size = 18, className = '', title = '' }) {
  const c = normalizeLegionCode(code, 'JP');
  const src = getLegionFlagAssetPath(c);
  const px = Number(size);
  const wh = Number.isFinite(px) && px > 0 ? px : 18;

  return (
    <span
      className={'inline-block overflow-hidden rounded-full border ' + (className || '')}
      style={{ width: wh, height: wh }}
      title={title || c}
    >
      <img
        src={src}
        alt=""
        aria-hidden="true"
        className="h-full w-full object-cover"
        draggable={false}
        onError={(e) => {
          try {
            const el = e.currentTarget;
            if (el && el.src && !el.src.includes('/country/jp.svg')) {
              el.src = '/country/jp.svg';
            }
          } catch {
            // ignore
          }
        }}
      />
    </span>
  );
}
