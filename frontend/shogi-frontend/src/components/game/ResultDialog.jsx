import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';

export default function ResultDialog({ open, onClose, winner, reason, meRole }) {
  const isWin = winner && meRole && winner === meRole;
  const title = isWin ? t('ui.components.game.resultdialog.k2c8bd192') : (winner ? t('ui.components.game.resultdialog.k0e371a7b') : t('ui.components.game.resultdialog.kacc1bf92'));
  const reasonJp = (() => {
    if (!reason) return '';
    switch (reason) {
      case 'resign': return t('ui.components.game.resultdialog.kd462b7f2');
      case 'timeup': return t('ui.components.game.resultdialog.kd03cff73');
      case 'checkmate': return t('ui.components.game.resultdialog.k7f7c52a3');
      case 'sennichite': return t('ui.components.game.resultdialog.k51eec1db');
      default: return '';
    }
  })();

  return (
    <Dialog open={open} onOpenChange={(v)=>{ if (!v) onClose?.(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-2xl text-center">{title}</DialogTitle>
          {reasonJp && (
            <DialogDescription className="text-center mt-1">
              {t('ui.components.game.resultdialog.kac9f882c', { reason: reasonJp })}
            </DialogDescription>
          )}
        </DialogHeader>
        <div className="flex justify-center gap-3 mt-4">
          <Button onClick={onClose}>{t('ui.common.ok')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
