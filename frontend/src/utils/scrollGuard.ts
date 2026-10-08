/**
 * useScrollGuard — stop "tap to scroll" from focusing a TextInput.
 *
 * On screens whose ScrollView contains large (multiline) inputs, a tap meant to
 * stop scroll momentum — or a micro-drag — lands on the input, instantly opens
 * the keyboard and jumps the field to the cursor. The guard tracks whether a
 * scroll gesture/momentum is in flight (in a ref — no re-renders) and, while it
 * is, captures touches on the content wrapper so they stop the scroll without
 * reaching any input/button beneath. A tap on a *still* page behaves normally.
 *
 * Usage:
 *   const { scrollProps, contentProps } = useScrollGuard();
 *   <ScrollView {...scrollProps}>
 *     <View {...contentProps}>…screen content…</View>
 *   </ScrollView>
 */
import { useRef, useMemo } from 'react';

// How long after the last scroll event touches stay guarded. Momentum-end and
// the finishing tap race each other, so give the tap a small window to land
// while still guarded.
const RELEASE_MS = 150;

export function useScrollGuard() {
  const scrolling = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  return useMemo(() => {
    const hold = () => {
      if (timer.current) clearTimeout(timer.current);
      scrolling.current = true;
    };
    const release = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => { scrolling.current = false; }, RELEASE_MS);
    };
    return {
      scrollProps: {
        onScrollBeginDrag: hold,
        onMomentumScrollBegin: hold,
        onScrollEndDrag: release,
        onMomentumScrollEnd: release,
      },
      contentProps: {
        onStartShouldSetResponderCapture: () => scrolling.current,
      },
    };
  }, []);
}
