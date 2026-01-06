import { SOUND_DEFS } from '@/config/sounds';

// ブラウザの自動再生制限により、AudioContext は「ユーザー操作」後に resume が必要。
// ここでは、最初のユーザー操作（pointerdown/keydown/touchstart）で unlock し、
// unlock 前の play() はキューに積んで解放後に再生する。
// 退室SEなど「押した瞬間に鳴る」必要がある音のために、preload() も提供する。

const CACHE_NAME = 'shogi-sounds-v1';
const clamp01 = (v) => Math.max(0, Math.min(1, v));

class SoundManager {
  constructor() {
    this._ctx = null;
    this._envGain = null;
    this._sfxGain = null;

    this._bufferCache = new Map(); // url -> AudioBuffer
    this._inflight = new Map(); // url -> Promise<AudioBuffer>
    this._pending = []; // [{ key, at, opts }]

    // 退室など、即時再生が必要な音の fallback 用（HTMLAudioElement）
    this._htmlBase = new Map(); // url -> HTMLAudioElement

    this._envVol = 0.5;
    this._sfxVol = 0.5;

    this._unlockInstalled = false;
    this._unlocked = false;

    this._onGestureUnlock = this._onGestureUnlock.bind(this);
  }

  // --- public API ---

  has(key) {
    return !!(SOUND_DEFS && SOUND_DEFS[key]);
  }

  installUnlockHandlers() {
    if (this._unlockInstalled) return;
    this._unlockInstalled = true;

    // capture で先に拾う（ボタンの onClick より先に unlock を走らせたい）
    const opts = { capture: true, passive: true };
    window.addEventListener('pointerdown', this._onGestureUnlock, opts);
    window.addEventListener('touchstart', this._onGestureUnlock, opts);
    window.addEventListener('keydown', this._onGestureUnlock, opts);
  }

  setEnvVolume(percent) {
    this._envVol = this._toGain(percent);
    if (this._envGain) this._envGain.gain.value = this._envVol;
  }

  setSfxVolume(percent) {
    this._sfxVol = this._toGain(percent);
    if (this._sfxGain) this._sfxGain.gain.value = this._sfxVol;
  }

  /**
   * 事前ロード（ダウンロード + デコード）。
   * - 自動再生制限の対象外（再生しない）
   * - 退室/駒操作など、押した瞬間に鳴らしたい音で使う
   */
  async preload(key) {
    const resolved = this._resolveKey(key);
    const def = SOUND_DEFS?.[resolved];
    if (!def || !def.url) return false;

    this._ensureAudioGraph();
    this.installUnlockHandlers();

    // HTML fallback の base も用意しておく（作成だけ。再生しない）
    try {
      if (def.category === 'sfx') this._ensureHtmlBase(def.url);
    } catch {}

    try {
      const buf = await this._loadBuffer(def.url);
      return !!buf;
    } catch {
      return false;
    }
  }

  async preloadAll() {
    try {
      const keys = Object.keys(SOUND_DEFS || {});
      await Promise.all(keys.map((k) => this.preload(k)));
    } catch {}
  }

  /**
   * key: SOUND_DEFS のキー
   * opts: { volumeMul?: number, forceHtml?: boolean }
   *
   * 戻り値: 再生開始できたら true（キューに積んだ/失敗は false）
   */
  async play(key, opts = {}) {
    const resolved = this._resolveKey(key);
    const def = SOUND_DEFS?.[resolved];
    if (!def || !def.url) return false;

    const baseVol = (def.category === 'env') ? this._envVol : this._sfxVol;

    // volume 0 は無音なので何もしない（通信も避ける）
    if (baseVol <= 0) return false;

    this._ensureAudioGraph();
    this.installUnlockHandlers();

    // unlock されていなければキュー（unlock 後に再生）
    if (!this._unlocked || !this._ctx || this._ctx.state !== 'running') {
      this._pending.push({ key: resolved, at: Date.now(), opts });
      return false;
    }

    // 退室などは HTMLAudio の方が「即時鳴動」しやすい端末があるので、明示指定があれば fallback
    if (opts?.forceHtml && def.category === 'sfx') {
      try {
        this._playHtml(def.url, baseVol, opts?.volumeMul);
        return true;
      } catch {
        // HTML fallback が失敗したら WebAudio を試す
      }
    }

    try {
      const buf = await this._loadBuffer(def.url);
      if (!buf || !this._ctx) return false;

      const src = this._ctx.createBufferSource();
      src.buffer = buf;

      // 個別のゲイン（volumeMul）
      const mul = typeof opts.volumeMul === 'number' ? opts.volumeMul : 1.0;
      const target = (def.category === 'env') ? this._envGain : this._sfxGain;
      if (!target) return false;

      if (mul !== 1.0) {
        const g = this._ctx.createGain();
        g.gain.value = Math.max(0, mul);
        src.connect(g);
        g.connect(target);
      } else {
        src.connect(target);
      }

      src.start(0);
      return true;
    } catch (e) {
      console.warn('[sound] play failed:', resolved, e);
      return false;
    }
  }

  // --- internals ---

  _resolveKey(key) {
    if (SOUND_DEFS?.[key]) return key;
    // 旧名互換: room_exit <-> room_leave
    if (key === 'room_exit' && SOUND_DEFS?.['room_leave']) return 'room_leave';
    if (key === 'room_leave' && SOUND_DEFS?.['room_exit']) return 'room_exit';
    return key;
  }

