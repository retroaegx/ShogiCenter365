import { createInitialBoard, makeMove, makeDrop, PLAYERS } from '@/utils/shogiLogic';
import { parseUsi } from '@/utils/usi';
import { parseSfen } from '@/utils/sfen';

function deepClone(v) {
  // state is small (9x9 board + maps). JSON clone is sufficient here.
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return v;
  }
}

function buildInitialState(initial) {
  // initial can be:
  // - null/undefined: hirate
  // - string: SFEN
  // - object: { board, capturedPieces, currentPlayer }
  if (typeof initial === 'string') {
    const parsed = parseSfen(initial);
    if (parsed?.board) {
      return {
        board: deepClone(parsed.board),
        capturedPieces: deepClone(parsed.capturedPieces || { sente: {}, gote: {} }),
        currentPlayer: parsed.currentPlayer || PLAYERS.SENTE,
      };
    }
  }
  if (initial && typeof initial === 'object') {
    const b = initial.board;
    if (Array.isArray(b) && b.length === 9) {
      return {
        board: deepClone(b),
        capturedPieces: deepClone(initial.capturedPieces || { sente: {}, gote: {} }),
        currentPlayer: initial.currentPlayer || PLAYERS.SENTE,
      };
    }
  }
  return {
    board: createInitialBoard(),
    capturedPieces: { sente: {}, gote: {} },
    currentPlayer: PLAYERS.SENTE,
  };
}

function extractUsi(raw) {
  if (!raw) return null;
  if (typeof raw?.usi === 'string') return raw.usi;
  if (typeof raw?.move_usi === 'string') return raw.move_usi;
  if (typeof raw?.obj?.usi === 'string') return raw.obj.usi;
  if (typeof raw?.move?.usi === 'string') return raw.move.usi;
  return null;
}

function toNum(v) {
  if (v === 0 || v === '0') return 0;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

function inBounds(r, c) {
  return Number.isInteger(r) && Number.isInteger(c) && r >= 0 && r < 9 && c >= 0 && c < 9;
}

/**
 * Derive a UI gameState from move history.
 *
 * Supported move formats:
 * - { usi: "7g7f" } or { obj: { usi: ... } }
 * - legacy object coordinates (from_row/from_col/to_row/to_col, etc)
 *
 * @param {null|string|object} initial - null (hirate), SFEN string, or {board,capturedPieces,currentPlayer}
 * @param {Array} moveHistory
 * @param {number} upto - number of plies to apply (0..moveHistory.length)
 */
export function deriveStateFromHistory(initial, moveHistory, upto) {
  const hist = Array.isArray(moveHistory) ? moveHistory : [];
  const end = Math.max(0, Math.min(upto ?? hist.length, hist.length));

  let state = buildInitialState(initial);

  for (let i = 0; i < end; i += 1) {
    const raw = hist[i] || {};

    // 1) canonical: USI
    const usi = extractUsi(raw);
    if (usi) {
      const p = parseUsi(usi);
      if (p?.ok) {
        try {
          if (p.isDrop) {
            const res = makeDrop(state, p.toRow, p.toCol, p.pieceType);
            if (res?.success) state = { ...state, board: res.board, capturedPieces: res.capturedPieces, currentPlayer: res.currentPlayer };
          } else {
            const res = makeMove(state, p.fromRow, p.fromCol, p.toRow, p.toCol, !!p.promote);
            if (res?.success) state = { ...state, board: res.board, capturedPieces: res.capturedPieces, currentPlayer: res.currentPlayer };
          }
        } catch {}
        continue;
      }
    }

    // 2) fallback: legacy object formats
    const m = (raw && typeof raw === 'object' && raw.obj) ? raw.obj : raw;
    const fr = m.from || m.frm || m.f || m;
    const to = m.to || m.dst || m.t || m;
    const fromRow = toNum(m.from_row ?? m.fromRow ?? fr?.row ?? fr?.r ?? null);
    const fromCol = toNum(m.from_col ?? m.fromCol ?? fr?.col ?? fr?.c ?? null);
    const toRow = toNum(m.to_row ?? m.toRow ?? to?.row ?? to?.r ?? null);
    const toCol = toNum(m.to_col ?? m.toCol ?? to?.col ?? to?.c ?? null);
    const isDrop = !!(m.type === 'drop' || m.is_drop || m.drop || (m.piece_type && (fromRow == null || fromCol == null)));
    const promote = !!(m.promote ?? m.is_promote ?? m.promotion ?? m.is_promotion ?? m.promoted ?? m.p);

    try {
      if (isDrop) {
        const pt = (m.piece_type ?? m.piece ?? null);
        if (pt && inBounds(toRow, toCol)) {
          const res = makeDrop(state, toRow, toCol, pt);
          if (res?.success) state = { ...state, board: res.board, capturedPieces: res.capturedPieces, currentPlayer: res.currentPlayer };
        }
      } else {
        if (inBounds(fromRow, fromCol) && inBounds(toRow, toCol)) {
          const res = makeMove(state, fromRow, fromCol, toRow, toCol, promote);
          if (res?.success) state = { ...state, board: res.board, capturedPieces: res.capturedPieces, currentPlayer: res.currentPlayer };
        }
      }
    } catch {
      // ignore invalid move
    }
  }

  return state;
}
