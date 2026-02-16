/**
 * 将棋のゲームロジックとルール実装
 */

import { t } from '@/i18n';

// 駒の種類定義
export const PIECE_TYPES = {
  PAWN: 'pawn',
  LANCE: 'lance',
  KNIGHT: 'knight',
  SILVER: 'silver',
  GOLD: 'gold',
  BISHOP: 'bishop',
  ROOK: 'rook',
  KING: 'king',
  PROMOTED_PAWN: 'promoted_pawn',
  PROMOTED_LANCE: 'promoted_lance',
  PROMOTED_KNIGHT: 'promoted_knight',
  PROMOTED_SILVER: 'promoted_silver',
  PROMOTED_BISHOP: 'horse',
  PROMOTED_ROOK: 'dragon'
};

// プレイヤー定義
export const PLAYERS = {
  SENTE: 'sente',
  GOTE: 'gote'
};


// 手の実行が失敗したときのエラーコード（UI側で翻訳して表示する）
export const SHOGI_MOVE_ERROR_CODES = {
  INVALID_MOVE: 'invalid_move',
  CANNOT_MOVE_TO: 'cannot_move_to',
  MUST_ESCAPE_CHECK: 'must_escape_check',
  CANNOT_PROMOTE: 'cannot_promote',
  NO_PIECE_IN_HAND: 'no_piece_in_hand',
  CANNOT_DROP_TO: 'cannot_drop_to'
};

// 駒の表示名（辞書キー）
export const PIECE_NAMES = {
  [PIECE_TYPES.PAWN]: 'shogi.piece.pawn.short',
  [PIECE_TYPES.LANCE]: 'shogi.piece.lance.short',
  [PIECE_TYPES.KNIGHT]: 'shogi.piece.knight.short',
  [PIECE_TYPES.SILVER]: 'shogi.piece.silver.short',
  [PIECE_TYPES.GOLD]: 'shogi.piece.gold.short',
  [PIECE_TYPES.BISHOP]: 'shogi.piece.bishop.short',
  [PIECE_TYPES.ROOK]: 'shogi.piece.rook.short',
  [PIECE_TYPES.KING]: 'shogi.piece.king.short',
  [PIECE_TYPES.PROMOTED_PAWN]: 'shogi.piece.promoted_pawn.short',
  [PIECE_TYPES.PROMOTED_LANCE]: 'shogi.piece.promoted_lance.short',
  [PIECE_TYPES.PROMOTED_KNIGHT]: 'shogi.piece.promoted_knight.short',
  [PIECE_TYPES.PROMOTED_SILVER]: 'shogi.piece.promoted_silver.short',
  [PIECE_TYPES.PROMOTED_BISHOP]: 'shogi.piece.horse.short',
  [PIECE_TYPES.PROMOTED_ROOK]: 'shogi.piece.dragon.short'
};

// 成り可能な駒
export const PROMOTABLE_PIECES = [
  PIECE_TYPES.PAWN,
  PIECE_TYPES.LANCE,
  PIECE_TYPES.KNIGHT,
  PIECE_TYPES.SILVER,
  PIECE_TYPES.BISHOP,
  PIECE_TYPES.ROOK
];

// 成り後の駒
export const PROMOTED_PIECES = {
  [PIECE_TYPES.PAWN]: PIECE_TYPES.PROMOTED_PAWN,
  [PIECE_TYPES.LANCE]: PIECE_TYPES.PROMOTED_LANCE,
  [PIECE_TYPES.KNIGHT]: PIECE_TYPES.PROMOTED_KNIGHT,
  [PIECE_TYPES.SILVER]: PIECE_TYPES.PROMOTED_SILVER,
  [PIECE_TYPES.BISHOP]: PIECE_TYPES.PROMOTED_BISHOP,
  [PIECE_TYPES.ROOK]: PIECE_TYPES.PROMOTED_ROOK
};

