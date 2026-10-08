/**
 * Decor — brand background graphics (no new deps, all react-native-svg).
 *
 *  • <GlowOrb/>   — soft radial glow, absolutely positioned.
 *  • <DotField/>  — the Vertex logo's halftone dots as a texture, fading away
 *                   from one corner. Tuck one or two into screen corners at
 *                   low opacity to break up flat surfaces.
 *  • <DecorField/>— a ready-made arrangement of orbs + dot fields for screen
 *                   backdrops (login, splash).
 *
 * All elements are pointerEvents="none" so they never block touches.
 */
import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import Svg, { Circle, Defs, G, RadialGradient, Stop } from 'react-native-svg';
import { brand } from '../../theme/brand';
import { dotField } from './vertexGeometry';

// ── Soft radial glow ─────────────────────────────────────────────────────────
export function GlowOrb({
  size = 260,
  color = '#2f6a4b',
  opacity = 0.35,
  style,
}: {
  size?: number;
  color?: string;
  opacity?: number;
  style?: any;
}) {
  const id = React.useId().replace(/[^a-zA-Z0-9]/g, '');
  return (
    <View pointerEvents="none" style={[{ position: 'absolute', width: size, height: size }, style]}>
      <Svg width={size} height={size}>
        <Defs>
          <RadialGradient id={`orb${id}`} cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={color} stopOpacity={opacity} />
            <Stop offset="60%" stopColor={color} stopOpacity={opacity * 0.45} />
            <Stop offset="100%" stopColor={color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#orb${id})`} />
      </Svg>
    </View>
  );
}

// ── Halftone dot field (from the logo's X) ───────────────────────────────────
export type DotFieldCorner = 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';

export function DotField({
  size = 160,
  color = brand.limeDark,
  opacity = 0.2,
  corner = 'bottom-left',
  style,
}: {
  size?: number;
  color?: string;
  opacity?: number;
  /** The corner the dots are largest in; they fade out towards the opposite one. */
  corner?: DotFieldCorner;
  style?: any;
}) {
  // Drawn in a fixed 200-unit box and scaled, so every size has the same grain.
  const dots = useMemo(() => dotField(200, 200, corner, 16, 6.5), [corner]);
  return (
    <View pointerEvents="none" style={[{ position: 'absolute', width: size, height: size, opacity }, style]}>
      <Svg width={size} height={size} viewBox="0 0 213 213">
        <G fill={color}>
          {dots.map((d, i) => <Circle key={i} cx={d.x} cy={d.y} r={d.r} />)}
        </G>
      </Svg>
    </View>
  );
}

// ── Ready-made backdrop arrangement ──────────────────────────────────────────
// Fills its parent (position absolute) with glows + two faint dot fields.
export function DecorField({ dark = true }: { dark?: boolean }) {
  const glow = dark ? 0.4 : 0.18;
  const dots = dark ? 0.2 : 0.14;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <GlowOrb size={340} color="#2f6a4b" opacity={glow} style={{ top: -90, right: -110 }} />
      <GlowOrb size={300} color="#244c3b" opacity={glow * 0.8} style={{ bottom: -80, left: -120 }} />
      <GlowOrb size={180} color="#e7b65c" opacity={glow * 0.45} style={{ top: '38%', left: -70 }} />
      <DotField size={220} opacity={dots} corner="top-right" style={{ top: -20, right: -20 }} />
      <DotField size={260} opacity={dots * 0.8} corner="bottom-left" style={{ bottom: -20, left: -20 }} />
    </View>
  );
}
