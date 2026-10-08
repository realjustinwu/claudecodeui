import { useEffect } from 'react';

/** Delays (ms) at which the viewport reading is re-sampled after an event; iOS keeps mutating the visual viewport while the keyboard animates in. */
const KEYBOARD_SETTLE_DELAYS_MS = [250, 500, 1000];

/**
 * Keeps the fixed workspace shell aligned with the visual viewport while the
 * on-screen keyboard is open in iOS Safari. Consumed by ProjectWorkspaceShell
 * through two document-level custom properties:
 *
 * - `--keyboard-height`: how far the keyboard overlaps the layout viewport
 *   (`window.innerHeight` stays unchanged on iOS while the keyboard overlays
 *   it), so the shell can shrink from the bottom and keep the composer above
 *   the keyboard.
 * - `--shell-transform`: iOS additionally pans the visual viewport
 *   (`visualViewport.offsetTop > 0`) to reveal the focused input, which drags
 *   fixed-position content up out of view. A `translateY` of that offset
 *   cancels the pan so the shell stays pinned to the visible top edge. Only
 *   set while panned — a constant `translateY(0px)` would still create a
 *   containing block and change how nested fixed menus are positioned.
 *
 * iOS (notably 18 with the floating autofill bar) often reports the viewport
 * change late or drops the `resize` event entirely, so every trigger also
 * re-samples the values on a short timer until the state settles.
 */
export function useVisualViewportKeyboardOffset() {
  useEffect(() => {
    const documentElement = document.documentElement;
    const visualViewport = window.visualViewport;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const updateKeyboardOffset = () => {
      if (!visualViewport) {
        return;
      }
      const keyboardHeight = Math.max(0, window.innerHeight - visualViewport.height);
      documentElement.style.setProperty('--keyboard-height', `${keyboardHeight}px`);
      if (visualViewport.offsetTop > 0) {
        documentElement.style.setProperty(
          '--shell-transform',
          `translateY(${visualViewport.offsetTop}px)`
        );
      } else {
        documentElement.style.removeProperty('--shell-transform');
      }
    };

    // Applies immediately, then re-checks while the keyboard animation and any
    // visual-viewport pan settle (events can arrive before the final values).
    const scheduleKeyboardOffsetUpdate = () => {
      updateKeyboardOffset();
      timers.forEach(clearTimeout);
      timers.length = 0;
      KEYBOARD_SETTLE_DELAYS_MS.forEach((delay) => {
        timers.push(setTimeout(updateKeyboardOffset, delay));
      });
    };

    // `scroll` on the visual viewport fires when iOS pans it for the focused
    // input; `focusin`/`focusout` cover WebKit builds that skip the resize event.
    visualViewport?.addEventListener('resize', scheduleKeyboardOffsetUpdate);
    visualViewport?.addEventListener('scroll', scheduleKeyboardOffsetUpdate);
    window.addEventListener('resize', scheduleKeyboardOffsetUpdate);
    document.addEventListener('focusin', scheduleKeyboardOffsetUpdate);
    document.addEventListener('focusout', scheduleKeyboardOffsetUpdate);

    return () => {
      visualViewport?.removeEventListener('resize', scheduleKeyboardOffsetUpdate);
      visualViewport?.removeEventListener('scroll', scheduleKeyboardOffsetUpdate);
      window.removeEventListener('resize', scheduleKeyboardOffsetUpdate);
      document.removeEventListener('focusin', scheduleKeyboardOffsetUpdate);
      document.removeEventListener('focusout', scheduleKeyboardOffsetUpdate);
      timers.forEach(clearTimeout);
      documentElement.style.removeProperty('--keyboard-height');
      documentElement.style.removeProperty('--shell-transform');
    };
  }, []);
}
