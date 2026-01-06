import React, { createContext, useContext, useMemo, useRef, useEffect } from 'react';
import SoundManager from '@/sound/SoundManager';

const SoundContext = createContext(null);

export const SoundProvider = ({ children }) => {
  const mgrRef = useRef(null);
  if (!mgrRef.current) mgrRef.current = new SoundManager();

  // iOS/Safari 対策：最初のユーザー操作で AudioContext を解放
  useEffect(() => {
    const unlockOnce = async () => {
      try { await mgrRef.current.unlock(); } catch {}
      // 初回操作後に必要音をデコードしておく（ダウンロードは Cache Storage を使う）
      try { await mgrRef.current.preloadAll(); } catch {}
    };

    try { window.addEventListener('pointerdown', unlockOnce, { once: true, passive: true }); } catch {}
    try { window.addEventListener('keydown', unlockOnce, { once: true }); } catch {}

    return () => {
      try { window.removeEventListener('pointerdown', unlockOnce); } catch {}
      try { window.removeEventListener('keydown', unlockOnce); } catch {}
    };
  }, []);

  const api = useMemo(() => {
    return {
      play: (key) => mgrRef.current.play(key),
      playEnv: (key) => mgrRef.current.play(key, 'env'),
      playSfx: (key) => mgrRef.current.play(key, 'sfx'),
      preloadAll: () => mgrRef.current.preloadAll(),
      unlock: () => mgrRef.current.unlock(),
      setEnvVolume: (v) => mgrRef.current.setEnvVolume(v),
      setSfxVolume: (v) => mgrRef.current.setSfxVolume(v),
    };
  }, []);

  return (
    <SoundContext.Provider value={api}>
      {children}
    </SoundContext.Provider>
  );
};

export const useSound = () => {
  const ctx = useContext(SoundContext);
  // Provider が無い場合も落ちないようにする
  return ctx || {
    play: async () => null,
    playEnv: async () => null,
    playSfx: async () => null,
    preloadAll: async () => null,
    unlock: async () => null,
    setEnvVolume: () => {},
    setSfxVolume: () => {},
  };
};
