/**
 * CycleRing — the COD motif. A thin four-segment ring (one arc per stage,
 * stage-colored, tiny clockwise arrowheads in the gaps) that reads as
 * "cycle" without shouting. Decorative only: absolutely positioned,
 * pointerEvents none — scatter it behind hero cards at low opacity.
 */
import React from 'react';
import { View } from 'react-native';
import Svg, { Circle, G, Polygon } from 'react-native-svg';
import { STAGE_META } from './types';

type Props = {
  size?: number;
  opacity?: number;
  strokeWidth?: number;
  style?: any;
};

export function CycleRing({ size = 160, opacity = 0.22, strokeWidth = 2.5, style }: Props) {
  const c = size / 2;
  const r = c - strokeWidth * 3;
  const circ = 2 * Math.PI * r;
  const seg = circ / 4 - circ * 0.07; // quarter arc minus a breathing gap
  const stageColors = [1, 2, 3, 4].map((s) => STAGE_META[s].color);

  return (
    <View
      pointerEvents="none"
      style={[{ position: 'absolute', width: size, height: size, opacity }, style]}
    >
      <Svg width={size} height={size}>
        {stageColors.map((color, i) => (
          <G key={`arc-${i}`} transform={`rotate(${i * 90 - 84} ${c} ${c})`}>
            <Circle
              cx={c}
              cy={c}
              r={r}
              stroke={color}
              strokeWidth={strokeWidth}
              fill="none"
              strokeDasharray={`${seg} ${circ - seg}`}
              strokeLinecap="round"
            />
          </G>
        ))}
        {/* Tiny clockwise arrowheads sitting in each gap */}
        {stageColors.map((color, i) => {
          const a = ((i * 90 - 90) * Math.PI) / 180;
          const x = c + r * Math.cos(a);
          const y = c + r * Math.sin(a);
          const rot = i * 90; // tangent, clockwise
          return (
            <G key={`tip-${i}`} transform={`translate(${x} ${y}) rotate(${rot})`}>
              <Polygon points={`-2.4,-${strokeWidth * 1.7} ${strokeWidth * 2.2},0 -2.4,${strokeWidth * 1.7}`} fill={color} />
            </G>
          );
        })}
      </Svg>
    </View>
  );
}

export default CycleRing;