// 成り前の駒（持ち駒用）
export const UNPROMOTED_PIECES = {
  [PIECE_TYPES.PROMOTED_PAWN]: PIECE_TYPES.PAWN,
  [PIECE_TYPES.PROMOTED_LANCE]: PIECE_TYPES.LANCE,
  [PIECE_TYPES.PROMOTED_KNIGHT]: PIECE_TYPES.KNIGHT,
  [PIECE_TYPES.PROMOTED_SILVER]: PIECE_TYPES.SILVER,
  [PIECE_TYPES.PROMOTED_BISHOP]: PIECE_TYPES.BISHOP,
  [PIECE_TYPES.PROMOTED_ROOK]: PIECE_TYPES.ROOK
};

/**
 * 初期盤面を作成
 */
export function createInitialBoard() {
  const board = Array(9).fill(null).map(() => Array(9).fill(null));
  
  // 後手の駒配置
  board[0] = [
    { piece: PIECE_TYPES.LANCE, owner: PLAYERS.GOTE },
    { piece: PIECE_TYPES.KNIGHT, owner: PLAYERS.GOTE },
    { piece: PIECE_TYPES.SILVER, owner: PLAYERS.GOTE },
    { piece: PIECE_TYPES.GOLD, owner: PLAYERS.GOTE },
    { piece: PIECE_TYPES.KING, owner: PLAYERS.GOTE },
    { piece: PIECE_TYPES.GOLD, owner: PLAYERS.GOTE },
    { piece: PIECE_TYPES.SILVER, owner: PLAYERS.GOTE },
    { piece: PIECE_TYPES.KNIGHT, owner: PLAYERS.GOTE },
    { piece: PIECE_TYPES.LANCE, owner: PLAYERS.GOTE }
  ];
  
  board[1][1] = { piece: PIECE_TYPES.ROOK, owner: PLAYERS.GOTE };
  board[1][7] = { piece: PIECE_TYPES.BISHOP, owner: PLAYERS.GOTE };
  
  // 後手の歩兵
  for (let i = 0; i < 9; i++) {
    board[2][i] = { piece: PIECE_TYPES.PAWN, owner: PLAYERS.GOTE };
  }
  
  // 先手の歩兵
  for (let i = 0; i < 9; i++) {
    board[6][i] = { piece: PIECE_TYPES.PAWN, owner: PLAYERS.SENTE };
  }
  
  // 先手の駒配置
  board[7][1] = { piece: PIECE_TYPES.BISHOP, owner: PLAYERS.SENTE };
  board[7][7] = { piece: PIECE_TYPES.ROOK, owner: PLAYERS.SENTE };
  
  board[8] = [
    { piece: PIECE_TYPES.LANCE, owner: PLAYERS.SENTE },
    { piece: PIECE_TYPES.KNIGHT, owner: PLAYERS.SENTE },
    { piece: PIECE_TYPES.SILVER, owner: PLAYERS.SENTE },
    { piece: PIECE_TYPES.GOLD, owner: PLAYERS.SENTE },
    { piece: PIECE_TYPES.KING, owner: PLAYERS.SENTE },
    { piece: PIECE_TYPES.GOLD, owner: PLAYERS.SENTE },
    { piece: PIECE_TYPES.SILVER, owner: PLAYERS.SENTE },
    { piece: PIECE_TYPES.KNIGHT, owner: PLAYERS.SENTE },
    { piece: PIECE_TYPES.LANCE, owner: PLAYERS.SENTE }
  ];
  
  return board;
}

/**
 * 駒の移動可能な位置を取得
 */
