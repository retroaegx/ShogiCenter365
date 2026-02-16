import { SOUND_DEFS } from '@/config/sounds';

// ブラウザの自動再生制限により、AudioContext は「ユーザー操作」後に resume が必要。
// iOS Safari は resume だけでは「その後の非ジェスチャー再生」が許可されない/無音になる端末があり、
// その場合は "ユーザー操作中に" 無音の発音（prime）が必要。

const CACHE_NAME = 'shogi-sounds-v1';
const clamp01 = (v) => Math.max(0, Math.min(1, v));

const isIOS = () => {
  try {
    const ua = navigator.userAgent || '';
    // iPadOS 13+ は "Macintosh" を名乗る場合があるため touchpoints も見る
    const iOSLike = /iPhone|iPad|iPod/.test(ua) || (/(Macintosh)/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
    return !!iOSLike;
  } catch {
    return false;
  }
};

class SoundManager {
  constructor() {
    this._ctx = null;
    this._envGain = null;
    this._sfxGain = null;

    this._bufferCache = new Map(); // url -> AudioBuffer
    this._inflight = new Map(); // url -> Promise<AudioBuffer>
    this._pending = []; // [{ key, at, opts }]

    // HTMLAudioElement の base（clone 再生）
    this._htmlBase = new Map(); // url -> HTMLAudioElement

    this._envVol = 0.5;
    this._sfxVol = 0.5;

    // iOS Safari: unlock 後に 'suspended' に戻ることがあるためリスナーは外さない
    this._unlockInstalled = false;
    this._unlocked = false;

    // "prime" はユーザー操作中に 1回だけ行う（その後の非ジェスチャー再生を許可させる）
    this._primed = false;
    this._primeHtmlDone = false;
    this._unlockCheckScheduled = false;

    this._isIOS = isIOS();

    this._onGestureUnlock = this._onGestureUnlock.bind(this);
  }

  // --- public API ---

  has(key) {
    return !!(SOUND_DEFS && SOUND_DEFS[key]);
  }

  installUnlockHandlers() {
    if (this._unlockInstalled) return;
    this._unlockInstalled = true;

    // capture で先に拾う（React のハンドラより先に unlock/prime を走らせたい）
    const passiveCap = { capture: true, passive: true };
    const cap = { capture: true };

    // iOS は「どのイベントが user activation になるか」が端末/OS で揺れるので多めに張る
    try { window.addEventListener('pointerdown', this._onGestureUnlock, passiveCap); } catch {}
    try { window.addEventListener('pointerup', this._onGestureUnlock, passiveCap); } catch {}
    try { window.addEventListener('touchstart', this._onGestureUnlock, passiveCap); } catch {}
    try { window.addEventListener('touchend', this._onGestureUnlock, passiveCap); } catch {}
    try { window.addEventListener('mousedown', this._onGestureUnlock, passiveCap); } catch {}
    try { window.addEventListener('mouseup', this._onGestureUnlock, passiveCap); } catch {}
    try { window.addEventListener('click', this._onGestureUnlock, cap); } catch {}
    try { window.addEventListener('keydown', this._onGestureUnlock, cap); } catch {}
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
   */
  async preload(key) {
    const resolved = this._resolveKey(key);
    const def = SOUND_DEFS?.[resolved];
    if (!def || !def.url) return false;

    this._ensureAudioGraph();
    this.installUnlockHandlers();

    // HTML fallback の base も用意しておく（作成だけ。再生しない）
    try { this._ensureHtmlBase(def.url); } catch {}

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
   */
  async play(key, opts = {}) {
    const resolved = this._resolveKey(key);
    const def = SOUND_DEFS?.[resolved];
    if (!def || !def.url) return false;

    const baseVol = (def.category === 'env') ? this._envVol : this._sfxVol;
    if (baseVol <= 0) return false;

    this._ensureAudioGraph();
    this.installUnlockHandlers();

    // 画面ロック復帰などで suspended に戻った場合の best-effort（ユーザー操作外だと弾かれることもある）
    try {
      if (this._ctx && this._ctx.state !== 'running' && typeof this._ctx.resume === 'function') {
        await this._ctx.resume();
      }
    } catch {}

    // unlock されていなければキュー（unlock 後に再生）
    if (!this._unlocked || !this._ctx || this._ctx.state !== 'running') {
      this._pending.push({ key: resolved, at: Date.now(), opts });
      return false;
    }

    // iOS Safari は WebAudio が端末差で不安定なことがあるので、iOS は基本 HTMLAudio を優先。
    // （forceHtml は任意の端末で強制できる）
    const preferHtml = !!opts?.forceHtml || this._isIOS;
    if (preferHtml) {
      try {
        this._playHtml(def.url, baseVol, opts?.volumeMul);
        return true;
      } catch {
        // fallback to WebAudio
      }
    }

    try {
      const buf = await this._loadBuffer(def.url);
      if (!buf || !this._ctx) return false;

      const src = this._ctx.createBufferSource();
      src.buffer = buf;

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
      // 効果音は HTMLAudio に fallback
      try {
        if (def?.category === 'sfx') {
          this._playHtml(def.url, baseVol, opts?.volumeMul);
          return true;
        }
      } catch {}
      try { console.warn('[sound] play failed:', resolved, e); } catch {}
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
    // iOS Safari: 稀に AudioContext が closed になって復帰しないケースがある
    try {
      if (this._ctx && this._ctx.state === 'closed') {
        this._ctx = null;
        this._envGain = null;
        this._sfxGain = null;
        this._unlocked = false;
        this._primed = false;
        this._primeHtmlDone = false;
      }
    } catch {}

    if (this._ctx && this._envGain && this._sfxGain) return;

    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;

    this._ctx = this._ctx || new Ctx();

    this._envGain = this._envGain || this._ctx.createGain();
    this._sfxGain = this._sfxGain || this._ctx.createGain();
    this._envGain.gain.value = this._envVol;
    this._sfxGain.gain.value = this._sfxVol;

    try { this._envGain.connect(this._ctx.destination); } catch {}
    try { this._sfxGain.connect(this._ctx.destination); } catch {}
  }

  _ensureHtmlBase(url) {
    if (!url) return null;
    if (this._htmlBase.has(url)) return this._htmlBase.get(url);

    const a = new Audio(url);
    a.preload = 'auto';
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

    const a = base.cloneNode(true);
    a.volume = vol;
    try { a.currentTime = 0; } catch {}
    try {
      const p = a.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
  }

  _onGestureUnlock() {
    // iOS Safari: "resume" だけだと、その後の非ジェスチャー再生がブロックされる端末がある。
    // ここで「ユーザー操作中に」無音の発音（prime）を 1回だけ行う。
    try {
      this._ensureAudioGraph();
      if (!this._ctx) return;

      // resume は user activation がある時に呼ぶ
      try { this._ctx.resume?.(); } catch {}

      // 重要: prime は "このコールスタック内" で行う（then/catch で遅らせると iOS で効かないことがある）
      this._primeWebAudioInGesture();
      this._primeHtmlInGesture();

      this._scheduleUnlockCheck();
    } catch (e) {
      try { console.warn('[sound] unlock failed:', e); } catch {}
    }
  }

  _scheduleUnlockCheck() {
    if (this._unlockCheckScheduled) return;
    this._unlockCheckScheduled = true;

    const check = () => {
      this._unlockCheckScheduled = false;
      try {
        this._unlocked = !!(this._ctx && this._ctx.state === 'running');
        if (this._unlocked && this._pending.length) {
          // pending は非同期で消化（大量 decode を user gesture callstack に載せない）
          this._flushPending();
        }
      } catch {}
    };

    // 状態遷移のタイミング差を吸収
    try { Promise.resolve().then(check); } catch {}
    try { setTimeout(check, 0); } catch {}
    try { setTimeout(check, 80); } catch {}
  }

  _primeWebAudioInGesture() {
    if (this._primed) return;
    if (!this._ctx) return;
    this._primed = true;

    // 無音の "1サンプル" を鳴らす（gain=0）。
    // AudioContext が suspended のままでも start は許されることがあり、
    // running に遷移した瞬間に "ユーザー操作由来" の音として扱われる。
    try {
      const ctx = this._ctx;
      const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(g);
      g.connect(ctx.destination);

      const t = ctx.currentTime;
      src.start(t);
      try { src.stop(t + 0.01); } catch {}
    } catch {}
  }

  _primeHtmlInGesture() {
    if (this._primeHtmlDone) return;
    this._primeHtmlDone = true;

    // HTMLAudio も 1回だけ無音再生しておく（WebAudio が不調な端末向け）
    try {
      const url = this._pickPrimeUrl();
      if (!url) return;
      const a = new Audio(url);
      a.preload = 'auto';
      try { a.playsInline = true; } catch {}
      a.volume = 0;
      // muted=true だと "unlock" として扱われない端末があるため付けない
      const p = a.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
  }

  _pickPrimeUrl() {
    try {
      // できれば短い効果音を使う
      const pref = ['piece_action', 'room_enter', 'room_exit', 'login'];
      for (const k of pref) {
        const d = SOUND_DEFS?.[k];
        if (d?.url) return d.url;
      }
      const keys = Object.keys(SOUND_DEFS || {});
      for (const k of keys) {
        const d = SOUND_DEFS?.[k];
        if (d?.url) return d.url;
      }
      return null;
    } catch {
      return null;
    }
  }

  async _flushPending() {
    if (!this._pending.length) return;
    const q = this._pending.splice(0, this._pending.length);

    const now = Date.now();
    for (const item of q) {
      if (!item || !item.key) continue;
      if ((now - (item.at || now)) > 15000) continue;
      await this.play(item.key, item.opts || {});
    }
  }

  async _loadBuffer(url) {
    if (this._bufferCache.has(url)) return this._bufferCache.get(url);
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
    try {
      if ('caches' in window) {
        const cache = await caches.open(CACHE_NAME);
        const hit = await cache.match(url);
        if (hit) return await hit.arrayBuffer();

        const res = await fetch(url, { cache: 'force-cache' });
        if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
        try { await cache.put(url, res.clone()); } catch {}
        return await res.arrayBuffer();
      }
    } catch (e) {
      try { console.warn('[sound] cache fetch failed, fallback:', e); } catch {}
    }

    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    return await res.arrayBuffer();
  }

  _decode(arrayBuffer) {
    return new Promise((resolve, reject) => {
      if (!this._ctx) return reject(new Error('no audio context'));

      try {
        const p = this._ctx.decodeAudioData(arrayBuffer);
        if (p && typeof p.then === 'function') {
          p.then(resolve).catch(reject);
          return;
        }
      } catch {}

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
