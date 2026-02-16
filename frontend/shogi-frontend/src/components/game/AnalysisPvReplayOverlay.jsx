import React, { useEffect, useMemo, useRef, useState } from 'react';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import ShogiBoard from '@/components/game/ShogiBoard';

import { deriveStateFromHistory } from '@/utils/replay';

import { ChevronsLeft, ChevronsRight, ChevronLeft, ChevronRight, Play, Pause } from 'lucide-react';

import { t } from '@/i18n';

function safeStr(v) {
  try {
    if (v == null) return '';
    return String(v);
  } catch {
    return '';
  }
}

/**
 * 解析の読み筋（PV）を、検索の棋譜再生に近い形でオーバーレイ表示する。
 * - open: Dialog の開閉
 * - baseState: PV 開始局面（board/capturedPieces/currentPlayer）
 * - baseMoveNumber: 開始局面の手数（= 何手まで指した後の局面か）
 * - pvMoves: [{usi, kif}]  kif は「▲7七桂」などの表示用
 */
export default function AnalysisPvReplayOverlay({
  open,
  onOpenChange,
  baseState,
  baseMoveNumber = 0,
  pvMoves,
}) {
  const moves = Array.isArray(pvMoves) ? pvMoves : [];
  const total = moves.length;

  const [index, setIndex] = useState(0); // 0..total（0は開始局面）
  const [isPlaying, setIsPlaying] = useState(false);

  // 速すぎないように（ユーザー指摘）
  const stepMs = 1200;

  // iOS Safari の vh 揺れ対策に visualViewport を見て compact 判定
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

  const isPhoneWidth = useMemo(() => {
    const w = Number(vp?.w || 0);
    if (!(w > 0)) return false;
    return w <= 480;
  }, [vp?.w]);

  const isTinyPhone = useMemo(() => {
    const w = Number(vp?.w || 0);
    const h = Number(vp?.h || 0);
    if (!(w > 0 && h > 0)) return false;
    // iPhoneSE2 近辺（Safariの上下バー込みで実効高さがかなり小さくなる）
    return w <= 390 && h <= 560;
  }, [vp?.w, vp?.h]);

  const isCompact = useMemo(() => {
    const h = Number(vp?.h || 0);
    const w = Number(vp?.w || 0);
    if (!(h > 0 && w > 0)) return false;
    // phone幅は常に compact（高さがあっても盤+持ち駒が潰れやすい）
    if (w <= 480) return true;
    return (h <= 700) || (h <= 760 && w <= 420);
  }, [vp?.h, vp?.w]);

  const boardUiDensity = useMemo(() => {
    const w = Number(vp?.w || 0);
    if (isCompact) return 'compact';
    // PV再生は情報量が多いので、一般的なPCでも少し詰める
    if (w > 0 && w < 1600) return 'compact';
    return 'normal';
  }, [isCompact, vp?.w]);

  // Desktop は余白を取りつつ、現状より一段大きめに表示する
  // （スマホは全画面）
  const desktopModalHeight = 'min(90vh, 980px)';


  // KIFは欲しいけど優先度は低い：
  // - 極小(=iPhoneSE2級)は無し
  // - それ以外の phone は「下の余り領域」に出す（盤を潰すなら自動で引っ込める）
  const estimatedHeaderH = useMemo(() => (isCompact ? 76 : 90), [isCompact]);
  // ShogiBoard(モバイル)は「盤(正方形) + 上下のユーザーパネル(持ち駒含む)」の縦を要する。
  // compact ではユーザーパネルがかなり詰まるため、過剰に見積もると盤が小さくなりすぎる。
  const estimatedBoardOverheadH = useMemo(() => (isCompact ? 120 : 190), [isCompact]);
  const basePad = useMemo(() => (isCompact ? 10 : 14), [isCompact]);

  const phoneUsableH = useMemo(() => {
    if (!isPhoneWidth) return null;
    const h = Number(vp?.h || 0);
    if (!(h > 0)) return null;
    // DialogContent は fullscreen の場合、上下 safe-area を別で取るのでここでは素直に計算
    return Math.max(0, h - estimatedHeaderH - basePad * 2);
  }, [isPhoneWidth, vp?.h, estimatedHeaderH, basePad]);

  const boardSideNoKif = useMemo(() => {
    const w = Number(vp?.w || 0);
    const h = Number(vp?.h || 0);
    if (!(w > 0 && h > 0)) return null;
    const usableW = Math.max(0, w - basePad * 2);
    const usableH = Math.max(0, h - estimatedHeaderH - basePad * 2);
    // ShogiBoard は「盤(正方形) + 持ち駒/プレイヤー部」が乗るので、その分を見込む
    const maxByH = Math.max(0, usableH - estimatedBoardOverheadH);
    const side = Math.floor(Math.min(usableW, maxByH));
    return side > 0 ? side : null;
  }, [vp?.w, vp?.h, basePad, estimatedHeaderH, estimatedBoardOverheadH]);

  const phoneBoardAreaH = useMemo(() => {
    if (!isPhoneWidth) return null;
    const s = boardSideNoKif || 0;
    if (!(s > 0)) return null;
    // ShogiBoard は「盤(正方形) + 上下のユーザーパネル(持ち駒含む)」が縦に乗る
    return Math.max(0, Math.floor(s + estimatedBoardOverheadH));
  }, [isPhoneWidth, boardSideNoKif, estimatedBoardOverheadH]);

  const phoneKifAvailH = useMemo(() => {
    if (!isPhoneWidth) return 0;
    const usableH = phoneUsableH || 0;
    const boardH = phoneBoardAreaH || 0;
    return Math.max(0, Math.floor(usableH - boardH));
  }, [isPhoneWidth, phoneUsableH, phoneBoardAreaH]);

  const showKifMobile = useMemo(() => {
    if (!isPhoneWidth) return false;
    if (isTinyPhone) return false;
    if (total <= 0) return false;
    // 盤を優先し、残った領域だけをKIFに回す
    return phoneKifAvailH >= 96;
  }, [isPhoneWidth, isTinyPhone, total, phoneKifAvailH]);

  const boardWrapStyle = useMemo(() => {
    if (!isPhoneWidth) return undefined;
    const s = boardSideNoKif;
    if (!(s > 0)) return undefined;
    return { width: `${s}px`, maxWidth: '100%' };
  }, [isPhoneWidth, boardSideNoKif]);

  const phoneBoardAreaStyle = useMemo(() => {
    if (!isPhoneWidth) return undefined;
    const h = phoneBoardAreaH || 0;
    if (!(h > 0)) return undefined;
    return { height: `${h}px` };
  }, [isPhoneWidth, phoneBoardAreaH]);

  const headerRef = useRef(null);

  // open したら停止＆先頭へ（自動再生はしない）
  useEffect(() => {
    if (!open) return;
    setIndex(0);
    setIsPlaying(false);
  }, [open]);

  // 再生
  useEffect(() => {
    if (!open || !isPlaying) return;
    const timerId = setInterval(() => {
      setIndex((prev) => {
        if (prev >= total) {
          setIsPlaying(false);
          return prev;
        }
        return Math.min(total, prev + 1);
      });
    }, stepMs);
    return () => clearInterval(timerId);
  }, [open, isPlaying, total]);

  // キーボード操作（任意）
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

  const initial = useMemo(() => {
    if (!baseState) return null;
    const b = baseState?.board;
    if (!Array.isArray(b) || b.length !== 9) return null;
    return {
      board: baseState.board,
      capturedPieces: baseState.capturedPieces || { sente: {}, gote: {} },
      currentPlayer: baseState.currentPlayer || 'sente',
    };
  }, [baseState]);

  const replayGameState = useMemo(() => {
    const derived = deriveStateFromHistory(initial, moves, index);
    return {
      ...derived,
      players: {},
      move_history: [],
    };
  }, [initial, moves, index]);

  const lineItems = useMemo(() => {
    const b = Math.max(0, parseInt(baseMoveNumber || 0));
    return moves.map((m, i) => {
      const n = b + i + 1;
      const text = safeStr(m?.kif || m?.usi || '');
      return { n, text };
    });
  }, [moves, baseMoveNumber]);

  const currentLabel = useMemo(() => {
    if (index <= 0) return t('ui.components.game.analysispvreplayoverlay.k0eafd61f');
    const m = moves[index - 1] || {};
    return safeStr(m.kif || m.usi || '');
  }, [moves, index]);

  const canPrev = index > 0;
  const canNext = index < total;

  const isFullscreen = isPhoneWidth;

  return (
    <Dialog open={!!open} onOpenChange={onOpenChange}>
      <DialogContent
        className={
          `p-0 sm:max-w-none overflow-hidden ` +
          (isFullscreen
            ? 'w-screen h-[var(--app-height,100vh)] max-w-none max-h-none rounded-none border-0 top-0 left-0 right-0 bottom-0 translate-x-0 translate-y-0'
            : 'w-[min(96vw,1400px)] max-w-none')
        }
        style={
          isFullscreen
            ? { height: 'var(--app-height, 100vh)', maxHeight: 'var(--app-height, 100vh)' }
            : { height: desktopModalHeight, maxHeight: '90vh' }
        }
      >
        <div className={`min-h-0 flex flex-col h-full ${isFullscreen ? 'pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]' : ''}`}>
          <DialogHeader ref={headerRef} className={`${isCompact ? 'px-3 py-2' : 'px-4 py-3'} pr-14 border-b`}>
            <div className="flex items-center justify-between gap-3">
              <DialogTitle className={isCompact ? 'text-sm' : 'text-base'}>{t('ui.components.game.analysispvreplayoverlay.kb060a7fd')}</DialogTitle>
              <div className="text-xs font-mono text-slate-700 whitespace-nowrap">{`${index}/${total}`}</div>
            </div>
          </DialogHeader>

          {/* 操作列（ヘッダー直下に固定） */}
          <div className={`${isCompact ? 'px-2 py-1' : 'px-3 py-2'} pr-14 border-b bg-white/70`}>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 text-xs font-mono text-slate-700 whitespace-nowrap overflow-hidden text-ellipsis">
                {currentLabel}
              </div>
              <div className="flex items-center gap-1 flex-nowrap">
                <Button
                  variant="outline"
                  size="icon"
                  className={isCompact ? 'h-9 w-9' : ''}
                  disabled={!canPrev}
                  onClick={() => { try { setIsPlaying(false); setIndex(0); } catch {} }}
                  title={t('ui.components.game.analysispvreplayoverlay.k5b463517')}
                >
                  <ChevronsLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className={isCompact ? 'h-9 w-9' : ''}
                  disabled={!canPrev}
                  onClick={() => { try { setIsPlaying(false); setIndex((v) => Math.max(0, v - 1)); } catch {} }}
                  title={t('ui.components.game.analysispvreplayoverlay.k60a1005b')}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className={isCompact ? 'h-9 w-9' : ''}
                  disabled={total <= 0}
                  onClick={() => { try { setIsPlaying((v) => !v); } catch {} }}
                  title={isPlaying ? t('ui.components.game.analysispvreplayoverlay.k21941967') : t('ui.components.game.analysispvreplayoverlay.k66a340bc')}
                >
                  {isPlaying ? (<Pause className="h-4 w-4" />) : (<Play className="h-4 w-4" />)}
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className={isCompact ? 'h-9 w-9' : ''}
                  disabled={!canNext}
                  onClick={() => { try { setIsPlaying(false); setIndex((v) => Math.min(total, v + 1)); } catch {} }}
                  title={t('ui.components.game.analysispvreplayoverlay.k225550ae')}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className={isCompact ? 'h-9 w-9' : ''}
                  disabled={!canNext}
                  onClick={() => { try { setIsPlaying(false); setIndex(total); } catch {} }}
                  title={t('ui.components.game.analysispvreplayoverlay.k40151c75')}
                >
                  <ChevronsRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>

          {/* 本体: 盤を優先しつつ、余り領域をKIFに回す */}
          <div className={`${isCompact ? 'p-1' : 'p-2 sm:p-3'} flex-1 min-h-0 overflow-hidden`}>
            <div className="w-full h-full min-h-0 flex flex-col gap-2">
              {/* 盤エリア */}
              <div
                className={isPhoneWidth ? 'flex-none min-h-0 overflow-hidden' : 'flex-1 min-h-0 overflow-auto'}
                style={isPhoneWidth ? phoneBoardAreaStyle : undefined}
              >
                {!isPhoneWidth ? (
                  <ShogiBoard
                    gameState={replayGameState}
                    onMove={() => {}}
                    isSpectator={true}
                    currentUser={null}
                    timeState={null}
                    shellWidthMode="wide"
                    uiDensity={boardUiDensity}
                    className="h-full min-h-0"
                  />
                ) : (
                  <div className="w-full flex justify-center" style={boardWrapStyle}>
                    <div className="w-full min-w-0">
                      <ShogiBoard
                        gameState={replayGameState}
                        onMove={() => {}}
                        isSpectator={true}
                        currentUser={null}
                        timeState={null}
                        shellWidthMode="wide"
                        uiDensity={boardUiDensity}
                        className="h-full min-h-0"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* 読み筋（KIF）: PCは必ず下。Phoneは下の余り領域のみ（盤が潰れるなら出さない）。 */}
              {!isPhoneWidth ? (
                <div
                  className="w-full min-h-0 flex-none rounded-lg border border-white/70 bg-white/70 p-2 overflow-auto"
                  style={{ height: 'clamp(110px, 22vh, 240px)' }}
                >
                  <div className="text-xs font-semibold text-slate-700 mb-2">{t('ui.components.game.analysispvreplayoverlay.k4356385c')}</div>
                  <div className="space-y-1">
                    {lineItems.map((it, i) => {
                      const isCur = (i + 1) === index;
                      return (
                        <button
                          key={i}
                          type="button"
                          className={
                            `w-full text-left rounded px-2 py-1 text-xs font-mono ` +
                            (isCur ? 'bg-slate-900/5' : 'hover:bg-slate-900/5')
                          }
                          onClick={() => {
                            try { setIsPlaying(false); setIndex(i + 1); } catch {}
                          }}
                        >
                          <span className="inline-block w-10 text-slate-600">{it.n}</span>
                          <span className="text-slate-800">{it.text}</span>
                        </button>
                      );
                    })}
                    {lineItems.length <= 0 ? (
                      <div className="text-xs text-slate-600">{t('ui.components.game.analysispvreplayoverlay.k85067ec1')}</div>
                    ) : null}
                  </div>
                </div>
              ) : (showKifMobile ? (
                <div className="w-full min-h-0 flex-1 rounded-lg border border-white/70 bg-white/70 p-2 overflow-auto">
                  <div className="text-xs font-semibold text-slate-700 mb-2">{t('ui.components.game.analysispvreplayoverlay.k4356385c')}</div>
                  <div className="space-y-1">
                    {lineItems.map((it, i) => {
                      const isCur = (i + 1) === index;
                      return (
                        <button
                          key={i}
                          type="button"
                          className={
                            `w-full text-left rounded px-2 py-1 text-xs font-mono ` +
                            (isCur ? 'bg-slate-900/5' : 'hover:bg-slate-900/5')
                          }
                          onClick={() => {
                            try { setIsPlaying(false); setIndex(i + 1); } catch {}
                          }}
                        >
                          <span className="inline-block w-10 text-slate-600">{it.n}</span>
                          <span className="text-slate-800">{it.text}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null)}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
