// USI (Universal Shogi Interface) helpers
//
// Canonical mapping for this project:
// - board is board[row][col] with row 0 = rank 'a' (gote side), row 8 = rank 'i'
// - col 0 = file 9 (left from sente perspective), col 8 = file 1

const FILE_MIN = 1;
const FILE_MAX = 9;
const RANK_MIN = 'a'.charCodeAt(0);
const RANK_MAX = 'i'.charCodeAt(0);

// Drop uses base piece letters only.
const PIECE_LETTER_BY_TYPE = {
  pawn: 'P',
  lance: 'L',
  knight: 'N',
  silver: 'S',
  gold: 'G',
  bishop: 'B',
  rook: 'R',
  king: 'K',
};

const BASE_TYPE_BY_PIECE_LETTER = {
  P: 'pawn',
  L: 'lance',
  N: 'knight',
  S: 'silver',
  G: 'gold',
  B: 'bishop',
  R: 'rook',
  K: 'king',
};

const PROMOTED_TO_BASE = {
  promoted_pawn: 'pawn',
  promoted_lance: 'lance',
  promoted_knight: 'knight',
  promoted_silver: 'silver',
  horse: 'bishop',
  dragon: 'rook',
};

export function normalizeDropPieceType(pieceType) {
  if (!pieceType) return null;
  const t = String(pieceType);
  return PROMOTED_TO_BASE[t] || t;
}

export function usiSquareToRc(square) {
  if (!square || typeof square !== 'string' || square.length !== 2) return null;
  const file = Number(square[0]);
  const rankCode = square.charCodeAt(1);
  if (!Number.isInteger(file) || file < FILE_MIN || file > FILE_MAX) return null;
  if (rankCode < RANK_MIN || rankCode > RANK_MAX) return null;
  const row = rankCode - RANK_MIN; // a->0 ... i->8
  const col = 9 - file; // 9->0 ... 1->8
  if (row < 0 || row > 8 || col < 0 || col > 8) return null;
  return { row, col };
}

export function rcToUsiSquare(row, col) {
  if (!Number.isInteger(row) || !Number.isInteger(col)) return null;
  if (row < 0 || row > 8 || col < 0 || col > 8) return null;
  const file = 9 - col;
  const rank = String.fromCharCode(RANK_MIN + row);
  return `${file}${rank}`;
}

export function buildUsiMove({ fromRow, fromCol, toRow, toCol, promote = false }) {
  const fromSq = rcToUsiSquare(fromRow, fromCol);
  const toSq = rcToUsiSquare(toRow, toCol);
  if (!fromSq || !toSq) return null;
  return `${fromSq}${toSq}${promote ? '+' : ''}`;
}

export function buildUsiDrop({ pieceType, toRow, toCol }) {
  const base = normalizeDropPieceType(pieceType);
  const letter = base ? PIECE_LETTER_BY_TYPE[base] : null;
  const toSq = rcToUsiSquare(toRow, toCol);
  if (!letter || !toSq) return null;
  return `${letter}*${toSq}`;
}

// Returns { ok, isDrop, promote, fromRow/fromCol?, toRow/toCol, pieceType? }
export function parseUsi(usi) {
  if (!usi || typeof usi !== 'string') return { ok: false };
  const s = usi.trim();
  if (!s) return { ok: false };

  // Drop: P*7f
  if (s.length === 4 && s[1] === '*') {
    const letter = s[0];
    const sq = s.slice(2, 4);
    const pt = BASE_TYPE_BY_PIECE_LETTER[letter] || null;
    const rc = usiSquareToRc(sq);
    if (!pt || !rc) return { ok: false };
    return { ok: true, isDrop: true, pieceType: pt, toRow: rc.row, toCol: rc.col };
  }

  // Move: 7g7f or 2b3c+
  if (s.length === 4 || (s.length === 5 && s.endsWith('+'))) {
    const promote = s.length === 5;
    const fromSq = s.slice(0, 2);
    const toSq = s.slice(2, 4);
    const fr = usiSquareToRc(fromSq);
    const to = usiSquareToRc(toSq);
    if (!fr || !to) return { ok: false };
    return {
      ok: true,
      isDrop: false,
      promote,
      fromRow: fr.row,
      fromCol: fr.col,
      toRow: to.row,
      toCol: to.col,
    };
  }

  return { ok: false };
}
