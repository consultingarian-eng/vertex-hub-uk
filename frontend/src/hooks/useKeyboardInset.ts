/**
 * useKeyboardInset — how many pixels of the screen bottom the soft keyboard
 * currently covers (0 when hidden).
 *
 * Use it as extra `paddingBottom` on scrollable lists that sit under a search
 * input, so filtered results never hide behind the keyboard, and to lift
 * bottom-sheets above it.
 *
 * Platform notes:
 * - iOS: the window never resizes, so we track the RN Keyboard events
 *   (`keyboardWillShow/Hide` for smooth timing).
 * - Android: Expo's default `softwareKeyboardLayoutMode: "resize"` already
 *   shrinks the window, so adding padding again would double it → return 0.
 * - Web (mobile browsers): the virtual keyboard shrinks `visualViewport`
 *   but NOT `window.innerHeight`; the difference is the overlap.
 */
import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (Platform.OS === 'android') return;

    if (Platform.OS === 'web') {
      const vv = typeof window !== 'undefined' ? window.visualViewport : null;
      if (!vv) return;
      const onResize = () => {
        const overlap = window.innerHeight - vv.height - vv.offsetTop;
        setInset(overlap > 40 ? Math.round(overlap) : 0);
      };
      vv.addEventListener('resize', onResize);
      vv.addEventListener('scroll', onResize);
      onResize();
      return () => {
        vv.removeEventListener('resize', onResize);
        vv.removeEventListener('scroll', onResize);
      };
    }

    const showSub = Keyboard.addListener('keyboardWillShow', (e) => {
      setInset(e.endCoordinates?.height ?? 0);
    });
    const hideSub = Keyboard.addListener('keyboardWillHide', () => setInset(0));
    // Fallback for contexts where the will* events don't fire.
    const didShowSub = Keyboard.addListener('keyboardDidShow', (e) => {
      setInset(e.endCoordinates?.height ?? 0);
    });
    const didHideSub = Keyboard.addListener('keyboardDidHide', () => setInset(0));
    return () => {
      showSub.remove();
      hideSub.remove();
      didShowSub.remove();
      didHideSub.remove();
    };
  }, []);

  return inset;
}

/**
 * useWebViewportPin — keep the page pinned to the top of the layout viewport
 * while `active` (e.g. a modal with text inputs is open). iOS WebKit pans the
 * whole document to reveal a focused input even when the body is fixed and
 * overflow:hidden, and often fails to pan back after the keyboard closes —
 * leaving the app shifted with the header (and its close button) stranded
 * off-screen until the PWA is relaunched. Scrolling back to 0 on every
 * viewport change undoes the pan; the caller is expected to lift its own
 * content above the keyboard (see useKeyboardInset) so WebKit has no hidden
 * caret left to chase. No-op on native.
 */
export function useWebViewportPin(active: boolean) {
  useEffect(() => {
    if (Platform.OS !== 'web' || !active || typeof window === 'undefined') return;
    const pin = () => {
      if (window.scrollY !== 0 || (window.visualViewport?.offsetTop ?? 0) !== 0) {
        window.scrollTo(0, 0);
      }
    };
    const vv = window.visualViewport;
    window.addEventListener('scroll', pin);
    vv?.addEventListener('resize', pin);
    vv?.addEventListener('scroll', pin);
    pin();
    return () => {
      window.removeEventListener('scroll', pin);
      vv?.removeEventListener('resize', pin);
      vv?.removeEventListener('scroll', pin);
      window.scrollTo(0, 0);
    };
  }, [active]);
}

/**
 * Dismiss the keyboard if it is open. Returns true when a dismissal happened —
 * lets backdrop-tap handlers close the keyboard on the first tap and the
 * sheet itself only on the next one.
 */
export function dismissKeyboardIfOpen(keyboardInset: number): boolean {
  if (Platform.OS !== 'web') {
    if (Keyboard.isVisible()) {
      Keyboard.dismiss();
      return true;
    }
    return false;
  }
  // Web: blur the focused input; report handled when the keyboard was up.
  const active = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
  const isInput = !!active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
  if (isInput) active!.blur();
  return isInput && keyboardInset > 0;
}
