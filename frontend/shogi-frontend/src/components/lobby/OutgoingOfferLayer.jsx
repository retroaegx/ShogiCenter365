// src/components/lobby/OutgoingOfferLayer.jsx
import React, { useEffect, useState, useCallback } from 'react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { useAuth } from '@/contexts/AuthContext';
import ws from '@/services/websocketService';
import api from '@/services/apiClient';

export default function OutgoingOfferLayer(){
  const { user } = useAuth();
  const myId = String(user?._id || user?.id || '');

  const [open, setOpen] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const timerRef = React.useRef(null);
  const acceptedRef = React.useRef(false);

  const [toName, setToName] = useState('');
  const [timeLabel, setTimeLabel] = useState('');

  const reset = useCallback(()=>{
    setOpen(false);
    setErr('');
    setBusy(false);
    setToName('');
    setTimeLabel('');
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current=null; }
    setCountdown(0);
  },[]);

  useEffect(()=>{
    const handler = (payload)=>{
      try{
        const p = payload && payload.detail ? payload.detail : payload;
        if(!p) return;
        
        // Close immediately if accepted (server sends this to both users; payload may not contain from_user_id)
        if (p.type === 'offer_status' && p.status === 'accepted') {
          acceptedRef.current = true;
          reset();
          return;
        }
// I am the sender
        const fromId = String(p.from_user_id || p.from || '');
        if(!myId || fromId !== myId) return;

        if (p.type === 'offer_created') {
          setTimeLabel(p.time_name || '');
          // we may not know receiver name; keep blank
          setOpen(true);
          setCountdown(20);
          if (timerRef.current) clearInterval(timerRef.current);
          timerRef.current = setInterval(()=>setCountdown((s)=>s>0? s-1:0),1000);
        }
        if (p.type === 'offer_status') {
          // accepted/declined by opponent (or timeout cleanup)
          if (p.status === 'declined') { reset(); return; }
          if (p.status === 'accepted') { acceptedRef.current = true; reset();
          }
        }
      }catch(e){
        console.error('outgoing-offer handler failed', e);
      }
    };

    try { ws.off('lobby_offer_update', handler); } catch {}
    try { ws.on('lobby_offer_update', handler); } catch {}

    return ()=>{ try{ ws.off('lobby_offer_update', handler); }catch{} };
  }, [myId, reset]);

  useEffect(()=>{
    if (!open || acceptedRef.current) return;
    if (countdown <= 0) {
      // auto-cancel
      (async()=>{
        try{
          await api.post('/lobby/offer/cancel');
        }catch(e){ console.warn('auto-cancel failed', e); }
        finally {
          reset();
        }
      })();
    }
  }, [open, countdown, reset]);

  const cancel = async ()=>{
    setBusy(true);
    setErr('');
    try{
      const res = await api.post('/lobby/offer/cancel');
      if(!(res?.data?.success)) throw new Error('failed');
      reset();
    }catch(e){
      setErr('キャンセルに失敗しました');
    }finally{
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(v)=>{ if(!v) reset(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>申請中…</AlertDialogTitle>
          <AlertDialogDescription>
            相手の返事を待っています。{timeLabel ? `持ち時間: ${timeLabel}` : ''}
            {err && <div className="mt-3 text-red-600 text-sm">{err}</div>}
            <div className="mt-3 text-sm">残り {countdown} 秒</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} onClick={cancel}>取り消す</AlertDialogCancel>
          <AlertDialogAction disabled>待機中</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
