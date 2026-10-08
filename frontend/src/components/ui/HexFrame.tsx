/**
 * HexFrame — a hex-clipped avatar with a gradient stroke and a glow
 * (spec §3.10, "HexFrame").
 *
 *   <HexFrame size={56} uri={user.avatar_url} />
 *   <HexFrame size={56}><Text>{initials}</Text></HexFrame>   // fallback when there is no photo
 *
 * Svg `<Image>` + `<ClipPath>` clips the photo to the hexagon on web AND
 * native (rnsvg resolves `{ uri }` on both), a 3 px XP-gradient polygon
 * stroke sits on the clip edge, and a GlowOrb halo floats behind. With no
 * `uri`, the hex is filled with `colors.surfaceAlt` and `children` (initials,
 * an icon) render centred on top. No loops — a static frame.
 */
import React, { useMemo, type ReactNode } from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import Svg, { ClipPath, Defs, Image, LinearGradient, Polygon, Stop } from 'react-native-svg';
import { GRADIENT_XP, useColors, useTheme } from '../../theme/ThemeContext';
import { GlowOrb } from './Decor';
import { hexPoints } from './HexCoin';

export type HexFrameProps = {
  /** Rendered width and height in px. */
  size: number;
  /** Photo URL. Omit to show the fallback fill + children. */
  uri?: string;
  /** Fallback content (initials, icon) shown centred when there is no `uri`. */
  children?: ReactNode;
  /** Stroke width in px (default 3). */
  stroke?: number;
  /** Halo behind the frame (default true). */
  glow?: boolean;
  /** Container style (position, margins). */
  style?: StyleProp<ViewStyle>;
};

export function HexFrame({ size, uri, children, stroke = 3, glow = true, style }: HexFrameProps) {
  const colors = useColors();
  const { effective } = useTheme();
  const uid = React.useId().replace(/[^a-zA-Z0-9]/g, '');
  const ids = useMemo(() => ({ clip: `hfC${uid}`, ring: `hfR${uid}` }), [uid]);

  const c = size / 2;
  // Stroke centred on the clip edge: its outer half sits outside the photo,
  // its inner half covers the photo's anti-aliased edge.
  const R = c - stroke / 2 - 0.5;
  const hex = useMemo(() => hexPoints(c, c, R), [c, R]);
  const n = GRADIENT_XP.length;

  return (
    <View style={[{ width: size, height: size }, style]}>
      {glow ? (
        <GlowOrb
          size={size * 1.6}
          color={colors.primary}
          opacity={effective === 'dark' ? 0.5 : 0.36}
          style={{ top: -size * 0.3, left: -size * 0.3 }}
        />
      ) : null}
      <Svg width={size} height={size}>
        <Defs>
          <ClipPath id={ids.clip}>
            <Polygon points={hex} />
          </ClipPath>
          <LinearGradient id={ids.ring} x1={0} y1={0} x2={1} y2={1}>
            {GRADIENT_XP.map((col, i) => (
              <Stop key={i} offset={`${Math.round((i / (n - 1)) * 100)}%`} stopColor={col} />
            ))}
          </LinearGradient>
        </Defs>
        {/* Ground: shows while the photo loads and as the fallback fill. */}
        <Polygon points={hex} fill={colors.surfaceAlt} />
        {uri ? (
          <Image
            href={{ uri }}
            x={0}
            y={0}
            width={size}
            height={size}
            preserveAspectRatio="xMidYMid slice"
            clipPath={`url(#${ids.clip})`}
          />
        ) : null}
        <Polygon
          points={hex}
          fill="none"
          stroke={`url(#${ids.ring})`}
          strokeWidth={stroke}
          strokeLinejoin="round"
        />
      </Svg>
      {!uri && children ? (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center]}>{children}</View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
});

export default HexFrame;
