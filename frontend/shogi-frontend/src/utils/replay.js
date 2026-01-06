import { createInitialBoard, makeMove, makeDrop, PLAYERS } from '@/utils/shogiLogic';

function pickMove(rec) {
  const from = rec.from ?? rec.frm ?? rec.f ?? rec;
  const to   = rec.to   ?? rec.dst ?? rec.t ?? rec;
  const toNum = (v) => {
    if (v === 0 || v === '0') return 0;
    const n = Number(v);
    return Number.isInteger(n) ? n : null;
  };
  const from_row = rec.from_row ?? rec.fromRow ?? from?.row ?? from?.r ?? null;
  const from_col = rec.from_col ?? rec.fromCol ?? from?.col ?? from?.c ?? null;
  const to_row   = rec.to_row   ?? rec.toRow   ?? to?.row   ?? to?.r ?? null;
  const to_col   = rec.to_col   ?? rec.toCol   ?? to?.col   ?? to?.c ?? null;
  const is_drop  = !!(rec.type === 'drop' || rec.is_drop || rec.drop || (rec.piece_type && (from_row == null || from_col == null)));
  const promote  = !!(rec.promote ?? rec.is_promote ?? rec.promotion ?? rec.is_promotion ?? rec.promoted ?? rec.p);
  const promote  = !!(rec.promote ?? rec.is_promote ?? rec.p);
  const piece_type = (rec.piece_type ?? rec.piece ?? null);
  return {
    from_row: toNum(from_row), from_col: toNum(from_col),
    to_row: toNum(to_row), to_col: toNum(to_col),
    is_drop, promote, piece_type
  };
}

export function deriveStateFromHistory(baseBoard, moveHistory, upto) {
  const hist = Array.isArray(moveHistory) ? moveHistory : [];
  const end  = Math.max(0, Math.min(upto ?? hist.length, hist.length));

  let state = {
    board: (Array.isArray(baseBoard) && baseBoard.length === 9) ? JSON.parse(JSON.stringify(baseBoard)) : createInitialBoard(),
    capturedPieces: { sente: {}, gote: {} },
    currentPlayer: PLAYERS.SENTE,
  };

  const inBounds = (r, c) => Number.isInteger(r) && Number.isInteger(c) && r >= 0 && r < 9 && c >= 0 && c < 9;

  for (let i = 0; i < end; i++) {
    const m = pickMove(hist[i] || {});
    try {
      if (m.is_drop) {
        if (m.piece_type && inBounds(m.to_row, m.to_col)) {
          const res = makeDrop(state, m.to_row, m.to_col, m.piece_type);
          if (res?.success) state = { board: res.board, capturedPieces: res.capturedPieces, currentPlayer: res.currentPlayer };
        }
      } else {
        if (inBounds(m.from_row, m.from_col) && inBounds(m.to_row, m.to_col)) {
          const res = makeMove(state, m.from_row, m.from_col, m.to_row, m.to_col, m.promote);
          if (res?.success) state = { board: res.board, capturedPieces: res.capturedPieces, currentPlayer: res.currentPlayer };
        }
      }
    } catch (e) {
      // skip invalid moves
    }
  }
  return state;
}
