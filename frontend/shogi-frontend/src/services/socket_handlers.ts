// auto-added by rule-hardening patch
interface MoveResult {
  success: boolean;
  message?: string;
  board?: any;
  check?: { side: 'sente'|'gote' } | null;
  checkmate?: boolean;
  winner?: 'sente'|'gote'|null;
}

export function attachMoveResultHandler(socket: any, {
  showToast,
  rollbackBoard,
  applyBoard,
  highlightKing,
  openResultModal,
}: {
  showToast: (m: string)=>void;
  rollbackBoard: ()=>void;
  applyBoard: (b: any)=>void;
  highlightKing: (side: 'sente'|'gote')=>void;
  openResultModal: (title: string, winner: 'sente'|'gote'|null)=>void;
}) {
  socket.on('move_result', (res: MoveResult) => {
    if (!res.success) {
      showToast(res.message ?? 'その手は指せません');
      rollbackBoard();
      return;
    }
    // 描画は startpos + move_history(USI) の再生で行うためサーバ側の board 適用は不要
    // if (res.board) applyBoard(res.board);
    if (res.check) highlightKing(res.check.side);
    if (res.checkmate) openResultModal('詰み', res.winner ?? null);
  });
}
