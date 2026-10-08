/**
 * JourneyPath — the trainee's 8-day plan as a winding node path (the
 * Duolingo pattern): completed nodes are hexagonal rank coins strung along
 * a glowing neon trail, today's coin turns and pulses under a "TODAY" /
 * "YOU ARE HERE" ribbon, and the road ahead runs on unlit — a soft band
 * under a dotted line — to ghosts of the very coins you have not earned yet.
 *
 * Pure presentation — the caller builds the ordered node list (orientation
 * days → product-training milestone → field days → Stage 2 trophy, or the
 * sales-path runway → Green Week → six levels) and owns navigation via each
 * node's onPress.
 *
 * Geometry is deterministic (fixed row heights, alternating fixed node
 * columns) so the SVG trail behind the rows can be computed from the same
 * numbers without measuring children.
 *
 * Motion budget: exactly ONE animated coin (the 'today' node) and ONE halo
 * loop per path — every other coin is static (no loop mounted at all).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Path, Defs, LinearGradient as SvgLinearGradient, Stop, Polygon } from 'react-native-svg';
import Animated, {
  cancelAnimation, useSharedValue, useAnimatedStyle, withRepeat, withTiming,
} from 'react-native-reanimated';
import { useColors, useTheme } from '../../theme/ThemeContext';
import { GRADIENT_XP, fonts } from '../../theme/brand';
import { MOTION, useLoopPause } from '../../theme/motion';
import { Reveal } from '../ui/Reveal';
import PressableScale from '../ui/PressableScale';
import { HexCoin, hexPoints, type HexCoinTint } from '../ui/HexCoin';
import { RankRibbon } from '../ui/RankRibbon';
import { DepthCard } from '../ui/DepthCard';

export type JourneyNode = {
  key: string;
  kind: 'day' | 'pk' | 'trophy' | 'level';
  state: 'done' | 'today' | 'upcoming';
  title: string;
  subtitle?: string;
  meta?: string;
  /** Day number shown inside the circle (day nodes). */
  badge?: string;
  /** Section label rendered above this row (ORIENTATION / FIELD …). */
  section?: string;
  score?: string;
  scoreColor?: string;
  statusLabel?: string;
  statusBg?: string;
  statusColor?: string;
  /** Chip text on the 'today' node — defaults to TODAY ("YOU ARE HERE" on the career map). */
  todayLabel?: string;
  /**
   * Leg WALKED even though the coin is not claimed — an elapsed-but-missed
   * ramp week, or the explainer view nobody is standing on. Lights the trail
   * out of this node; the coin itself stays a ghost. Every node before the
   * 'today' node is travelled automatically, so callers only set this for
   * legs the 'today' anchor cannot imply.
   */
  travelled?: boolean;
  /** Coin metal for done/today nodes (optional; default purple, trophies green). */
  tint?: HexCoinTint;
  onPress?: () => void;
};

const ROW_H = 104;
const SECTION_H = 34;
const NODE = 58;
const NODE_COL = 76;
const PAD = 6;
const ROW_GAP = 10;
const CARD_PAD_X = 12;
const INK = '#0b211c';
const HALO_MS = 1600;
/**
 * Meta line box (10 px mono): the row grows by exactly one line when the meta
 * needs two, so the trail geometry keeps coming from constants instead of a
 * measurement pass. META_CHAR_W is Space Mono's advance at 10 px (0.6 em).
 */
const META_LINE_H = 14;
const META_EXTRA = 16;
const META_CHAR_W = 6;
/** The node hexagon, shared by every layer (same radius HexCoin uses for its face). */
const HEX = hexPoints(NODE / 2, NODE / 2, NODE * 0.47);

/** Pulsing hex halo behind today's coin — scale 1→1.6, opacity .5→0 (spec §5). */
function TodayHalo() {
  const p = useSharedValue(0);
  const run = useCallback(() => {
    p.value = 0;
    p.value = withRepeat(withTiming(1, { duration: HALO_MS, easing: MOTION.easeOut }), -1, false);
  }, [p]);
  useEffect(() => {
    run();
    return () => cancelAnimation(p);
  }, [run, p]);
  useLoopPause(p, run, 'JourneyPath.halo');
  const style = useAnimatedStyle(() => ({
    opacity: (1 - p.value) * 0.5,
    transform: [{ scale: 1 + p.value * 0.6 }],
  }));
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      <Svg width={NODE} height={NODE}>
        <Polygon points={HEX} fill="none" stroke="#8caf38" strokeWidth={2.5} strokeLinejoin="round" />
      </Svg>
    </Animated.View>
  );
}

