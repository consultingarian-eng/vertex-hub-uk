/**
 * Medal3D (web) — thin lazy shell. three.js + @react-three/fiber only load
 * when a 3D medal actually renders (level hero, level-up takeover), keeping
 * ~1MB out of the PWA entry bundle. While the chunk streams in — and on any
 * load failure — the reanimated coin renders, so there is never a hole.
 */
import React, { Suspense } from 'react';
import { MedalSpin } from './MedalSpin';

// Explicit .web suffix: this file only exists in the web graph, and the
// suffix keeps both Metro and TypeScript resolution unambiguous.
const Canvas3D = React.lazy(() => import('./Medal3DCanvas.web'));

class Lazy3DBoundary extends React.Component<{ fallback: React.ReactNode; children: React.ReactNode }, { dead: boolean }> {
  state = { dead: false };
  static getDerivedStateFromError() { return { dead: true }; }
  componentDidCatch() {} // decoration — fall back silently
  render() { return this.state.dead ? this.props.fallback : this.props.children; }
}

export function Medal3D({ size = 56, tint = '#c9a227', children }: {
  size?: number; tint?: string; children?: React.ReactNode;
}) {
  const fallback = <MedalSpin size={size}>{children}</MedalSpin>;
  return (
    <Lazy3DBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <Canvas3D size={size} tint={tint}>{children}</Canvas3D>
      </Suspense>
    </Lazy3DBoundary>
  );
}
