/**
 * Tiny hook for orientation-aware UI.
 *
 * Returns `true` only for a PHONE held in landscape — a wide but SHORT
 * viewport. Callers use it to hide chrome (top tab pills, screen titles,
 * action buttons) so the actual content gets the full screen, which is worth
 * doing on an iPhone where landscape leaves ~400pt of height and the notch /
 * Dynamic Island intrudes into the side.
 *
 * Orientation alone is not that test. A desktop browser window is nearly
 * always wider than tall, so `width > height` (and CSS `orientation:
 * landscape`, which is defined the same way) is permanently true on a Mac —
 * and every screen rendered as if it were a rotated phone. On Chrome/macOS
 * that hid the tab header and, on the Schedule tab, the office switcher and
 * the Add button, with no way to get them back. Requiring a short viewport as
 * well keeps the phone behaviour and leaves roomy windows (desktop, tablet)
 * with their normal chrome.
 *
 * Web/PWA: window dimensions can be transiently bogus during cold launch (iOS
 * standalone reports a 0/tiny height before the viewport settles), which made
 * width > height briefly "landscape" and stripped the header, titles and
 * action buttons until a reload. matchMedia is authoritative for orientation
 * there, with a change listener for real rotations; the height floor below
 * keeps an unsettled viewport from re-triggering that same strip.
 */
import { useEffect, useState } from 'react';
import { Platform, useWindowDimensions } from 'react-native';

/** Tallest a landscape phone gets — iPhone 15 Pro Max is 430pt on its side. */
const PHONE_LANDSCAPE_MAX_HEIGHT = 500;
/** Shorter than any real device: the viewport hasn't settled yet. */
const SETTLED_MIN_HEIGHT = 200;

export function useIsLandscape(): boolean {
  const { width, height } = useWindowDimensions();
  const [webLandscape, setWebLandscape] = useState<boolean | null>(null);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(orientation: landscape)');
    const update = () => setWebLandscape(mq.matches);
    update();
    if (mq.addEventListener) {
      mq.addEventListener('change', update);
      return () => mq.removeEventListener('change', update);
    }
    // Older iOS Safari: addListener/removeListener only
    mq.addListener(update);
    return () => mq.removeListener(update);
  }, []);

  const landscapeOrientation =
    Platform.OS === 'web' && webLandscape !== null
      ? webLandscape
      : // Unsettled dimensions (0/undefined) → default to portrait rather than
        // stripping the UI chrome.
        !!width && !!height && width > height;

  if (!landscapeOrientation) return false;
  // A height outside the plausible phone-landscape band is either a roomy
  // window (desktop/tablet — keep the chrome) or a viewport still settling
  // (keep the chrome rather than flashing it away).
  if (!height || height < SETTLED_MIN_HEIGHT) return false;
  return height <= PHONE_LANDSCAPE_MAX_HEIGHT;
}
