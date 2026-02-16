import React, { useEffect, useMemo, useState } from 'react';
import { t } from '@/i18n';

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import ShogiBoard from '@/components/game/ShogiBoard';

import { deriveStateFromHistory } from '@/utils/replay';

import { ChevronsLeft, ChevronsRight, ChevronLeft, ChevronRight, Play, Pause } from 'lucide-react';

function stripMark(s) {
  const text = String(s || '');
  if (text.startsWith('▲') || text.startsWith('△')) return text.slice(1);
  return text;
}

function extractAnalysisFromMove(raw) {
  try {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.analysis && typeof raw.analysis === 'object') return raw.analysis;
    if (raw.analysis_result && typeof raw.analysis_result === 'object') return raw.analysis_result;
    if (raw.obj && typeof raw.obj === 'object') {
      if (raw.obj.analysis && typeof raw.obj.analysis === 'object') return raw.obj.analysis;
      if (raw.obj.analysis_result && typeof raw.obj.analysis_result === 'object') return raw.obj.analysis_result;
    }
  } catch {}
  return null;
}

function formatEvalText(analysis, moveNumber) {
  if (!analysis || typeof analysis !== 'object') return null;
  const cpRaw = (analysis.main_score_cp ?? analysis.score_cp ?? analysis.cp ?? null);
  const mateRaw = (analysis.main_score_mate ?? analysis.score_mate ?? analysis.mate ?? null);

  // engine score is often side-to-move; convert to sente perspective like GameView
  const flip = (moveNumber % 2 === 1);

  if (typeof mateRaw === 'number' && Number.isFinite(mateRaw) && mateRaw !== 0) {
    const v = flip ? -mateRaw : mateRaw;
    const s = (v > 0 ? '+' : '') + String(v);
    return t("ui.components.kifu.kifureplayoverlay.ka361cd7e", { s });
  }
  if (typeof cpRaw === 'number' && Number.isFinite(cpRaw)) {
    const v = flip ? -cpRaw : cpRaw;
    const s = (v > 0 ? '+' : '') + String(Math.trunc(v));
    return s;
  }
  return null;
}

