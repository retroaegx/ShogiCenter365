// src/sound/SoundManager.js
import { SOUND_CONFIG } from '@/config/sounds';

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const volToGain = (vol0to100) => {
  const n = Number(vol0to100);
  if (!Number.isFinite(n)) return 0.5;
  return clamp01(n / 100);
};

export default class SoundManager {
  constructor() {
    this._ctx = null;
    this._envGain = null;
    this._sfxGain = null;

    this._envVol100 = 50;
    this._sfxVol100 = 50;

    this._buffers = new Map();     // url -> AudioBuffer
    this._loading = new Map();     // url -> Promise<AudioBuffer>
    this._cacheName = 'shogi-audio-v1';
  }

  _getAudioContextCtor() {
    if (typeof window === 'undefined') return null;
    return window.AudioContext || window.webkitAudioContext || null;
  }

  async _ensureContext() {
    if (this._ctx) return this._ctx;
    const Ctor = this._getAudioContextCtor();
    if (!Ctor) return null;

    const ctx = new Ctor();

    const envGain = ctx.createGain();
    envGain.gain.value = volToGain(this._envVol100);
    envGain.connect(ctx.destination);

    const sfxGain = ctx.createGain();
    sfxGain.gain.value = volToGain(this._sfxVol100);
    sfxGain.connect(ctx.destination);

    this._ctx = ctx;
    this._envGain = envGain;
    this._sfxGain = sfxGain;
    return ctx;
  }

  setEnvVolume(vol0to100) {
    this._envVol100 = Number.isFinite(Number(vol0to100)) ? Number(vol0to100) : this._envVol100;
    try { if (this._envGain) this._envGain.gain.value = volToGain(this._envVol100); } catch {}
  }

  setSfxVolume(vol0to100) {
    this._sfxVol100 = Number.isFinite(Number(vol0to100)) ? Number(vol0to100) : this._sfxVol100;
    try { if (this._sfxGain) this._sfxGain.gain.value = volToGain(this._sfxVol100); } catch {}
  }

  async unlock() {
    const ctx = await this._ensureContext();
    if (!ctx) return false;
    try {
      if (ctx.state === 'suspended') await ctx.resume();
      return ctx.state === 'running';
    } catch {
      return false;
    }
  }

  async _fetchArrayBuffer(url) {
    // 1) Cache Storage（永続キャッシュ）を優先
    try {
      if (typeof caches !== 'undefined' && caches?.open) {
        const cache = await caches.open(this._cacheName);
        const hit = await cache.match(url);
        if (hit && hit.ok) return await hit.arrayBuffer();

        const res = await fetch(url, { cache: 'force-cache' });
        if (res && res.ok) {
          try { await cache.put(url, res.clone()); } catch {}
          return await res.arrayBuffer();
        }
      }
    } catch {}

    // 2) fallback（通常の HTTP キャッシュに任せる）
    const res = await fetch(url, { cache: 'force-cache' });
    if (!res || !res.ok) throw new Error(`sound fetch failed: ${url}`);
    return await res.arrayBuffer();
  }

  async _loadBuffer(url) {
    if (!url) return null;
    if (this._buffers.has(url)) return this._buffers.get(url);
    if (this._loading.has(url)) return await this._loading.get(url);

    const p = (async () => {
      const ctx = await this._ensureContext();
      if (!ctx) return null;

      const ab = await this._fetchArrayBuffer(url);
      // decodeAudioData は ArrayBuffer を破壊的に読む実装があるため slice する
      const buf = await ctx.decodeAudioData(ab.slice(0));
      this._buffers.set(url, buf);
      this._loading.delete(url);
      return buf;
    })().catch((e) => {
      try { console.warn('[sound] load failed', url, e); } catch {}
      this._loading.delete(url);
      return null;
    });

    this._loading.set(url, p);
    return await p;
  }

  async play(key, typeOverride = null) {
    try {
      const cfg = SOUND_CONFIG[key];
      if (!cfg) return null;
      const type = typeOverride || cfg.type || 'sfx';
      const url = cfg.src;

      const ctx = await this._ensureContext();
      if (!ctx) return null;

      const buffer = await this._loadBuffer(url);
      if (!buffer) return null;

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      if (cfg.loop) src.loop = true;

      const node = (type === 'env') ? this._envGain : this._sfxGain;
      if (!node) return null;
      src.connect(node);
      src.start(0);
      return src;
    } catch (e) {
      try { console.warn('[sound] play failed', key, e); } catch {}
      return null;
    }
  }

  async preloadAll() {
    try {
      const keys = Object.keys(SOUND_CONFIG || {});
      await Promise.all(keys.map((k) => {
        const url = SOUND_CONFIG[k]?.src;
        return this._loadBuffer(url);
      }));
    } catch {}
  }
}