  _toGain(percent) {
    const p = Number(percent);
    if (!Number.isFinite(p)) return 0.5;
    return Math.max(0, Math.min(1, p / 100));
  }

  _ensureAudioGraph() {
    if (this._ctx && this._envGain && this._sfxGain) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this._ctx = this._ctx || new Ctx();

    this._envGain = this._envGain || this._ctx.createGain();
    this._sfxGain = this._sfxGain || this._ctx.createGain();
    this._envGain.gain.value = this._envVol;
    this._sfxGain.gain.value = this._sfxVol;

    // どちらも destination へ
    try { this._envGain.connect(this._ctx.destination); } catch {}
    try { this._sfxGain.connect(this._ctx.destination); } catch {}
  }

  _ensureHtmlBase(url) {
    if (!url) return null;
    if (this._htmlBase.has(url)) return this._htmlBase.get(url);

    const a = new Audio(url);
    a.preload = 'auto';
    // iOS Safari で音が途切れないように
    try { a.playsInline = true; } catch {}
    this._htmlBase.set(url, a);
    return a;
  }

  _playHtml(url, baseVol, volumeMul) {
    const mul = (typeof volumeMul === 'number') ? Math.max(0, volumeMul) : 1.0;
    const vol = clamp01((baseVol || 0) * mul);
    if (vol <= 0) return;

    const base = this._ensureHtmlBase(url);
    if (!base) return;

    // 同時再生のため clone を使う
    const a = base.cloneNode(true);
    a.volume = vol;
    a.currentTime = 0;
    const p = a.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }

  _onGestureUnlock() {
    // 1回でも running になればOK
    try {
      this._ensureAudioGraph();
      if (!this._ctx) return;

      if (this._ctx.state !== 'running') {
        const p = this._ctx.resume();
        if (p && typeof p.then === 'function') {
          p.then(() => {
            this._unlocked = true;
            this._removeUnlockHandlers();
            // pending は非同期で消化（ユーザー操作の callstack を汚さない）
            this._flushPending();
          }).catch((e) => {
            // 失敗しても次のジェスチャーで再挑戦
            console.warn('[sound] unlock failed:', e);
          });
          return;
        }
      }

      // ここに来るのは既に running のとき
      this._unlocked = (this._ctx.state === 'running');
      if (this._unlocked) {
        this._removeUnlockHandlers();
        this._flushPending();
      }
    } catch (e) {
      console.warn('[sound] unlock failed:', e);
    }
  }

  _removeUnlockHandlers() {
    if (!this._unlockInstalled) return;
    const opts = { capture: true };
    try { window.removeEventListener('pointerdown', this._onGestureUnlock, opts); } catch {}
    try { window.removeEventListener('touchstart', this._onGestureUnlock, opts); } catch {}
    try { window.removeEventListener('keydown', this._onGestureUnlock, opts); } catch {}
  }

  async _flushPending() {
    if (!this._pending.length) return;
    const q = this._pending.splice(0, this._pending.length);
    // キューが古すぎるものは捨てる（数十秒後に鳴ると違和感が出る）
    const now = Date.now();
    for (const item of q) {
      if (!item || !item.key) continue;
      if ((now - (item.at || now)) > 15000) continue;
      // item.key は既に resolve 済み
      await this.play(item.key, item.opts || {});
    }
  }

  async _loadBuffer(url) {
    // memory cache
    if (this._bufferCache.has(url)) return this._bufferCache.get(url);
    // inflight dedupe
    if (this._inflight.has(url)) return this._inflight.get(url);

    const p = (async () => {
      const ab = await this._fetchArrayBuffer(url);
      if (!ab || !this._ctx) return null;
      const buf = await this._decode(ab);
      if (buf) this._bufferCache.set(url, buf);
      return buf;
    })();
    this._inflight.set(url, p);
    try {
      const r = await p;
      return r;
    } finally {
      this._inflight.delete(url);
    }
  }

  async _fetchArrayBuffer(url) {
    // Cache Storage が使えるなら永続キャッシュを使う
    try {
      if ('caches' in window) {
        const cache = await caches.open(CACHE_NAME);
        const hit = await cache.match(url);
        if (hit) {
          return await hit.arrayBuffer();
        }
        const res = await fetch(url, { cache: 'force-cache' });
        if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
        try { await cache.put(url, res.clone()); } catch {}
        return await res.arrayBuffer();
      }
    } catch (e) {
      console.warn('[sound] cache fetch failed, fallback:', e);
    }

    // fallback
    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    return await res.arrayBuffer();
  }

  _decode(arrayBuffer) {
    return new Promise((resolve, reject) => {
      if (!this._ctx) return reject(new Error('no audio context'));

      // まず Promise 形式を試す（Chrome/Firefox/Safari 新しめ）
      try {
        const p = this._ctx.decodeAudioData(arrayBuffer);
        if (p && typeof p.then === 'function') {
          p.then(resolve).catch(reject);
          return;
        }
      } catch {}

      // Safari 古め: コールバック形式
      try {
        this._ctx.decodeAudioData(arrayBuffer, resolve, reject);
      } catch (e) {
        reject(e);
      }
    });
  }
}

const soundManager = new SoundManager();
export default soundManager;