export default function KifuReplayOverlay({ open, onOpenChange, kifu }) {
  const moves = Array.isArray(kifu?.moves) ? kifu.moves : [];
  const total = moves.length;

  const [index, setIndex] = useState(0); // 0..total
  const [isPlaying, setIsPlaying] = useState(false);
  const stepMs = 900;

  // Small-height devices (e.g., iPhone SE series) need a compact UI.
  // Prefer visualViewport height (real visible area in iOS Safari).
  const [vp, setVp] = useState(() => {
    if (typeof window === 'undefined') return { w: 0, h: 0 };
    const vv = window.visualViewport;
    return {
      w: Math.round(vv?.width || window.innerWidth || 0),
      h: Math.round(vv?.height || window.innerHeight || 0),
    };
  });

  useEffect(() => {
    if (!open) return;
    const update = () => {
      const vv = window.visualViewport;
      setVp({
        w: Math.round(vv?.width || window.innerWidth || 0),
        h: Math.round(vv?.height || window.innerHeight || 0),
      });
    };
    update();
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => {
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, [open]);

  const isCompact = useMemo(() => {
    const h = Number(vp?.h || 0);
    const w = Number(vp?.w || 0);
    if (!(h > 0 && w > 0)) return false;
    // iPhone SE2 portrait: ~667px, but visual viewport can be smaller due to bars.
    return (h <= 700) || (h <= 760 && w <= 420);
  }, [vp?.h, vp?.w]);

  // reset on open
  useEffect(() => {
    if (!open) return;
    setIndex(0);
    setIsPlaying(false);
  }, [open]);

  // tick playback
  useEffect(() => {
    if (!open || !isPlaying) return;
    const timerId = setInterval(() => {
      setIndex((prev) => {
        if (prev >= total) {
          // stop at end
          setIsPlaying(false);
          return prev;
        }
        return Math.min(total, prev + 1);
      });
    }, stepMs);
    return () => clearInterval(timerId);
  }, [open, isPlaying, total]);

  // keyboard controls
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setIsPlaying(false);
        setIndex((v) => Math.max(0, v - 1));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setIsPlaying(false);
        setIndex((v) => Math.min(total, v + 1));
      } else if (e.key === 'Home') {
        e.preventDefault();
        setIsPlaying(false);
        setIndex(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        setIsPlaying(false);
        setIndex(total);
      } else if (e.key === ' ') {
        e.preventDefault();
        setIsPlaying((v) => !v);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, total]);

  const replayGameState = useMemo(() => {
    // Prefer SFEN if the kifu carries it (handicap/custom start support)
    const initialSfen =
      (typeof kifu?.initial_sfen === 'string' && kifu.initial_sfen.trim())
        ? kifu.initial_sfen.trim()
        : (typeof kifu?.game?.initial_sfen === 'string' && kifu.game.initial_sfen.trim())
          ? kifu.game.initial_sfen.trim()
          : (typeof kifu?.game?.initialSfen === 'string' && kifu.game.initialSfen.trim())
            ? kifu.game.initialSfen.trim()
            : null;

    const derived = deriveStateFromHistory(initialSfen, moves, index);
    return {
      ...derived,
      players: kifu?.game?.players || {},
      move_history: moves.slice(0, index),
    };
  }, [kifu?.game?.players, moves, index]);

  const moveLabel = useMemo(() => {
    if (index <= 0) return t("ui.components.kifu.kifureplayoverlay.k5e7b7c41");
    const m = moves[index - 1] || {};
    const kif = (typeof m.kif === 'string' && m.kif.trim()) ? stripMark(m.kif.trim()) : '';
    const usi =
      (typeof m.usi === 'string' && m.usi.trim()) ? m.usi.trim()
        : (typeof m.obj?.usi === 'string' && m.obj.usi.trim()) ? m.obj.usi.trim()
          : (typeof m.move?.usi === 'string' && m.move.usi.trim()) ? m.move.usi.trim()
            : '';
    return kif || usi || t("ui.components.kifu.kifureplayoverlay.k30164791");
  }, [moves, index]);

  const evalText = useMemo(() => {
    if (index <= 0) return null;
    const raw = moves[index - 1] || null;
    const a = extractAnalysisFromMove(raw);
    return formatEvalText(a, index);
  }, [moves, index]);

  const playerS = kifu?.game?.players?.sente?.username || '';
  const playerG = kifu?.game?.players?.gote?.username || '';

  const canPrev = index > 0;
  const canNext = index < total;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        Desktop(=lg以上): 高さを固定して盤面を最大化。
        Tablet/Mobile: iOS Safari の vh 揺れや中央固定のはみ出しを避けるため、
        高さは auto + max-height にして内容に追従させる。
      */}
      <DialogContent
        className={
          // Radix DialogContent は既定で中央固定(top/left 50% + translate)なので、
          // タブレット/モバイルは上寄せにして iOS の vh 揺れでもはみ出しにくくする。
          `p-0 sm:max-w-none w-[min(98vw,1700px)] ${isCompact ? 'top-2' : 'top-4'} translate-y-0 lg:top-[50%] lg:translate-y-[-50%] lg:h-[min(96vh,1020px)] lg:h-[min(96dvh,1020px)] overflow-hidden`
        }
        style={{
          // iOS Safari 実機はアドレスバー/ツールバーで見える高さ(visual viewport)が変動するので、
          // vh/dvh ではなく App で管理している --app-height(px) を基準に収める。
          maxHeight: 'calc(var(--app-height, 100vh) - 16px - env(safe-area-inset-top) - env(safe-area-inset-bottom))',
        }}
      >
        <div className="min-h-0 flex flex-col lg:h-full">
          <DialogHeader className={`${isCompact ? 'px-3 py-1' : 'px-4 py-3'} border-b`}>
            {/*
              評価値は通常は中央、コンパクト時は少し右寄せ。
              右上の×(DialogのデフォルトClose)は絶対配置なので、
              右カラムを空にしておくと被りにくい。
            */}
            <div
              className={
                `grid items-center gap-3 ${
                  // Compact: reserve only the close-button width on the right.
                  // (The previous 1fr spacer effectively halved the title width,
                  // making it easy to wrap on small real iOS Safari viewports.)
                  isCompact
                    ? 'grid-cols-[minmax(0,1fr)_auto_2.75rem]'
                    : 'grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]'
                }`
              }
            >
              <div className="min-w-0">
                <DialogTitle className={isCompact ? 'text-xs leading-4 truncate' : 'text-base'}>
                  {isCompact ? `${playerS} vs ${playerG}` : t("ui.components.kifu.kifureplayoverlay.k66a340bc")}
                </DialogTitle>
                <DialogDescription className={isCompact ? 'hidden' : 'text-xs truncate'}>
                  {playerS} vs {playerG}
                </DialogDescription>
              </div>

              <div className={`shrink-0 justify-self-center font-mono text-slate-700 whitespace-nowrap ${isCompact ? 'text-[10px] translate-x-6' : 'text-xs'}`}>
                {t("ui.components.kifu.kifureplayoverlay.kaa88a563", { eval: evalText ?? '-' })}
              </div>

              {/* spacer (the default close button is absolutely positioned) */}
              <div aria-hidden="true" />
            </div>
          </DialogHeader>

          <div className={`flex-1 min-h-0 overflow-auto lg:overflow-hidden ${isCompact ? 'p-1' : 'p-2 sm:p-3'}`}>
            <div className="w-full min-h-0 flex justify-center items-start lg:h-full lg:items-stretch">
              <div className="w-full max-w-[1500px] lg:h-full">
                <ShogiBoard
                  gameState={replayGameState}
                  onMove={() => {}}
                  isSpectator={true}
                  currentUser={null}
                  timeState={null}
                  shellWidthMode="wide"
                  uiDensity={isCompact ? 'compact' : 'normal'}
                  className="w-full lg:h-full"
                />
              </div>
            </div>
          </div>

          <div className={`border-t bg-white/80 backdrop-blur ${isCompact ? 'px-2 py-1.5' : 'px-3 sm:px-4 py-3'} pb-[calc(0.5rem+env(safe-area-inset-bottom))]`}>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className={`flex items-center ${isCompact ? 'gap-2' : 'gap-2'}`}>
                <Button size="icon" variant="outline" className={`bg-white ${isCompact ? 'h-6 w-12' : 'h-11 w-11 sm:h-12 sm:w-12'}`} onClick={() => { setIsPlaying(false); setIndex(0); }} disabled={!canPrev}>
                  <ChevronsLeft className={isCompact ? 'h-3 w-3' : 'h-5 w-5'} />
                </Button>
                <Button size="icon" variant="outline" className={`bg-white ${isCompact ? 'h-6 w-12' : 'h-11 w-11 sm:h-12 sm:w-12'}`} onClick={() => { setIsPlaying(false); setIndex((v) => Math.max(0, v - 1)); }} disabled={!canPrev}>
                  <ChevronLeft className={isCompact ? 'h-3 w-3' : 'h-5 w-5'} />
                </Button>
                <Button
                  size="icon"
                  variant="default"
                  onClick={() => setIsPlaying((v) => !v)}
                  disabled={total <= 0}
                  className={`${isCompact ? 'h-6 w-12' : 'h-11 w-11 sm:h-12 sm:w-12'}`}
                >
                  {isPlaying ? <Pause className={isCompact ? 'h-3 w-3' : 'h-5 w-5'} /> : <Play className={isCompact ? 'h-3 w-3' : 'h-5 w-5'} />}
                </Button>
                <Button size="icon" variant="outline" className={`bg-white ${isCompact ? 'h-6 w-12' : 'h-11 w-11 sm:h-12 sm:w-12'}`} onClick={() => { setIsPlaying(false); setIndex((v) => Math.min(total, v + 1)); }} disabled={!canNext}>
                  <ChevronRight className={isCompact ? 'h-3 w-3' : 'h-5 w-5'} />
                </Button>
                <Button size="icon" variant="outline" className={`bg-white ${isCompact ? 'h-6 w-12' : 'h-11 w-11 sm:h-12 sm:w-12'}`} onClick={() => { setIsPlaying(false); setIndex(total); }} disabled={!canNext}>
                  <ChevronsRight className={isCompact ? 'h-3 w-3' : 'h-5 w-5'} />
                </Button>
              </div>

              <div className={`flex-1 flex items-center gap-2 ${isCompact ? 'min-w-[120px]' : 'min-w-[240px]'}`}>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, total)}
                  value={index}
                  onChange={(e) => { setIsPlaying(false); setIndex(Math.max(0, Math.min(total, Number(e.target.value) || 0))); }}
                  className="w-full"
                />
              </div>

              <div className={`text-slate-700 flex items-center justify-between gap-3 ${isCompact ? 'text-[10px]' : 'text-xs'}`}>
                <span className="font-mono tabular-nums shrink-0">{index}/{total}</span>
                <span className="min-w-0 truncate">{t("ui.components.kifu.kifureplayoverlay.kec9ee965", { index, move: moveLabel })}</span>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
