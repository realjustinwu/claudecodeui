import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useVisualViewportKeyboardOffset } from '@/modules/project-workspace/hooks/useVisualViewportKeyboardOffset';

/**
 * Minimal visualViewport stand-in: a real EventTarget carrying the viewport
 * metrics the hook reads, so tests can fire the same events iOS Safari does.
 */
function createVisualViewportStub() {
  const target = new EventTarget() as EventTarget & {
    height: number;
    offsetTop: number;
  };
  target.height = window.innerHeight;
  target.offsetTop = 0;
  return target;
}

function setViewportMetrics(viewport: ReturnType<typeof createVisualViewportStub>, height: number, offsetTop: number) {
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);
  viewport.height = height;
  viewport.offsetTop = offsetTop;
}

describe('useVisualViewportKeyboardOffset', () => {
  let viewport: ReturnType<typeof createVisualViewportStub>;

  beforeEach(() => {
    vi.useFakeTimers();
    viewport = createVisualViewportStub();
    vi.stubGlobal('visualViewport', viewport);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('clears both custom properties when no keyboard is open', () => {
    setViewportMetrics(viewport, 800, 0);

    renderHook(() => useVisualViewportKeyboardOffset());
    viewport.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(1000);

    expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('0px');
    expect(document.documentElement.style.getPropertyValue('--shell-transform')).toBe('');
  });

  it('shrinks the shell by the keyboard height when iOS overlays the keyboard', () => {
    setViewportMetrics(viewport, 465, 0);

    renderHook(() => useVisualViewportKeyboardOffset());
    viewport.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(1000);

    expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('335px');
    expect(document.documentElement.style.getPropertyValue('--shell-transform')).toBe('');
  });

  it('cancels the visual-viewport pan iOS applies to reveal the focused input', () => {
    setViewportMetrics(viewport, 465, 335);

    renderHook(() => useVisualViewportKeyboardOffset());
    // iOS pans via the visual viewport, which surfaces as a `scroll` event.
    viewport.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(1000);

    expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('335px');
    expect(document.documentElement.style.getPropertyValue('--shell-transform')).toBe(
      'translateY(335px)'
    );
  });

  it('re-samples late viewport changes that iOS reports after the event', () => {
    setViewportMetrics(viewport, 800, 0);

    renderHook(() => useVisualViewportKeyboardOffset());
    viewport.dispatchEvent(new Event('resize'));
    // The first sample still sees the pre-keyboard metrics, as on iOS 18 where
    // the resize event can fire before the keyboard settles.
    expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('0px');

    setViewportMetrics(viewport, 465, 0);
    vi.advanceTimersByTime(500);

    expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('335px');
  });

  it('restores the shell when the keyboard closes', () => {
    setViewportMetrics(viewport, 465, 335);

    renderHook(() => useVisualViewportKeyboardOffset());
    viewport.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(1000);

    setViewportMetrics(viewport, 800, 0);
    document.dispatchEvent(new Event('focusout'));
    vi.advanceTimersByTime(1000);

    expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('0px');
    expect(document.documentElement.style.getPropertyValue('--shell-transform')).toBe('');
  });

  it('removes the custom properties on unmount', () => {
    setViewportMetrics(viewport, 465, 0);

    const { unmount } = renderHook(() => useVisualViewportKeyboardOffset());
    viewport.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(1000);

    unmount();

    expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--shell-transform')).toBe('');
  });
});
