import { t } from '@/i18n';
import { shogiMoveErrorMessage } from '@/i18n/shogiErrors';

// auto-added by rule-hardening patch
interface MoveResult {
  success: boolean;
  message?: string;
  error_code?: string;
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
      // Prefer stable error codes when available.
      // Do not show server-provided message to users (it may not be localized).
      if (res.error_code) {
        showToast(shogiMoveErrorMessage(res.error_code));
      } else {
        showToast(t('ui.services.socket.handlers.k4258aaab'));
      }
      rollbackBoard();
      return;
    }
    // 描画は startpos + move_history(USI) の再生で行うためサーバ側の board 適用は不要
    // if (res.board) applyBoard(res.board);
    if (res.check) highlightKing(res.check.side);
    if (res.checkmate) openResultModal(t('ui.services.socket.handlers.k7f7c52a3'), res.winner ?? null);
  });
}
