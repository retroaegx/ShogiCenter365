import React from 'react';
import { t } from '@/i18n';

const DEFAULT_SAMPLE_PIECES = ['king', 'rook', 'bishop', 'gold', 'silver', 'knight', 'lance', 'pawn'];

function pickBgSample(bgSet) {
  const s = bgSet?.sample;
  if (typeof s === 'string' && s.trim()) return s.trim();
  if (s && typeof s === 'object') {
    if (typeof s.image === 'string' && s.image.trim()) return s.image.trim();
    if (typeof s.url === 'string' && s.url.trim()) return s.url.trim();
  }
  if (typeof bgSet?.sampleImage === 'string' && bgSet.sampleImage.trim()) return bgSet.sampleImage.trim();
  if (typeof bgSet?.background === 'string' && bgSet.background.trim()) return bgSet.background.trim();
  return '';
}

function pickPieceOrder(pieceSet) {
  const s = pieceSet?.sample;
  if (s && typeof s === 'object') {
    const arr = s.pieces || s.order;
    if (Array.isArray(arr) && arr.length > 0) {
      return arr.map((x) => String(x)).filter(Boolean);
    }
  }
  return DEFAULT_SAMPLE_PIECES;
}

export default function ThemeSamplePreview({ bgSet, pieceSet }) {
  const bgImg = pickBgSample(bgSet);
  const order = pickPieceOrder(pieceSet);
  const piecesObj = pieceSet?.pieces || {};

  // pieces can be either:
  //  - flat map: { king, rook, ... }
  //  - side-split: { sente: { ... }, gote: { ... } }
  // Settings preview should work for both.
  const hasSides = !!(piecesObj && (piecesObj.sente || piecesObj.gote));
  const senteMap = hasSides ? (piecesObj.sente || {}) : piecesObj;
  const goteMap = hasSides ? (piecesObj.gote || {}) : {};

  const sampleImgs = (() => {
    const out = [];
    for (const rawKey of order) {
      const k = String(rawKey);
      if (!k) continue;

      const s = senteMap?.[k];
      const g = goteMap?.[k];

      // If both sides have distinct images (often only king differs), show both.
      if (typeof s === 'string' && s.trim() && typeof g === 'string' && g.trim() && s !== g) {
        out.push({ key: `${k}_sente`, label: t('ui.components.settings.themesamplepreview.k5ca49aaf', { piece: k }), src: s });
        if (out.length >= 8) break;
        out.push({ key: `${k}_gote`, label: t('ui.components.settings.themesamplepreview.kf3d37a07', { piece: k }), src: g });
      } else {
        const src = (typeof s === 'string' && s.trim()) ? s : ((typeof g === 'string' && g.trim()) ? g : '');
        if (src) out.push({ key: k, label: k, src });
      }

      if (out.length >= 8) break;
    }
    return out.slice(0, 8);
  })();

  // displayName is an i18n key. No fallback to raw internal names.
  const bgLabel = bgSet?.displayName;
  const pieceLabel = pieceSet?.displayName;
  const bgText = bgLabel ? t(bgLabel) : t('ui.components.settings.themesamplepreview.kaf71bb99');
  const pieceText = pieceLabel ? t(pieceLabel) : t('ui.components.settings.themesamplepreview.k07eb1aaa');

  return (
    <div className="flex items-start gap-4 py-2">
      <div className="w-28 shrink-0 pt-2">
        <div className="text-sm font-medium">{t('ui.components.settings.themesamplepreview.kfeb4b598')}</div>
        <div className="text-[10px] text-muted-foreground leading-tight mt-1">
          {t('ui.components.settings.themesamplepreview.ka8ddb710')}
        </div>
      </div>

      <div className="min-w-[10rem]">
        <div
          className="relative w-[160px] h-[160px] rounded-md overflow-hidden border bg-muted"
          style={
            bgImg
              ? {
                  backgroundImage: `url(${bgImg})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                }
              : undefined
          }
          aria-label={t('ui.components.settings.themesamplepreview.kd3697213')}
        >
          {/* 画像が無い場合のフォールバック */}
          {!bgImg && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
              {t('ui.components.settings.themesamplepreview.k443a86d1')}
            </div>
          )}

          {/* 駒サンプル */}
          <div className="absolute inset-0 grid grid-cols-4 grid-rows-2 place-items-center p-2 gap-1">
            {sampleImgs.length > 0 ? (
              sampleImgs.map(({ key, src, label }) => (
                <div
                  key={key}
                  className="w-full h-full flex items-center justify-center rounded bg-white/40 backdrop-blur-[1px]"
                  title={label || key}
                >
                  <img
                    src={src}
                    alt={label || key}
                    className="max-w-[70%] max-h-[70%] object-contain"
                    draggable={false}
                  />
                </div>
              ))
            ) : (
              <div className="col-span-4 row-span-2 flex items-center justify-center text-xs text-muted-foreground">
                {t('ui.components.settings.themesamplepreview.kfaa308ef')}
              </div>
            )}
          </div>
        </div>

        <div className="mt-1 text-[10px] text-muted-foreground">
          {bgText}
          {' / '}
          {pieceText}
        </div>
      </div>
    </div>
  );
}
