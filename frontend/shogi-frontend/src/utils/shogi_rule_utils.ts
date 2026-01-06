// auto-added by rule-hardening patch
export type Side = 'sente' | 'gote';
export type PieceType = 'pawn'|'lance'|'knight'|'silver'|'gold'|'rook'|'bishop'|'king'
  | 'promoted_pawn'|'promoted_lance'|'promoted_knight'|'promoted_silver'
  | 'promoted_rook'|'promoted_bishop';

export interface Piece { type: PieceType; side: Side; }

export function mustPromote(piece: Piece, toRow: number, side: Side) {
  if (piece.type === 'pawn' || piece.type === 'lance') {
    return (side === 'sente' && toRow === 0) || (side === 'gote' && toRow === 8);
  }
  if (piece.type === 'knight') {
    return (side === 'sente' && toRow <= 1) || (side === 'gote' && toRow >= 7);
  }
  return false;
}

export function canOptionallyPromote(piece: Piece, fromRow: number, toRow: number, side: Side) {
  const inZone = (r: number) => side === 'sente' ? r <= 2 : r >= 6; // 敵陣3段
  if (['pawn','lance','knight','silver','rook','bishop'].includes(piece.type)) {
    return inZone(fromRow) || inZone(toRow);
  }
  return false;
}

export function isDeadEndDrop(pieceType: PieceType, toRow: number, side: Side) {
  if (pieceType === 'pawn' || pieceType === 'lance') {
    return (side === 'sente' && toRow === 0) || (side === 'gote' && toRow === 8);
  }
  if (pieceType === 'knight') {
    return (side === 'sente' && toRow <= 1) || (side === 'gote' && toRow >= 7);
  }
  return false;
}