/** Flat hex outline (no coin, no loop) — the product-training node, which is never locked. */
function HexOutline({ fill, stroke, strokeWidth, children }: {
  fill: string; stroke: string; strokeWidth: number; children?: React.ReactNode;
}) {
  return (
    <View style={styles.nodeBox}>
      <Svg width={NODE} height={NODE} style={StyleSheet.absoluteFill}>
        <Polygon points={HEX} fill={fill} stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round" />
      </Svg>
      {children}
    </View>
  );
}

/**
 * Upcoming node — a GHOST of the coin it becomes (spec §3.17: static coins
 * for done AND upcoming). The muted metal rides an opaque hex socket so it
 * can never wash into the lavender field, under a crisp rim; the glyph stays
 * readable on top. Static: no loop, no registry entry.
 */
function GhostCoin({ colors, tint, children }: {
  colors: any; tint: HexCoinTint; children?: React.ReactNode;
}) {
  return (
    <View style={styles.nodeBox}>
      <Svg width={NODE} height={NODE} style={StyleSheet.absoluteFill} pointerEvents="none">
        <Polygon points={HEX} fill={colors.background} />
      </Svg>
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.ghostCoin]}>
        <HexCoin size={NODE} tint={tint} animate={false} />
      </View>
      <Svg width={NODE} height={NODE} style={StyleSheet.absoluteFill} pointerEvents="none">
        <Polygon points={HEX} fill="none" stroke={colors.borderDark} strokeWidth={1.6} strokeLinejoin="round" />
      </Svg>
      {children}
    </View>
  );
}

function NodeCoin({ node, colors, isDark }: { node: JourneyNode; colors: any; isDark: boolean }) {
  const tint: HexCoinTint = node.tint ?? (node.kind === 'trophy' ? 'green' : 'purple');
  const glyphColor = tint === 'purple' ? '#ffffff' : INK;
  // Ghost glyphs ride the muted METAL, not the page: ink on the light metals,
  // white only where the purple face goes dark (dark theme), each with a halo
  // in the opposite tone so the numeral clears AA over the whole gradient —
  // the earned coin does exactly this with its own glow (HexCoin numeral).
  const ghostInk = tint === 'purple' && isDark ? '#ffffff' : INK;
  const ghostHalo = ghostInk === INK ? 'rgba(255,255,255,0.9)' : 'rgba(7,18,13,0.9)';
  const icon =
    node.kind === 'pk' ? 'school' :
    node.kind === 'trophy' ? 'trophy' :
    'checkmark';

  if (node.state === 'done' || node.state === 'today') {
    const today = node.state === 'today';
    // 'level' nodes keep their medal emoji visible in EVERY state — a career
    // map where earned medals turn into checkmarks loses the whole point.
    const content: React.ReactNode =
      node.kind === 'level'
        ? <Text style={styles.emoji}>{node.badge}</Text>
        : node.state === 'done' || node.kind !== 'day'
          ? <Ionicons name={icon as any} size={26} color={glyphColor} />
          : node.badge; // today's day number → the coin's numeral style
    return (
      <View style={styles.nodeBox}>
        {today && <TodayHalo />}
        <HexCoin size={NODE} tint={tint} animate={today} glow={today}>
          {content}
        </HexCoin>
      </View>
    );
  }

  // Upcoming — PK stays inviting (it's never locked), days/levels sit dim.
  if (node.kind === 'pk') {
    return (
      <HexOutline fill={colors.background} stroke={colors.primary} strokeWidth={2}>
        <Ionicons name="school" size={22} color={colors.primary} />
      </HexOutline>
    );
  }
  return (
    <GhostCoin colors={colors} tint={tint}>
      {node.kind === 'level' ? (
        <Text style={styles.emojiDim}>{node.badge}</Text>
      ) : node.kind === 'trophy' ? (
        <Ionicons name="trophy-outline" size={24} color={ghostInk} />
      ) : (
        <Text
          style={[
            styles.nodeNum,
            { color: ghostInk, textShadowColor: ghostHalo, textShadowRadius: 4, textShadowOffset: { width: 0, height: 0 } },
          ]}
        >
          {node.badge}
        </Text>
      )}
    </GhostCoin>
  );
}

