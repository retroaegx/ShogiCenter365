import React from 'react';

export function DimLayer({children}){
  return (
    <div className="fixed inset-0 z-[1000]">
      <div className="absolute inset-0 bg-black/40 pointer-events-auto"></div>
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="bg-white rounded-xl shadow-lg p-4 w-[360px] pointer-events-auto">{children}</div>
      </div>
    </div>
  );
}

export function SendOfferOverlay({open, opponent, onCancel}){
  if(!open) return null;
  return (
    <DimLayer>
      <div className="text-lg font-semibold mb-2">対局申請中</div>
      <div className="text-sm mb-3">
        相手: <b>{opponent?.username ?? '???'}</b>（R {opponent?.rating ?? 0}）
      </div>
      <div className="flex gap-2 justify-end">
        <button className="px-3 py-1 border rounded" onClick={onCancel}>申請をやめる</button>
      </div>
    </DimLayer>
  );
}

export function ReceiveOfferOverlay({open, fromUser, onAccept, onDecline}){
  if(!open) return null;
  return (
    <DimLayer>
      <div className="text-lg font-semibold mb-2">対局申請が来ています</div>
      <div className="text-sm mb-1">申請者: <b>{fromUser?.username ?? '???'}</b>（R {fromUser?.rating ?? 0}）</div>
      <div className="text-xs text-gray-600 mb-3">他の操作はできません。受けるか、断ってください。</div>
      <div className="flex gap-2 justify-end">
        <button className="px-3 py-1 border rounded" onClick={onDecline}>断る</button>
        <button className="px-3 py-1 border rounded" onClick={onAccept}>受ける</button>
      </div>
    </DimLayer>
  );
}