export function getPossibleMoves(board, row, col, piece) {
  const moves = [];
  const { piece: pieceType, owner } = piece;
  
  // 移動方向（先手基準）
  const direction = owner === PLAYERS.SENTE ? -1 : 1;
  
  switch (pieceType) {
    case PIECE_TYPES.PAWN:
      // 歩：前に1マス
      addMoveIfValid(board, moves, row + direction, col, owner);
      break;
      
    case PIECE_TYPES.LANCE:
      // 香：前方向に直進
      for (let r = row + direction; r >= 0 && r < 9; r += direction) {
        if (!addMoveIfValid(board, moves, r, col, owner)) break;
      }
      break;
      
    case PIECE_TYPES.KNIGHT:
      // 桂：前に2マス、左右に1マス
      addMoveIfValid(board, moves, row + direction * 2, col - 1, owner);
      addMoveIfValid(board, moves, row + direction * 2, col + 1, owner);
      break;
      
    case PIECE_TYPES.SILVER:
      // 銀：前、斜め前、斜め後ろ
      addMoveIfValid(board, moves, row + direction, col, owner);
      addMoveIfValid(board, moves, row + direction, col - 1, owner);
      addMoveIfValid(board, moves, row + direction, col + 1, owner);
      addMoveIfValid(board, moves, row - direction, col - 1, owner);
      addMoveIfValid(board, moves, row - direction, col + 1, owner);
      break;
      
    case PIECE_TYPES.GOLD:
    case PIECE_TYPES.PROMOTED_PAWN:
    case PIECE_TYPES.PROMOTED_LANCE:
    case PIECE_TYPES.PROMOTED_KNIGHT:
    case PIECE_TYPES.PROMOTED_SILVER:
      // 金、成り駒（角・飛以外）：前、斜め前、横、後ろ
      addMoveIfValid(board, moves, row + direction, col, owner);
      addMoveIfValid(board, moves, row + direction, col - 1, owner);
      addMoveIfValid(board, moves, row + direction, col + 1, owner);
      addMoveIfValid(board, moves, row, col - 1, owner);
      addMoveIfValid(board, moves, row, col + 1, owner);
      addMoveIfValid(board, moves, row - direction, col, owner);
      break;
      
    case PIECE_TYPES.BISHOP:
      // 角：斜め方向に直進
      addLineMoves(board, moves, row, col, owner, [
        [-1, -1], [-1, 1], [1, -1], [1, 1]
      ]);
      break;
      
    case PIECE_TYPES.ROOK:
      // 飛：縦横方向に直進
      addLineMoves(board, moves, row, col, owner, [
        [-1, 0], [1, 0], [0, -1], [0, 1]
      ]);
      break;
      
    case PIECE_TYPES.PROMOTED_BISHOP:
      // 馬：角の動き + 王の動き
      addLineMoves(board, moves, row, col, owner, [
        [-1, -1], [-1, 1], [1, -1], [1, 1]
      ]);
      addMoveIfValid(board, moves, row - 1, col, owner);
      addMoveIfValid(board, moves, row + 1, col, owner);
      addMoveIfValid(board, moves, row, col - 1, owner);
      addMoveIfValid(board, moves, row, col + 1, owner);
      break;
      
    case PIECE_TYPES.PROMOTED_ROOK:
      // 竜：飛の動き + 王の動き
      addLineMoves(board, moves, row, col, owner, [
        [-1, 0], [1, 0], [0, -1], [0, 1]
      ]);
      addMoveIfValid(board, moves, row - 1, col - 1, owner);
      addMoveIfValid(board, moves, row - 1, col + 1, owner);
      addMoveIfValid(board, moves, row + 1, col - 1, owner);
      addMoveIfValid(board, moves, row + 1, col + 1, owner);
      break;
      
    case PIECE_TYPES.KING:
      // 王：8方向に1マス
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          addMoveIfValid(board, moves, row + dr, col + dc, owner);
        }
      }
      break;
  }
  
  return moves;
}

/**
 * 直線移動の可能手を追加
 */
function addLineMoves(board, moves, row, col, owner, directions) {
  for (const [dr, dc] of directions) {
    for (let i = 1; i < 9; i++) {
      const newRow = row + dr * i;
      const newCol = col + dc * i;
      
      if (!addMoveIfValid(board, moves, newRow, newCol, owner)) {
        break;
      }
    }
  }
}

/**
 * 有効な移動先かチェックして追加
 */
function addMoveIfValid(board, moves, row, col, owner) {
  if (row < 0 || row >= 9 || col < 0 || col >= 9) {
    return false;
  }
  
  const targetPiece = board[row][col];
  
  if (targetPiece === null) {
    // 空きマス
    moves.push({ row, col, capture: false });
    return true;
  } else if (targetPiece.owner !== owner) {
    // 敵の駒
    moves.push({ row, col, capture: true, capturedPiece: targetPiece });
    return false; // 駒があるので直線移動は止まる
  } else {
    // 自分の駒
    return false;
  }
}

/**
 * 駒打ちの可能な位置を取得
 */
