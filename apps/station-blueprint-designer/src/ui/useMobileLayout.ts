import { useEffect, useState } from 'react';

export interface MobileLayoutState {
  /** Compact mobile layout (phones & narrow portrait/landscape touch viewports). */
  isMobile: boolean;
  /** Coarse primary pointer (touchscreen devices). */
  isCoarsePointer: boolean;
}

const MOBILE_QUERY = '(max-width: 820px), ((max-height: 520px) and (pointer: coarse))';
const COARSE_QUERY = '(pointer: coarse), (hover: none)';

function queryMatches(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(query).matches;
}

export function useMobileLayout(): MobileLayoutState {
  const [state, setState] = useState<MobileLayoutState>(() => ({
    isMobile: queryMatches(MOBILE_QUERY),
    isCoarsePointer: queryMatches(COARSE_QUERY),
  }));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mqMobile = window.matchMedia(MOBILE_QUERY);
    const mqCoarse = window.matchMedia(COARSE_QUERY);
    const sync = () => {
      const nextMobile = mqMobile.matches;
      const nextCoarse = mqCoarse.matches;
      setState((prev) =>
        prev.isMobile === nextMobile && prev.isCoarsePointer === nextCoarse
          ? prev
          : { isMobile: nextMobile, isCoarsePointer: nextCoarse }
      );
    };
    sync();
    mqMobile.addEventListener('change', sync);
    mqCoarse.addEventListener('change', sync);
    return () => {
      mqMobile.removeEventListener('change', sync);
      mqCoarse.removeEventListener('change', sync);
    };
  }, []);

  return state;
}
