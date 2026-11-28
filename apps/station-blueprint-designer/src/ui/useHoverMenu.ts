import { useCallback, useEffect, useRef, useState } from 'react';

interface UseHoverMenuOptions {
  openDelayMs?: number;
  closeDelayMs?: number;
}

/**
 * Pure hover-presence popover controller for CAD toolbar menus.
 * - Hovering opens smoothly after a short intent delay so sweeping across the
 *   topbar never flickers adjacent menus open.
 * - Leaving waits briefly (paired with a CSS ::before bridge) so moving into
 *   the popover never drops focus.
 * - Clicking the trigger ensures the menu stays open (for touch / fast-click
 *   accessibility) and NEVER closes an already-open hovered menu.
 */
export function useHoverMenu(options: UseHoverMenuOptions = {}) {
  const { openDelayMs = 60, closeDelayMs = 160 } = options;
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

  const isTouchLike = () =>
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(hover: none), (pointer: coarse)').matches;

  const toggle = useCallback(() => {
    clearTimers();
    setOpenState((v) => !v);
  }, [clearTimers]);

  const onTriggerClick = useCallback(() => {
    clearTimers();
    if (isTouchLike()) {
      setOpenState((v) => !v);
    } else {
      setOpenState(true);
    }
  }, [clearTimers]);

  const onMouseEnter = useCallback(() => {
    if (isTouchLike()) return;
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
    if (isTouchLike()) return;
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

  useEffect(() => clearTimers, [clearTimers]);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        close();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', onDocDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDocDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  return {
    open,
    setOpen,
    close,
    toggle,
    wrapRef,
    containerProps: {
      onMouseEnter,
      onMouseLeave,
    },
    onTriggerClick,
  };
}
