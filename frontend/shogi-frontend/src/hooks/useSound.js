import { useMemo } from 'react';
import soundManager from '@/services/soundManager';

/**
 * React から使うための薄いラッパ。
 * - useSound() 自体は state を持たず、singleton を返すだけ。
 */
export default function useSound() {
  return useMemo(() => {
    return {
      installUnlockHandlers: () => soundManager.installUnlockHandlers(),
      setEnvVolume: (v) => soundManager.setEnvVolume(v),
      setSfxVolume: (v) => soundManager.setSfxVolume(v),

      has: (key) => soundManager.has?.(key) ?? false,
      preload: (key) => soundManager.preload?.(key),
      preloadAll: () => soundManager.preloadAll?.(),

      // category は SOUND_DEFS 側で決める（env/sfx どちらでも同じ API）
      playEnv: (key, opts) => soundManager.play(key, opts),
      playSfx: (key, opts) => soundManager.play(key, opts),
      play: (key, opts) => soundManager.play(key, opts),
    };
  }, []);
}
