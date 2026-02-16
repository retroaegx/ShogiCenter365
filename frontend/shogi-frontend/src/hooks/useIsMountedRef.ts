import { useEffect, useRef } from 'react';

/** isMountedRef: set to false on unmount. */
export function useIsMountedRef() {
  const ref = useRef(true);
  useEffect(() => {
    return () => { ref.current = false; };
  }, []);
  return ref;
}
