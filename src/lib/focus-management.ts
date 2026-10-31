import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

const FOCUSABLE_SELECTOR = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

function isFocusable(element: HTMLElement) {
  if (!element.isConnected) return false;
  // Elements inside a closed <details> are not rendered, so they cannot take focus.
  const details = element.closest('details');
  if (details && !details.open && !element.closest('summary')) return false;
  return true;
}

/** Where focus should return: the opener itself, or the summary of the closed menu that hosted it. */
export function resolveFocusReturnTarget(opener: HTMLElement | null): HTMLElement | null {
  if (!opener) return null;
  if (isFocusable(opener)) return opener;
  const summary = opener.closest('details')?.querySelector<HTMLElement>('summary');
  return summary && summary.isConnected ? summary : null;
}

/** Tracks the last focused element outside any dialog, because autofocus moves focus before effects run. */
function useLastFocusedOutsideDialog() {
  const lastRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target === document.body) return;
      if (target.closest('[role="dialog"]')) return;
      lastRef.current = target;
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, []);
  return lastRef;
}

/**
 * Modal dialog focus management: moves focus into the open dialog (autofocus control, else the first
 * control outside the header, else the dialog itself), traps Tab, and restores focus to the opener on close.
 * Change `dialogKey` when a different dialog becomes the top one while another stays open.
 */
export function useDialogFocus(isOpen: boolean, dialogKey = '') {
  const lastOutsideRef = useLastFocusedOutsideDialog();
  useEffect(() => {
    if (!isOpen) return undefined;
    // With a dialog stacked on another (Settings, then Licences) the one rendered last is on top and gets the focus.
    const dialog = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).pop();
    if (!dialog) return undefined;
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && active !== document.body && !dialog.contains(active) ? active : lastOutsideRef.current;
    const focusableElements = () => Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (!dialog.contains(document.activeElement)) {
      const explicit = dialog.querySelector<HTMLElement>('[autofocus], [data-autofocus]');
      const firstContent = focusableElements().find((element) => !element.closest('.modal-header'));
      const target = explicit ?? firstContent;
      if (target) target.focus();
      else {
        if (!dialog.hasAttribute('tabindex')) dialog.tabIndex = -1;
        dialog.focus();
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const elements = focusableElements();
      if (!elements.length) {
        event.preventDefault();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener('keydown', onKeyDown);
    return () => {
      dialog.removeEventListener('keydown', onKeyDown);
      // Only a dialog that is gone gives focus back. A dialog that merely lost the top place to another one stays put.
      if (!dialog.isConnected) resolveFocusReturnTarget(opener)?.focus();
    };
  }, [isOpen, dialogKey, lastOutsideRef]);
}

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