export function JourneyPath({ nodes }: { nodes: JourneyNode[] }) {
  const colors = useColors();
  const { effective } = useTheme();
  const isDark = effective === 'dark';
  const [width, setWidth] = useState(0);
  const trailId = 'jpTrail' + React.useId().replace(/[^a-zA-Z0-9]/g, '');

  // The label card's text column — the only width the row heights depend on.
  const textW = Math.max(0, width - PAD * 2 - NODE_COL - ROW_GAP - CARD_PAD_X * 2);
  /**
   * A frozen meta string must WRAP, not shrink (it never fits on one line at
   * 390 pt), so a row carrying a two-line meta is exactly one line taller.
   * Derived from the same constants as the trail, never measured.
   */
  const rowHeights = nodes.map((n) => {
    if (!n.meta || textW <= 0) return ROW_H;
    const perLine = Math.max(8, Math.floor(textW / META_CHAR_W));
    return n.meta.length > perLine ? ROW_H + META_EXTRA : ROW_H;
  });

  // Deterministic vertical layout: each node contributes an optional section
  // header block plus its own row height.
  let y = 0;
  const centers: Array<{ x: 'L' | 'R'; y: number }> = [];
  const offsets: number[] = [];
  nodes.forEach((n, i) => {
    if (n.section) y += SECTION_H;
    offsets.push(y);
    centers.push({ x: i % 2 === 0 ? 'L' : 'R', y: y + rowHeights[i] / 2 });
    y += rowHeights[i];
  });
  const totalH = y;

  // Where the viewer is standing. Everything BEFORE it has been walked —
  // a rep on Week 2 has visibly covered the Week 1 leg whether or not that
  // week was met — so the neon runs up to and including the current node.
  const todayIdx = nodes.findIndex((n) => n.state === 'today');

  const xFor = (side: 'L' | 'R') =>
    side === 'L' ? PAD + NODE_COL / 2 : width - PAD - NODE_COL / 2;

  const segments = width > 0
    ? nodes.slice(0, -1).map((n, i) => {
        const from = centers[i];
        const to = centers[i + 1];
        const x1 = xFor(from.x); const y1 = from.y;
        const x2 = xFor(to.x); const y2 = to.y;
        const dy = (y2 - y1) * 0.55;
        return {
          d: `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`,
          travelled: n.state === 'done' || !!n.travelled || (todayIdx > 0 && i < todayIdx),
        };
      })
    : [];

  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ position: 'relative' }}>
      {width > 0 && (
        <Svg width={width} height={totalH} style={StyleSheet.absoluteFill} pointerEvents="none">
          <Defs>
            {/* Neon XP gradient runs the full height of the map so the trail sweeps magenta → violet → cyan. */}
            <SvgLinearGradient id={trailId} x1="0" y1="0" x2="0" y2={totalH} gradientUnits="userSpaceOnUse">
              {GRADIENT_XP.map((c, i) => (
                <Stop key={i} offset={`${Math.round((i / (GRADIENT_XP.length - 1)) * 100)}%`} stopColor={c} />
              ))}
            </SvgLinearGradient>
          </Defs>
          {segments.map((s, i) =>
            s.travelled ? (
              <React.Fragment key={i}>
                {/* wide neon bloom + soft glow under the lit trail (static paths, no loop) */}
                <Path d={s.d} stroke="#e7b65c" strokeOpacity={isDark ? 0.16 : 0.10} strokeWidth={26} fill="none" strokeLinecap="round" />
                <Path d={s.d} stroke="#8caf38" strokeOpacity={isDark ? 0.34 : 0.22} strokeWidth={14} fill="none" strokeLinecap="round" />
                <Path d={s.d} stroke={`url(#${trailId})`} strokeWidth={5} fill="none" strokeLinecap="round" />
                <Path d={s.d} stroke="#ffffff" strokeOpacity={0.35} strokeWidth={1.2} fill="none" strokeLinecap="round" />
              </React.Fragment>
            ) : (
              <React.Fragment key={i}>
                {/* the road ahead — the same trail, laid but not lit yet */}
                <Path
                  d={s.d}
                  stroke={colors.borderDark}
                  strokeOpacity={isDark ? 0.22 : 0.34}
                  strokeWidth={12}
                  fill="none"
                  strokeLinecap="round"
                />
                <Path
                  d={s.d}
                  stroke={colors.borderDark}
                  strokeOpacity={0.9}
                  strokeWidth={3}
                  fill="none"
                  strokeLinecap="round"
                  strokeDasharray="1 11"
                />
              </React.Fragment>
            )
          )}
        </Svg>
      )}

      {nodes.map((n, i) => {
        const left = i % 2 === 0;
        const today = n.state === 'today';
        // A walked leg keeps its title at full strength even when the coin is
        // unclaimed — only the road AHEAD reads as not-yet.
        const walked = n.state !== 'upcoming' || !!n.travelled || (todayIdx > 0 && i < todayIdx);
        const labelBody = (
          <>
            <View style={styles.titleRow}>
              <Text
                style={[
                  styles.title,
                  { color: !walked && n.kind === 'day' ? colors.textSecondary : colors.text },
                ]}
                numberOfLines={1}
              >
                {n.title}
              </Text>
              {today && (
                <RankRibbon tint="purple" size="sm">{n.todayLabel || 'TODAY'}</RankRibbon>
              )}
            </View>
            {n.subtitle ? (
              <Text style={[styles.subtitle, { color: colors.textSecondary }]} numberOfLines={2}>
                {n.subtitle}
              </Text>
            ) : null}
            {n.score || n.statusLabel ? (
              <View style={styles.metaRow}>
                {n.score ? (
                  <Text style={[styles.score, { color: n.scoreColor || colors.text }]}>{n.score}</Text>
                ) : null}
                {n.statusLabel ? (
                  <View style={[styles.statusChip, { backgroundColor: n.statusBg || colors.surfaceAlt }]}>
                    <Text style={[styles.statusChipText, { color: n.statusColor || colors.textSecondary }]}>
                      {n.statusLabel}
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}
            {/* The meta gets its OWN line under the score/status chip: the copy
                is frozen ("Most people: weeks 50–200 — plenty go faster") and
                never fits the narrowed card on one line, so it wraps. */}
            {n.meta ? (
              <Text style={[styles.meta, { color: colors.textMuted }]} numberOfLines={2}>
                {n.meta}
              </Text>
            ) : null}
          </>
        );
        return (
          <View key={n.key}>
            {n.section ? (
              <View style={{ height: SECTION_H, alignItems: 'center', justifyContent: 'center' }}>
                <View style={[styles.sectionPill, { backgroundColor: colors.ink }]}>
                  <Text style={[styles.section, { color: colors.inkMuted }]}>{n.section}</Text>
                </View>
              </View>
            ) : null}
            <Reveal index={Math.min(i, 7)} distance={14}>
              <PressableScale
                glow={false}
                onPress={n.onPress}
                style={[styles.row, { height: rowHeights[i], flexDirection: left ? 'row' : 'row-reverse' }]}
                testID={`journey-node-${n.key}`}
              >
                <View style={{ width: NODE_COL, alignItems: 'center', justifyContent: 'center' }}>
                  <NodeCoin node={n} colors={colors} isDark={isDark} />
                </View>
                {today ? (
                  // The current node's card floats on a gradient rim — the one
                  // depth card on the map (list rows stay shadow-free).
                  <DepthCard edge="gradient" style={styles.labelCard}>
                    {labelBody}
                  </DepthCard>
                ) : (
                  <View
                    style={[
                      styles.labelCard,
                      {
                        backgroundColor: colors.background + 'F2',
                        borderWidth: 1,
                        borderColor: colors.border,
                        opacity: !walked && n.kind === 'day' ? 0.92 : 1,
                      },
                    ]}
                  >
                    {labelBody}
                  </View>
                )}
              </PressableScale>
            </Reveal>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { alignItems: 'center', gap: 10, paddingHorizontal: PAD },
  nodeBox: { width: NODE, height: NODE, alignItems: 'center', justifyContent: 'center' },
  // Unbounded-Black: never add fontWeight (faux-bold on web).
  nodeNum: { fontFamily: fonts.displayBlack, fontSize: 20, includeFontPadding: false },
  emoji: { fontSize: 24, includeFontPadding: false },
  emojiDim: { fontSize: 23, opacity: 0.85, includeFontPadding: false },
  // The unearned coin's metal, muted behind its glyph — muted enough to read
  // "not yet", bright enough that it never reads "disabled" (spec §3.17).
  ghostCoin: { opacity: 0.72 },
  sectionPill: {
    paddingHorizontal: 11, paddingVertical: 4, borderRadius: 999,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
  },
  section: { fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1.6, includeFontPadding: false },
  labelCard: {
    flex: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 10,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  title: { fontFamily: fonts.display, fontSize: 14.5, flexShrink: 1 },
  subtitle: { fontFamily: fonts.body, fontSize: 11.5, lineHeight: 16, marginTop: 2 },
  // lineHeight is pinned so ROW_H + META_EXTRA stays exact arithmetic.
  meta: { fontFamily: fonts.mono, fontSize: 10, lineHeight: META_LINE_H, marginTop: 4 },
  score: { fontFamily: fonts.monoSemibold, fontSize: 15 },
  statusChip: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 4 },
  statusChipText: { fontFamily: fonts.bodyBold, fontSize: 9.5 },
});

export default JourneyPath;
