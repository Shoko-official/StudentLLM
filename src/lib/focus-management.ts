import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/**
 * Closes a popup menu on outside pointerdown and on Escape (returning focus to `returnFocusRef`),
 * and whenever `closeSignal` becomes true (for example when a modal opens).
 */
export function useDismissibleMenu(
  isOpen: boolean,
  containerRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  returnFocusRef: RefObject<HTMLElement | null>,
  closeSignal = false,
) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (isOpen && closeSignal) onCloseRef.current();
  }, [isOpen, closeSignal]);
  useEffect(() => {
    if (!isOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && containerRef.current?.contains(event.target)) return;
      onCloseRef.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      onCloseRef.current();
      returnFocusRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen, containerRef, returnFocusRef]);
}
