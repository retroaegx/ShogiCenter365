// frontend/shogi-frontend/src/utils/shogiCoords.js
// 座標ユーティリティ（9→1表示/自分視点で送信）
export function internalFromView(viewR, viewC) {
  const cInternal = 8 - Number(viewC);
  const rInternal = Number(viewR);
  return { rInternal, cInternal };
}
export function selfFromView(viewR, viewC, myRole) {
  const { rInternal, cInternal } = internalFromView(viewR, viewC);
  if (myRole === 'gote') return { r: 8 - rInternal, c: 8 - cInternal };
  return { r: rInternal, c: cInternal };
}
export function viewFromSelf(selfR, selfC, myRole) {
  if (myRole === 'gote') {
    const rInternal = 8 - Number(selfR);
    const cInternal = 8 - Number(selfC);
    return { rView: rInternal, cView: 8 - cInternal };
  }
  return { rView: Number(selfR), cView: 8 - Number(selfC) };
}