export function getDropMoves(board, pieceType, owner) {
  const moves = [];
  
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      if (board[row][col] === null) {
        // 二歩チェック
        if (pieceType === PIECE_TYPES.PAWN && wouldCreateNifu(board, row, col, owner)) {
          continue;
        }
        
        // 行き所のない駒チェック
        if (isDeadEnd(pieceType, row, owner)) {
          continue;
        }
        
        moves.push({ row, col, isDrop: true });
      }
    }
  }
  
  return moves;
}

/**
 * 二歩になるかチェック
 */
function wouldCreateNifu(board, row, col, owner) {
  for (let r = 0; r < 9; r++) {
    if (r !== row && board[r][col] && 
        board[r][col].piece === PIECE_TYPES.PAWN && 
        board[r][col].owner === owner) {
      return true;
    }
  }
  return false;
}

/**
 * 行き所のない駒かチェック
 */
function isDeadEnd(pieceType, row, owner) {
  if (owner === PLAYERS.SENTE) {
    // 先手の場合
    if (pieceType === PIECE_TYPES.PAWN || pieceType === PIECE_TYPES.LANCE) {
      return row === 0; // 1段目には打てない
    }
    if (pieceType === PIECE_TYPES.KNIGHT) {
      return row <= 1; // 1-2段目には打てない
    }
  } else {
    // 後手の場合
    if (pieceType === PIECE_TYPES.PAWN || pieceType === PIECE_TYPES.LANCE) {
      return row === 8; // 9段目には打てない
    }
    if (pieceType === PIECE_TYPES.KNIGHT) {
      return row >= 7; // 8-9段目には打てない
    }
  }
  return false;
}

/**
 * 成りが可能かチェック
 */
export function canPromote(piece, fromRow, toRow) {
  const { piece: pieceType, owner } = piece;
  
  // 成れない駒
  if (!PROMOTABLE_PIECES.includes(pieceType)) {
    return false;
  }
  
  // 既に成り駒
  if (Object.values(PROMOTED_PIECES).includes(pieceType)) {
    return false;
  }
  
  // 成りエリア判定
  if (owner === PLAYERS.SENTE) {
    // 先手：1-3段目が成りエリア
    return fromRow <= 2 || toRow <= 2;
  } else {
    // 後手：7-9段目が成りエリア
    return fromRow >= 6 || toRow >= 6;
  }
}

/**
 * 成りが強制かチェック
 */
export function mustPromote(piece, toRow) {
  const { piece: pieceType, owner } = piece;
  
  if (owner === PLAYERS.SENTE) {
    // 先手
    if ((pieceType === PIECE_TYPES.PAWN || pieceType === PIECE_TYPES.LANCE) && toRow === 0) {
      return true;
    }
    if (pieceType === PIECE_TYPES.KNIGHT && toRow <= 1) {
      return true;
    }
  } else {
    // 後手
    if ((pieceType === PIECE_TYPES.PAWN || pieceType === PIECE_TYPES.LANCE) && toRow === 8) {
      return true;
    }
    if (pieceType === PIECE_TYPES.KNIGHT && toRow >= 7) {
      return true;
    }
  }
  
  return false;
}

/**
 * 王手かどうかチェック
 */
export function isInCheck(board, player) {
  // 王の位置を探す
  let kingPos = null;
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const piece = board[row][col];
      if (piece && piece.piece === PIECE_TYPES.KING && piece.owner === player) {
        kingPos = { row, col };
        break;
      }
    }
    if (kingPos) break;
  }
  
  if (!kingPos) return false;
  
  // 相手の駒が王を攻撃できるかチェック
  const opponent = player === PLAYERS.SENTE ? PLAYERS.GOTE : PLAYERS.SENTE;
  
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const piece = board[row][col];
      if (piece && piece.owner === opponent) {
        const moves = getPossibleMoves(board, row, col, piece);
        if (moves.some(move => move.row === kingPos.row && move.col === kingPos.col)) {
          return true;
        }
      }
    }
  }
  
  return false;
}

/**
 * 移動後に王手になるかチェック
 */
export function wouldBeInCheckAfterMove(board, fromRow, fromCol, toRow, toCol, player) {
  // 仮想的に移動を実行
  const newBoard = board.map(row => [...row]);
  const piece = newBoard[fromRow][fromCol];
  newBoard[toRow][toCol] = piece;
  newBoard[fromRow][fromCol] = null;
  
  return isInCheck(newBoard, player);
}

