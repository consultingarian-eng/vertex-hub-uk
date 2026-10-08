/**
 * Medal3D (native fallback) — Expo Go can't carry three.js safely, so
 * native resolves this file and gets the reanimated pseudo-3D coin
 * (perspective wobble + shine sweep) with the identical prop surface.
 * Web resolves Medal3D.web.tsx and gets the real thing.
 */
import React from 'react';
import { MedalSpin } from './MedalSpin';

export function Medal3D({ size = 56, tint: _tint, children }: {
  size?: number; tint?: string; children?: React.ReactNode;
}) {
  return <MedalSpin size={size}>{children}</MedalSpin>;
}
