import { useCallback, useEffect, useRef, useState } from 'react';

interface UseHoverMenuOptions {
  openDelayMs?: number;
  closeDelayMs?: number;
}

/**
 * Unified hover-intent + click-toggle popover controller for CAD toolbar menus.
 * - Hovering opens smoothly after a short intent delay so sweeping across the
 *   topbar never flickers adjacent menus open.
 * - Leaving waits briefly (paired with a CSS ::before bridge) so moving into
 *   the popover never drops focus.
 * - Clicking still toggles immediately for touch / explicit keyboard / pin use.
 */
export function useHoverMenu(options: UseHoverMenuOptions = {}) {
  const { openDelayMs = 70, closeDelayMs = 160 } = options;
  const [open, setOpenState] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const setOpen = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      clearTimers();
      setOpenState(next);
    },
    [clearTimers]
  );

  const close = useCallback(() => {
    clearTimers();
    setOpenState(false);
  }, [clearTimers]);

  const onMouseEnter = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (openTimerRef.current === null) {
      openTimerRef.current = window.setTimeout(() => {
        openTimerRef.current = null;
        setOpenState(true);
      }, openDelayMs);
    }
  }, [openDelayMs]);

  const onMouseLeave = useCallback(() => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current === null) {
      closeTimerRef.current = window.setTimeout(() => {
        closeTimerRef.current = null;
        setOpenState(false);
      }, closeDelayMs);
    }
  }, [closeDelayMs]);

  const onTriggerClick = useCallback(() => {
    clearTimers();
    setOpenState((v) => !v);
  }, [clearTimers]);

  useEffect(() => clearTimers, [clearTimers]);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        close();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('mousedown', onDocDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDocDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  return {
    open,
    setOpen,
    close,
    wrapRef,
    containerProps: {
      onMouseEnter,
      onMouseLeave,
    },
    onTriggerClick,
  };
}