/**
 * 駒打ち後に王手になるかチェック
 */
export function wouldBeInCheckAfterDrop(board, row, col, pieceType, player) {
  // 仮想的に駒打ちを実行
  const newBoard = board.map(row => [...row]);
  newBoard[row][col] = { piece: pieceType, owner: player };
  
  return isInCheck(newBoard, player);
}

/**
 * 詰みかどうかチェック
 */
export function isCheckmate(board, capturedPieces, player) {
  if (!isInCheck(board, player)) {
    return false;
  }
  
  // 全ての可能な手を試す
  // 盤上の駒の移動
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const piece = board[row][col];
      if (piece && piece.owner === player) {
        const moves = getPossibleMoves(board, row, col, piece);
        for (const move of moves) {
          if (!wouldBeInCheckAfterMove(board, row, col, move.row, move.col, player)) {
            return false; // 王手を回避できる手がある
          }
        }
      }
    }
  }
  
  // 駒打ち
  const playerCaptured = capturedPieces[player] || {};
  for (const [pieceType, count] of Object.entries(playerCaptured)) {
    if (count > 0) {
      const dropMoves = getDropMoves(board, pieceType, player);
      for (const move of dropMoves) {
        if (!wouldBeInCheckAfterDrop(board, move.row, move.col, pieceType, player)) {
          return false; // 王手を回避できる駒打ちがある
        }
      }
    }
  }
  
  return true; // 詰み
}


function failMove(code) {
  return { success: false, error_code: code };
}

/**
 * 手を実行
 */
export function makeMove(gameState, fromRow, fromCol, toRow, toCol, promote = false) {
  const { board, capturedPieces, currentPlayer } = gameState;
  const piece = board[fromRow][fromCol];
  
  if (!piece || piece.owner !== currentPlayer) {
    return failMove(SHOGI_MOVE_ERROR_CODES.INVALID_MOVE);
  }
  
  // 移動可能かチェック
  const possibleMoves = getPossibleMoves(board, fromRow, fromCol, piece);
  const targetMove = possibleMoves.find(move => move.row === toRow && move.col === toCol);
  
  if (!targetMove) {
    return failMove(SHOGI_MOVE_ERROR_CODES.CANNOT_MOVE_TO);
  }
  
  // 王手放置チェック
  if (wouldBeInCheckAfterMove(board, fromRow, fromCol, toRow, toCol, currentPlayer)) {
    return failMove(SHOGI_MOVE_ERROR_CODES.MUST_ESCAPE_CHECK);
  }
  
  // 成りの処理
  let finalPiece = piece;
  if (promote) {
    if (!canPromote(piece, fromRow, toRow)) {
      return failMove(SHOGI_MOVE_ERROR_CODES.CANNOT_PROMOTE);
    }
    finalPiece = { ...piece, piece: PROMOTED_PIECES[piece.piece] };
  } else if (mustPromote(piece, toRow)) {
    finalPiece = { ...piece, piece: PROMOTED_PIECES[piece.piece] };
  }
  
  // 新しい盤面を作成
  const newBoard = board.map(row => [...row]);
  const capturedPiece = newBoard[toRow][toCol];
  
  newBoard[toRow][toCol] = finalPiece;
  newBoard[fromRow][fromCol] = null;
  
  // 持ち駒の更新
  const newCapturedPieces = { ...capturedPieces };
  if (capturedPiece) {
    const basePiece = UNPROMOTED_PIECES[capturedPiece.piece] || capturedPiece.piece;
    if (!newCapturedPieces[currentPlayer]) {
      newCapturedPieces[currentPlayer] = {};
    }
    newCapturedPieces[currentPlayer][basePiece] = 
      (newCapturedPieces[currentPlayer][basePiece] || 0) + 1;
  }
  
  // 手番交代
  const nextPlayer = currentPlayer === PLAYERS.SENTE ? PLAYERS.GOTE : PLAYERS.SENTE;
  
  const newGameState = {
    board: newBoard,
    capturedPieces: newCapturedPieces,
    currentPlayer: nextPlayer
  };
  
  // 詰みチェック
  const isCheckMate = isCheckmate(newBoard, newCapturedPieces, nextPlayer);
  
  return {
    
board: newBoard,
capturedPieces: newCapturedPieces,
currentPlayer: nextPlayer,

    success: true,
    gameState: newGameState,
    capturedPiece,
    promoted: promote || mustPromote(piece, toRow),
    isCheckmate: isCheckMate,
    isCheck: isInCheck(newBoard, nextPlayer)
  };
}

