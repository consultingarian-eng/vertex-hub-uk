/**
 * WebPullToRefresh — pull-to-refresh for the web app / installed PWA.
 *
 * React Native's RefreshControl is a no-op on web, and the PWA's fixed layout
 * also disables the browser's own pull-to-refresh — so there was no way to
 * refresh data on the web/home-screen app. This mounts once at the root (web
 * only) and, when the user drags down at the top of the on-screen scroller,
 * re-fetches every currently-active React Query (i.e. whatever's on screen),
 * mirroring what a native pull would do. No-op on native.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Platform, View, ActivityIndicator } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';

const TRIGGER = 90; // px of finger travel to fire a refresh
const MAX = 120;

export default function WebPullToRefresh() {
  const qc = useQueryClient();
  const [dist, setDist] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const raw = useRef(0);
  const startY = useRef(0);
  const armed = useRef(false);
  const scroller = useRef<HTMLElement | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;

    const isScrollable = (el: HTMLElement) => {
      const s = getComputedStyle(el);
      return /(auto|scroll)/.test(s.overflowY + ' ' + s.overflow) && el.scrollHeight > el.clientHeight + 1;
    };
    const findScroller = (start: EventTarget | null): HTMLElement | null => {
      let el = start as HTMLElement | null;
      while (el && el !== document.body) {
        if (isScrollable(el)) return el;
        el = el.parentElement;
      }
      return null;
    };

    const onStart = (e: TouchEvent) => {
      if (busy.current || e.touches.length !== 1) { armed.current = false; return; }
      const sc = findScroller(e.target);
      const atTop = sc ? sc.scrollTop <= 0 : true;
      armed.current = atTop;
      if (atTop) { startY.current = e.touches[0].clientY; scroller.current = sc; raw.current = 0; }
    };
    const onMove = (e: TouchEvent) => {
      if (!armed.current || busy.current) return;
      const dy = e.touches[0].clientY - startY.current;
      const stillTop = scroller.current ? scroller.current.scrollTop <= 0 : true;
      if (dy > 0 && stillTop) {
        raw.current = dy;
        setDist(Math.min(dy, MAX));
        if (e.cancelable) e.preventDefault(); // suppress rubber-band while pulling
      } else {
        raw.current = 0;
        setDist(0);
      }
    };
    const onEnd = async () => {
      if (!armed.current) return;
      armed.current = false;
      const fire = raw.current >= TRIGGER;
      raw.current = 0;
      if (fire) {
        busy.current = true; setRefreshing(true); setDist(52);
        try { await qc.refetchQueries({ type: 'active' }); } catch { /* ignore */ }
        setRefreshing(false); busy.current = false;
      }
      setDist(0);
    };

    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd, { passive: true });
    document.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
    };
  }, [qc]);

  if (Platform.OS !== 'web' || dist <= 0) return null;
  const progress = Math.min(dist / TRIGGER, 1);
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, alignItems: 'center', zIndex: 9999, transform: [{ translateY: dist - 12 }] }}
    >
      <View
        style={{
          width: 36, height: 36, borderRadius: 18, backgroundColor: '#0b211c',
          alignItems: 'center', justifyContent: 'center', opacity: 0.55 + progress * 0.45,
          shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
        }}
      >
        <ActivityIndicator size="small" color="#e7b65c" animating={refreshing || progress >= 1} />
      </View>
    </View>
  );
}
