import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export default function ResultDialog({ open, onClose, winner, reason, meRole }) {
  const isWin = winner && meRole && winner === meRole;
  const title = isWin ? '勝ち' : (winner ? '負け' : '引き分け');
  const reasonJp = (() => {
    if (!reason) return '';
    switch (reason) {
      case 'resign': return '投了';
      case 'timeup': return '時間切れ';
      case 'checkmate': return '詰み';
      case 'sennichite': return '千日手';
      default: return reason;
    }
  })();

  return (
    <Dialog open={open} onOpenChange={(v)=>{ if (!v) onClose?.(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-2xl text-center">{title}</DialogTitle>
          {reasonJp && <DialogDescription className="text-center mt-1">理由: {reasonJp}</DialogDescription>}
        </DialogHeader>
        <div className="flex justify-center gap-3 mt-4">
          <Button onClick={onClose}>OK</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