/**
 * 駒打ちを実行
 */
export function makeDrop(gameState, row, col, pieceType) {
  const { board, capturedPieces, currentPlayer } = gameState;
  
  // 持ち駒があるかチェック
  const playerCaptured = capturedPieces[currentPlayer] || {};
  if (!playerCaptured[pieceType] || playerCaptured[pieceType] <= 0) {
    return failMove(SHOGI_MOVE_ERROR_CODES.NO_PIECE_IN_HAND);
  }
  
  // 駒打ち可能かチェック
  const dropMoves = getDropMoves(board, pieceType, currentPlayer);
  const targetMove = dropMoves.find(move => move.row === row && move.col === col);
  
  if (!targetMove) {
    return failMove(SHOGI_MOVE_ERROR_CODES.CANNOT_DROP_TO);
  }
  
  // 王手放置チェック
  if (wouldBeInCheckAfterDrop(board, row, col, pieceType, currentPlayer)) {
    return failMove(SHOGI_MOVE_ERROR_CODES.MUST_ESCAPE_CHECK);
  }
  
  // 新しい盤面を作成
  const newBoard = board.map(row => [...row]);
  newBoard[row][col] = { piece: pieceType, owner: currentPlayer };
  
  // 持ち駒の更新
  const newCapturedPieces = { ...capturedPieces };
  newCapturedPieces[currentPlayer] = { ...playerCaptured };
  newCapturedPieces[currentPlayer][pieceType]--;
  
  if (newCapturedPieces[currentPlayer][pieceType] === 0) {
    delete newCapturedPieces[currentPlayer][pieceType];
  }
  
  // 手番交代
  const nextPlayer = currentPlayer === PLAYERS.SENTE ? PLAYERS.GOTE : PLAYERS.SENTE;
  
  const newGameState = {
    board: newBoard,
    capturedPieces: newCapturedPieces,
    currentPlayer: nextPlayer
  };
  
  // 詰みチェック
  const isCheckMate = isCheckmate(newBoard, newCapturedPieces, nextPlayer);
  
  return {
    
board: newBoard,
capturedPieces: newCapturedPieces,
currentPlayer: nextPlayer,

    success: true,
    gameState: newGameState,
    isCheckmate: isCheckMate,
    isCheck: isInCheck(newBoard, nextPlayer)
  };
}

/**
 * i18n 辞書から配列を取り出す
 * - 辞書に無い場合は空配列
 * - 文字列の場合は ',' 区切りで split
 */
function _i18nArray(key) {
  const v = t(key);
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v) {
    return v.split(',').map(s => String(s).trim()).filter(Boolean);
  }
  return [];
}

function _notationFiles() {
  // literal t() so gen-i18n picks up keys
  return _i18nArray('shogi.notation.files');
}

function _notationRanks() {
  // literal t() so gen-i18n picks up keys
  return _i18nArray('shogi.notation.ranks');
}

/**
 * 座標を将棋の表記に変換
 */
export function coordinateToShogi(row, col) {
  const files = _notationFiles();
  const ranks = _notationRanks();
  const f = (Number.isInteger(col) && files[col] != null) ? String(files[col]) : '';
  const r = (Number.isInteger(row) && ranks[row] != null) ? String(ranks[row]) : '';
  return f + r;
}

/**
 * 将棋の表記を座標に変換
 */
export function shogiToCoordinate(shogiNotation) {
  const files = _notationFiles();
  const ranks = _notationRanks();

  const s = (shogiNotation == null) ? '' : String(shogiNotation);
  const file = s[0];
  const rank = s[1];

  const col = files.indexOf(file);
  const row = ranks.indexOf(rank);

  return { row, col };
}
