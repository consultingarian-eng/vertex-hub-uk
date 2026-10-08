/**
 * TeamMapView — the team as a spider diagram: you in the centre, each
 * generation on its own ring (Gen 1 = the people you coach directly, Gen 2 =
 * theirs, …). Every ring is shaded its own colour so a generation reads at a
 * glance, and straight spokes join each coach to their people.
 *
 * Each person: a round avatar ringed in their generation's colour (thicker
 * for coaches), their OwnerIQ stage on a small badge, the team tag above team
 * leaders, and their name on an opaque pill (lines run behind it, never
 * through it). The Ranks panel counts people per OwnerIQ stage and per
 * generation; tap a row to highlight just those people. Tap a person for
 * their card: team, generation, this week's sign-ups and — for admins —
 * Advance / Demote, which changes their stage in OwnerIQ, and Remove, which
 * takes them off the team here and deactivates them in OwnerIQ.
 *
 * Moving people (admins): drag a person onto a Coach to move them into that
 * Coach's team, the way OwnerIQ's tree works. With a mouse just drag; on a
 * touch screen press and hold the person for a moment first, so an ordinary
 * swipe still pans the map. The drop asks for confirmation (onMove).
 *
 * Navigation: drag the background to pan, pinch or − / + to zoom, double-tap
 * or Fit.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image, LayoutChangeEvent, ScrollView, Platform, TextInput } from 'react-native';
import Svg, { Circle, Defs, Line, Pattern, Rect, Text as SvgText } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { GestureDetector, Gesture, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming, runOnJS } from 'react-native-reanimated';
import { useColors } from '../../theme/ThemeContext';
import { brand, fonts } from '../../theme/brand';

export type TeamMapNode = {
  id: string;
  name: string;
  role?: string;
  profile_image?: string;
  team_name?: string | null;
  is_super_admin?: boolean;
  owneriq_stage?: string | null;
  children: TeamMapNode[];
};

type Week = { sales?: number | null; target?: number | null };

type Placed = {
  node: TeamMapNode;
  gen: number;           // 0 = you, 1 = first generation, …
  x: number;
  y: number;
  parent: Placed | null;
  teamSize: number;
};

// One colour per generation (ring shading, avatar rings, legend).
export const GEN_COLOURS = ['#b7df58', '#b7df58', '#4fd1c5', '#e7b65c', '#e0607e', '#a78bfa', '#60a5fa'];
const genColour = (g: number) => GEN_COLOURS[Math.min(g, GEN_COLOURS.length - 1)];
const genLabel = (g: number) => (g === 0 ? 'You' : `Gen ${g}`);

// ── Geometry ───────────────────────────────────────────────────────────────
const AV = 42;
const AV_ROOT = 60;
const NODE_W = 112;          // room each person needs along their ring
const RING_STEP = 170;       // minimum distance between rings
const PAD = 90;
const MIN_SCALE = 0.12;
const MAX_SCALE = 2.5;
const OPEN_SCALE = 0.6;
const CANVAS = '#050f0c';
// The map is dark in both themes, so its controls never use the theme's text colour.
const INK_TEXT = '#eef4e6';
const HOLD_MS = 220;         // touch: hold a person this long, then drag

/** OwnerIQ's stage key → the short label it shows ("stage_3_plus" → "3+"). */
export function stageLabel(s?: string | null): string | null {
  if (!s) return null;
  const m = /^stage_(\d+)(_plus)?$/.exec(s);
  return m ? `${m[1]}${m[2] ? '+' : ''}` : null;
}
const stageRank = (s?: string | null) => {
  const m = s ? /^stage_(\d+)(_plus)?$/.exec(s) : null;
  return m ? Number(m[1]) + (m[2] ? 0.5 : 0) : -1;
};

/** Radial layout: each person gets a slice of the circle in proportion to the
 *  size of their branch and sits on their generation's ring in the middle of
 *  it. Angles come first; then each ring is pushed out until the two closest
 *  people on it are NODE_W apart (and rings stay RING_STEP apart). */
function layout(root: TeamMapNode) {
  const weight = new Map<string, number>();
  const w = (n: TeamMapNode): number => {
    const v = n.children.length ? n.children.reduce((s, c) => s + w(c), 0) : 1;
    weight.set(n.id, v);
    return v;
  };
  w(root);
  type Pre = { node: TeamMapNode; gen: number; angle: number; parent: Pre | null; teamSize: number };
  const pre: Pre[] = [];
  const perGen: number[] = [];
  const assign = (n: TeamMapNode, g: number, a0: number, a1: number, parent: Pre | null): Pre => {
    const me: Pre = { node: n, gen: g, angle: (a0 + a1) / 2, parent, teamSize: 0 };
    pre.push(me);
    perGen[g] = (perGen[g] || 0) + 1;
    let start = a0;
    const total = weight.get(n.id) || 1;
    for (const k of n.children) {
      const span = ((a1 - a0) * (weight.get(k.id) || 1)) / total;
      me.teamSize += 1 + assign(k, g + 1, start, start + span, me).teamSize;
      start += span;
    }
    return me;
  };
  assign(root, 0, -Math.PI / 2, (3 * Math.PI) / 2, null);
  // Each ring: as far out as its tightest neighbouring pair needs.
  const radii: number[] = [0];
  for (let g = 1; g < perGen.length; g += 1) {
    const angles = pre.filter((p) => p.gen === g).map((p) => p.angle).sort((x, y) => x - y);
    let minGap = 2 * Math.PI;
    for (let i = 0; i < angles.length; i += 1) {
      const next = i + 1 < angles.length ? angles[i + 1] : angles[0] + 2 * Math.PI;
      if (angles.length > 1) minGap = Math.min(minGap, next - angles[i]);
    }
    const need = angles.length > 1 ? (NODE_W * 1.05) / minGap : 0;
    radii[g] = Math.max(radii[g - 1] + RING_STEP, need);
  }
  const outer = radii[radii.length - 1] || RING_STEP;
  const size = 2 * (outer + PAD + 40);
  const c = size / 2;
  const map = new Map<Pre, Placed>();
  const placed: Placed[] = pre.map((p) => {
    const out: Placed = { node: p.node, gen: p.gen, parent: null, teamSize: p.teamSize,
      x: c + Math.cos(p.angle) * radii[p.gen], y: c + Math.sin(p.angle) * radii[p.gen] };
    map.set(p, out);
    return out;
  });
  pre.forEach((p) => { if (p.parent) map.get(p)!.parent = map.get(p.parent)!; });
  return { placed, size, centre: c, radii, perGen };
}

const initials = (name: string) =>
  (name || '?').trim().split(/\s+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase();

type Highlight = { kind: 'stage'; value: string } | { kind: 'gen'; value: number } | null;

export default function TeamMapView({
  root, week = {}, canEditStage = false, onStageChange, canMove = false, onMove, onRemove, onOpen, bottomInset = 8,
}: {
  /** Admins: open this person's own page (performance, COD, badge). */
  onOpen?: (userId: string) => void;
  /** Admins: remove someone from the team (confirm, save, reload the tree). */
  onRemove?: (userId: string, name: string, teamSize: number) => Promise<void>;
  /** Admins: drag a person onto a Coach to move them. */
  canMove?: boolean;
  /** Called on a valid drop; confirm and save, then reload the tree. */
  onMove?: (userId: string, coachId: string, name: string, coachName: string) => void;
  root: TeamMapNode | null;
  /** Space kept clear at the bottom (the floating tab bar). */
  bottomInset?: number;
  week?: Record<string, Week>;
  /** Admins: show Advance / Demote on the person card. */
  canEditStage?: boolean;
  /** Advance/demote someone in OwnerIQ; resolves when done. */
  onStageChange?: (userId: string, direction: 'promote' | 'demote', name: string) => Promise<void>;
}) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const L = useMemo(() => (root ? layout(root) : null), [root]);
  const placed = useMemo(() => L?.placed || [], [L]);
  const size = L?.size || 400;
  const byId = useMemo(() => new Map(placed.map((p) => [p.node.id, p])), [placed]);
  const [selected, setSelected] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<Highlight>(null);
  const [ranksOpen, setRanksOpen] = useState(false);
  // Find a person: type a name, tap the match, and the map goes to them.
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState('');
  const [busy, setBusy] = useState(false);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [zoomPct, setZoomPct] = useState(100);
  // Drag-to-move: indexes into `placed` (-1 = none).
  const [dragI, setDragI] = useState(-1);
  const [dropI, setDropI] = useState(-1);
  const lastDrag = useRef(0);

  // Lit people: a selected person's path to the centre + their branch, or
  // everyone matching the Ranks highlight.
  const lit = useMemo(() => {
    if (selected) {
      const s = new Set<string>();
      let p = byId.get(selected) || null;
      while (p) { s.add(p.node.id); p = p.parent; }
      const down = (n: TeamMapNode) => { s.add(n.id); n.children.forEach(down); };
      const sel = byId.get(selected);
      if (sel) down(sel.node);
      return s;
    }
    if (highlight) {
      return new Set(placed.filter((p) => (highlight.kind === 'gen'
        ? p.gen === highlight.value
        : (p.node.owneriq_stage || 'none') === highlight.value)).map((p) => p.node.id));
    }
    return null;
  }, [selected, highlight, byId, placed]);

  const stageCounts = useMemo(() => {
    const m = new Map<string, number>();
    placed.forEach((p) => { if (p.gen > 0) m.set(p.node.owneriq_stage || 'none', (m.get(p.node.owneriq_stage || 'none') || 0) + 1); });
    return [...m.entries()].sort((a, b) => stageRank(b[0]) - stageRank(a[0]));
  }, [placed]);

  // ── Pan / zoom ──────────────────────────────────────────────────────────
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const sc = useSharedValue(1);
  const sTx = useSharedValue(0);
  const sTy = useSharedValue(0);
  const sSc = useSharedValue(1);
  const fx = useSharedValue(0);
  const fy = useSharedValue(0);

  const setView = useCallback((s: number, nx: number, ny: number, animate: boolean) => {
    const t = (v: number) => (animate ? withTiming(v, { duration: 280 }) : v);
    tx.value = t(nx); ty.value = t(ny); sc.value = t(s);
    sTx.value = nx; sTy.value = ny; sSc.value = s;
    setZoomPct(Math.round(s * 100));
  }, [tx, ty, sc, sTx, sTy, sSc]);

  const fitTo = useCallback((vw: number, vh: number, animate = true) => {
    if (!vw || !vh) return;
    const s = Math.max(MIN_SCALE, Math.min(1, vw / size, vh / size));
    setView(s, (vw - size * s) / 2, (vh - size * s) / 2, animate);
  }, [size, setView]);

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    const first = viewport.w === 0;
    setViewport({ w: width, h: height });
    if (!first || !L) return;
    const fit = Math.min(1, width / size, height / size);
    if (fit >= OPEN_SCALE) { fitTo(width, height, false); return; }
    // Narrow screen: open on the centre and the first generations.
    setView(OPEN_SCALE, width / 2 - L.centre * OPEN_SCALE, height / 2 - L.centre * OPEN_SCALE, false);
  };

  const narrow = viewport.w > 0 && viewport.w < 600;
  const matches = useMemo(() => {
    const q = findText.trim().toLowerCase();
    if (!q) return [];
    return placed.filter((p) => p.gen > 0 && (p.node.name || '').toLowerCase().includes(q)).slice(0, 6);
  }, [findText, placed]);
  /** Centre the map on someone, close enough to read their branch, and light it up. */
  const goTo = (p: Placed) => {
    const s = Math.max(sc.value, 1);
    setView(s, viewport.w / 2 - p.x * s, viewport.h / 2 - p.y * s, true);
    setHighlight(null);
    setSelected(p.node.id);
    setFindOpen(false);
    setFindText('');
  };

  const zoomBy = (f: number) => {
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, sc.value * f));
    const cx = viewport.w / 2, cy = viewport.h / 2;
    const r = next / sc.value;
    setView(next, cx - (cx - tx.value) * r, cy - (cy - ty.value) * r, true);
  };

  // ── Drag a person onto a Coach ──────────────────────────────────────────
  const hits = useSharedValue<{ x: number; y: number; av: number }[]>([]);
  const dragOn = useSharedValue(false);
  const fine = useSharedValue(false);      // mouse / trackpad: drag straight away
  const bx = useSharedValue(0);
  const by = useSharedValue(0);
  const beginT = useSharedValue(0);
  const dragIdx = useSharedValue(-1);
  const tgtIdx = useSharedValue(-1);
  const gx = useSharedValue(0);
  const gy = useSharedValue(0);
  useEffect(() => {
    hits.value = placed.map((p) => ({ x: p.x, y: p.y, av: p.gen === 0 ? AV_ROOT : AV }));
  }, [placed, hits]);
  useEffect(() => { dragOn.value = !!(canMove && onMove); }, [canMove, onMove, dragOn]);
  useEffect(() => {
    if (Platform.OS === 'web' && typeof window !== 'undefined' && window.matchMedia) {
      fine.value = window.matchMedia('(pointer: fine)').matches;
    }
  }, [fine]);

  /** Can `d` be moved under `t`? `why` explains a refusal. */
  const dropCheck = useCallback((d?: Placed, t?: Placed): { ok: boolean; why?: string } => {
    if (!d || !t) return { ok: false };
    const first = (n: string) => n.split(/\s+/)[0];
    if (d.parent?.node.id === t.node.id) return { ok: false, why: `${first(d.node.name)} is already in ${first(t.node.name)}'s team` };
    if (t.node.role === 'trainee') return { ok: false, why: `${first(t.node.name)} is a BA. Drop on a Coach` };
    for (let p: Placed | null = t; p; p = p.parent) {
      if (p.node.id === d.node.id) return { ok: false, why: `${first(t.node.name)} is in ${first(d.node.name)}'s own team` };
    }
    return { ok: true };
  }, []);

  const beginDrag = useCallback((i: number) => { setSelected(null); setHighlight(null); setDropI(-1); setDragI(i); }, []);
  const endDrag = useCallback((i: number, t: number) => {
    lastDrag.current = Date.now();
    setDragI(-1); setDropI(-1);
    const d = placed[i], target = placed[t];
    if (d && target && onMove && dropCheck(d, target).ok) onMove(d.node.id, target.node.id, d.node.name, target.node.name);
  }, [placed, onMove, dropCheck]);

  const pan = Gesture.Pan().minDistance(3).averageTouches(true)
    .onBegin((e) => { bx.value = e.x; by.value = e.y; beginT.value = Date.now(); })
    .onStart((e) => {
      sTx.value = tx.value; sTy.value = ty.value;
      dragIdx.value = -1;
      if (!dragOn.value || e.numberOfPointers !== 1) return;
      if (!fine.value && Date.now() - beginT.value < HOLD_MS) return;
      // Did the drag start on a person? (index 0 is the centre: never moved)
      const cx = (bx.value - tx.value) / sc.value;
      const cy = (by.value - ty.value) / sc.value;
      const h = hits.value;
      for (let i = 1; i < h.length; i += 1) {
        const dx = cx - h[i].x, dy = cy - h[i].y;
        if (Math.abs(dx) <= NODE_W / 2 - 8 && dy >= -(h[i].av / 2 + 10) && dy <= h[i].av / 2 + 36) { dragIdx.value = i; break; }
      }
      if (dragIdx.value >= 0) {
        gx.value = cx; gy.value = cy; tgtIdx.value = -1;
        runOnJS(beginDrag)(dragIdx.value);
      }
    })
    .onUpdate((e) => {
      if (dragIdx.value < 0) {
        tx.value = sTx.value + e.translationX; ty.value = sTy.value + e.translationY;
        return;
      }
      const cx = (e.x - tx.value) / sc.value;
      const cy = (e.y - ty.value) / sc.value;
      gx.value = cx; gy.value = cy;
      // Nearest person under the pointer (easier to hit when zoomed out).
      const reach = Math.max(48, 30 / sc.value);
      let best = -1, bd = reach * reach;
      const h = hits.value;
      for (let i = 0; i < h.length; i += 1) {
        if (i === dragIdx.value) continue;
        const dx = cx - h[i].x, dy = cy - (h[i].y + 8);
        const d2 = dx * dx + dy * dy;
        if (d2 < bd) { bd = d2; best = i; }
      }
      if (best !== tgtIdx.value) { tgtIdx.value = best; runOnJS(setDropI)(best); }
    })
    .onFinalize(() => {
      if (dragIdx.value >= 0) {
        runOnJS(endDrag)(dragIdx.value, tgtIdx.value);
        dragIdx.value = -1; tgtIdx.value = -1;
      }
    });
  const ghostStyle = useAnimatedStyle(() => {
    const k = Math.min(2.4, Math.max(1, 0.85 / sc.value));
    return {
      opacity: dragIdx.value >= 0 ? 1 : 0,
      transform: [{ translateX: gx.value - NODE_W / 2 }, { translateY: gy.value - 16 }, { scale: k }] as any,
    };
  });
  const pinch = Gesture.Pinch()
    .onStart((e) => { sSc.value = sc.value; sTx.value = tx.value; sTy.value = ty.value; fx.value = e.focalX; fy.value = e.focalY; })
    .onUpdate((e) => {
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, sSc.value * e.scale));
      const r = next / Math.max(0.001, sSc.value);
      tx.value = fx.value - (fx.value - sTx.value) * r;
      ty.value = fy.value - (fy.value - sTy.value) * r;
      sc.value = next;
    })
    .onEnd(() => { runOnJS(setZoomPct)(Math.round(sc.value * 100)); });
  const doubleTap = Gesture.Tap().numberOfTaps(2).onEnd(() => { runOnJS(fitTo)(viewport.w, viewport.h, true); });
  const gesture = Gesture.Race(doubleTap, Gesture.Simultaneous(pan, pinch));
  const canvasStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: sc.value }] as any,
    transformOrigin: 'top left' as any,
  }));

  if (!root || !L) {
    return (
      <View style={styles.empty}>
        <Ionicons name="git-network-outline" size={44} color={colors.textMuted} />
        <Text style={styles.emptyText}>No team to show yet.</Text>
      </View>
    );
  }

  const sel = selected ? byId.get(selected) : null;
  const selWeek = sel ? week[sel.node.id] : undefined;
  const roleOf = (n: TeamMapNode) => (n.is_super_admin ? 'Owner' : n.role === 'admin' ? 'Admin' : n.role === 'leader' ? 'Coach' : 'BA');
  const { centre, radii } = L;

  const dragging = dragI >= 0 ? placed[dragI] : undefined;
  const dropOn = dropI >= 0 ? placed[dropI] : undefined;
  const drop = dragging && dropOn ? dropCheck(dragging, dropOn) : null;
  const firstName = (n: string) => n.split(/\s+/)[0];

  const remove = async () => {
    if (!sel || !onRemove || busy) return;
    setBusy(true);
    try { await onRemove(sel.node.id, sel.node.name, sel.node.children.length); setSelected(null); } finally { setBusy(false); }
  };

  const changeStage = async (direction: 'promote' | 'demote') => {
    if (!sel || !onStageChange || busy) return;
    setBusy(true);
    try { await onStageChange(sel.node.id, direction, sel.node.name); } finally { setBusy(false); }
  };

  return (
    <GestureHandlerRootView style={styles.wrap}>
      <View style={[styles.viewport, { marginBottom: bottomInset }]} onLayout={onLayout}>
        <GestureDetector gesture={gesture}>
          <View style={[StyleSheet.absoluteFill, styles.noSelect]}>
          <Animated.View style={[{ width: size, height: size }, canvasStyle]}>
            <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
              <Defs>
                <Pattern id="dots" width={22} height={22} patternUnits="userSpaceOnUse">
                  <Circle cx={11} cy={11} r={1.1} fill={brand.lime} fillOpacity={0.1} />
                </Pattern>
              </Defs>
              <Rect x={0} y={0} width={size} height={size} fill="url(#dots)" />
              {/* Generation bands: one shaded ring per generation */}
              {radii.map((r, g) => {
                if (g === 0) return null;
                const inner = g === 1 ? r / 2 : (radii[g - 1] + r) / 2;
                const outerR = g === radii.length - 1 ? r + RING_STEP / 2 : (r + radii[g + 1]) / 2;
                const on = !highlight || (highlight.kind === 'gen' && highlight.value === g);
                return (
                  <React.Fragment key={`band${g}`}>
                    <Circle cx={centre} cy={centre} r={(inner + outerR) / 2} fill="none"
                      stroke={genColour(g)} strokeOpacity={on ? 0.07 : 0.02} strokeWidth={outerR - inner} />
                    <Circle cx={centre} cy={centre} r={r} fill="none" stroke={genColour(g)}
                      strokeOpacity={on ? 0.35 : 0.1} strokeWidth={1} strokeDasharray="3,6" />
                    <SvgText x={centre} y={centre - outerR + 20} fill={genColour(g)} fillOpacity={on ? 0.85 : 0.3}
                      fontSize={13} fontWeight="700" letterSpacing={2} textAnchor="middle">{`GEN ${g}`}</SvgText>
                  </React.Fragment>
                );
              })}
              {/* Straight spokes, coach → person */}
              {placed.filter((p) => p.parent).map((p) => {
                const a = p.parent!;
                const on = !lit || (lit.has(p.node.id) && lit.has(a.node.id));
                return (
                  <React.Fragment key={`l${p.node.id}`}>
                    <Line x1={a.x} y1={a.y} x2={p.x} y2={p.y} stroke={genColour(p.gen)} strokeOpacity={on ? 0.12 : 0.03} strokeWidth={6} />
                    <Line x1={a.x} y1={a.y} x2={p.x} y2={p.y} stroke={genColour(p.gen)} strokeOpacity={on ? 0.85 : 0.12} strokeWidth={1.4} />
                  </React.Fragment>
                );
              })}
            </Svg>

            {placed.map((p, idx) => {
              const n = p.node;
              const isDragged = dragI === idx;
              const isDrop = dropI === idx && !!drop;
              const isRoot = p.gen === 0;
              const av = isRoot ? AV_ROOT : AV;
              const coach = n.role !== 'trainee';
              const dim = !!lit && !lit.has(n.id);
              const isSel = selected === n.id;
              const ring = isRoot ? brand.lime : genColour(p.gen);
              const st = stageLabel(n.owneriq_stage);
              const tagH = n.team_name ? 18 : 0;
              return (
                <TouchableOpacity
                  key={n.id}
                  activeOpacity={0.8}
                  onPress={() => {
                    if (Date.now() - lastDrag.current < 400) return;   // the end of a drag isn't a tap
                    setHighlight(null); setSelected((s) => (s === n.id ? null : n.id));
                  }}
                  style={[styles.node, { left: p.x - NODE_W / 2, top: p.y - (av + 8) / 2 - tagH, opacity: isDragged ? 0.3 : dim ? 0.2 : 1 },
                    canMove && !isRoot && styles.grab]}
                >
                  {n.team_name ? (
                    <View style={styles.teamTag}><Text style={styles.teamTagText} numberOfLines={1}>{n.team_name}</Text></View>
                  ) : null}
                  <View style={[styles.ring, {
                    width: av + 8, height: av + 8, borderRadius: (av + 8) / 2, borderColor: ring,
                    borderWidth: isRoot ? 3 : coach ? 2.25 : 1.25,
                    shadowColor: ring, shadowOpacity: isRoot || isSel ? 0.8 : coach ? 0.4 : 0.15, shadowRadius: isRoot || isSel ? 16 : 8,
                  }, isDrop && (drop!.ok ? styles.dropOk : styles.dropNo)]}>
                    {n.profile_image ? (
                      <Image source={{ uri: n.profile_image }} {...({ draggable: false } as any)} style={{ width: av, height: av, borderRadius: av / 2 }} />
                    ) : (
                      <View style={[styles.avatar, { width: av, height: av, borderRadius: av / 2 }, coach || isRoot ? styles.avatarCoach : styles.avatarBa]}>
                        <Text style={[styles.avatarText, isRoot && { fontSize: 19 }]}>{initials(n.name)}</Text>
                      </View>
                    )}
                    {st ? (
                      <View style={[styles.stage, { borderColor: ring }]}><Text style={styles.stageText}>{st}</Text></View>
                    ) : null}
                  </View>
                  <View style={[styles.pill, isSel && { borderColor: ring }, isDrop && drop!.ok && styles.pillDrop]}>
                    <Text style={[styles.pillText, isDrop && drop!.ok && { color: brand.deep }]} numberOfLines={1}>
                      {isDrop && drop!.ok ? 'Move here' : isRoot ? n.name : n.name.split(/\s+/)[0]}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}

            {/* The name being carried */}
            <Animated.View pointerEvents="none" style={[styles.ghost, ghostStyle]}>
              <View style={styles.ghostPill}>
                <Ionicons name="move" size={12} color={brand.deep} />
                <Text style={styles.ghostText} numberOfLines={1}>{dragging ? firstName(dragging.node.name) : ''}</Text>
              </View>
            </Animated.View>
          </Animated.View>
          </View>
        </GestureDetector>

        {/* Drag hint / what a drop will do */}
        {canMove && onMove && !sel && !findOpen ? (
          <View pointerEvents="none" style={[styles.hint, narrow && { top: 52, right: 10 }, dragging && styles.hintOn, drop && !drop.ok && styles.hintNo]}>
            <Ionicons name={dragging ? (drop ? (drop.ok ? 'checkmark-circle' : 'close-circle') : 'move') : 'move-outline'} size={13}
              color={dragging ? (drop && !drop.ok ? '#fecaca' : brand.deep) : brand.sage} />
            <Text style={[styles.hintText, dragging && { color: drop && !drop.ok ? '#fecaca' : brand.deep }]} numberOfLines={1}>
              {!dragging ? 'Drag a name onto a Coach to move them'
                : !dropOn ? `Moving ${firstName(dragging.node.name)}: drop on a Coach`
                : drop?.ok ? `Release to move ${firstName(dragging.node.name)} to ${firstName(dropOn.node.name)}'s team`
                : drop?.why || 'Drop on a Coach'}
            </Text>
          </View>
        ) : null}

        {/* Generations at a glance: how many people sit on each ring. Tap one
            to light up just that generation. */}
        {/* On a phone the buttons take the top row, so the hint and these sit under them. */}
        <View style={[styles.gens, narrow && { right: 10 }, { top: (narrow ? 52 : 10) + (canMove && onMove && !sel ? 40 : 0) }, findOpen && { display: 'none' }]} pointerEvents="box-none">
          {L.perGen.slice(1).map((n, i) => {
            const g = i + 1;
            const on = highlight?.kind === 'gen' && highlight.value === g;
            return (
              <TouchableOpacity key={g} style={[styles.genChip, { borderColor: genColour(g) }, on && { backgroundColor: 'rgba(238,244,230,0.14)' }]}
                onPress={() => { setSelected(null); setHighlight(on ? null : { kind: 'gen', value: g }); }}
                accessibilityLabel={`Generation ${g}: ${n} people`} testID={`spider-gen-${g}`}>
                <View style={[styles.genDot, { backgroundColor: genColour(g), marginHorizontal: 0 }]} />
                <Text style={styles.genChipLabel}>Gen {g}</Text>
                <Text style={[styles.genChipCount, { color: genColour(g) }]}>{n}</Text>
              </TouchableOpacity>
            );
          })}
          <View style={[styles.genChip, { borderColor: 'rgba(255,255,255,0.18)' }]}>
            <Text style={styles.genChipLabel}>Total</Text>
            <Text style={[styles.genChipCount, { color: INK_TEXT }]}>{placed.length - 1}</Text>
          </View>
        </View>

        {/* Zoom controls */}
        <View style={styles.controls} pointerEvents="box-none">
          <TouchableOpacity style={[styles.ctl, findOpen && { borderColor: brand.lime }]} onPress={() => { setFindOpen((v) => !v); setFindText(''); }}
            accessibilityLabel="Find a person on the map" testID="spider-find">
            <Ionicons name="search" size={14} color={INK_TEXT} /><Text style={styles.ctlText}>Find</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.ctl} onPress={() => fitTo(viewport.w, viewport.h)}>
            <Ionicons name="scan-outline" size={14} color={INK_TEXT} /><Text style={styles.ctlText}>Fit</Text>
          </TouchableOpacity>
          <View style={styles.ctlGroup}>
            <TouchableOpacity style={styles.ctlIcon} onPress={() => zoomBy(1 / 1.25)}><Ionicons name="remove" size={16} color={INK_TEXT} /></TouchableOpacity>
            <Text style={styles.ctlPct}>{zoomPct}%</Text>
            <TouchableOpacity style={styles.ctlIcon} onPress={() => zoomBy(1.25)}><Ionicons name="add" size={16} color={INK_TEXT} /></TouchableOpacity>
          </View>
        </View>

        {/* Find a person */}
        {findOpen ? (
          <View style={styles.find}>
            <View style={styles.findBox}>
              <Ionicons name="search" size={15} color={brand.sage} />
              <TextInput
                value={findText}
                onChangeText={setFindText}
                placeholder="Type a name"
                placeholderTextColor="rgba(159,184,168,0.7)"
                style={styles.findInput}
                autoFocus
                autoCorrect={false}
                returnKeyType="search"
                onSubmitEditing={() => { if (matches[0]) goTo(matches[0]); }}
                testID="spider-find-input"
              />
              <TouchableOpacity onPress={() => { setFindOpen(false); setFindText(''); }} hitSlop={8} accessibilityLabel="Close find">
                <Ionicons name="close" size={16} color={INK_TEXT} />
              </TouchableOpacity>
            </View>
            {findText.trim() ? (
              matches.length ? matches.map((m) => (
                <TouchableOpacity key={m.node.id} style={styles.findRow} onPress={() => goTo(m)} testID={`spider-find-${m.node.id}`}>
                  <View style={[styles.genDot, { backgroundColor: genColour(m.gen), marginHorizontal: 0 }]} />
                  <Text style={styles.findName} numberOfLines={1}>{m.node.name}</Text>
                  <Text style={styles.findMeta} numberOfLines={1}>Gen {m.gen}{m.parent ? ` · under ${firstName(m.parent.node.name)}` : ''}</Text>
                </TouchableOpacity>
              )) : <Text style={styles.findNone}>Nobody by that name on the map.</Text>
            ) : null}
          </View>
        ) : null}

        {/* Ranks: people per OwnerIQ stage and per generation */}
        {!sel ? (
          <View style={styles.ranks}>
            <TouchableOpacity style={styles.ranksHead} onPress={() => setRanksOpen((o) => !o)}>
              <Ionicons name="layers-outline" size={15} color={INK_TEXT} />
              <Text style={styles.ranksTitle}>RANKS</Text>
              <Text style={styles.ranksMeta}>{placed.length - 1} people</Text>
              <Ionicons name={ranksOpen ? 'chevron-down' : 'chevron-up'} size={15} color={colors.textMuted} />
            </TouchableOpacity>
            {ranksOpen ? (
              <ScrollView style={{ maxHeight: 260 }} contentContainerStyle={{ paddingBottom: 6 }}>
                <Text style={styles.ranksSection}>Stages (OwnerIQ)</Text>
                {stageCounts.map(([s, n]) => {
                  const on = highlight?.kind === 'stage' && highlight.value === s;
                  return (
                    <TouchableOpacity key={s} style={[styles.rankRow, on && styles.rankRowOn]}
                      onPress={() => setHighlight(on ? null : { kind: 'stage', value: s })}>
                      <View style={styles.rankBadge}><Text style={styles.rankBadgeText}>{stageLabel(s) || '–'}</Text></View>
                      <Text style={styles.rankLabel}>{s === 'none' ? 'Not in OwnerIQ' : `Stage ${stageLabel(s)}`}</Text>
                      <Text style={styles.rankCount}>{n}</Text>
                    </TouchableOpacity>
                  );
                })}
                <Text style={styles.ranksSection}>Generations</Text>
                {L.perGen.slice(1).map((n, i) => {
                  const g = i + 1;
                  const on = highlight?.kind === 'gen' && highlight.value === g;
                  return (
                    <TouchableOpacity key={g} style={[styles.rankRow, on && styles.rankRowOn]}
                      onPress={() => setHighlight(on ? null : { kind: 'gen', value: g })}>
                      <View style={[styles.genDot, { backgroundColor: genColour(g) }]} />
                      <Text style={styles.rankLabel}>{genLabel(g)}</Text>
                      <Text style={styles.rankCount}>{n}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            ) : null}
          </View>
        ) : null}

        {/* Person card */}
        {sel ? (
          <View style={styles.card}>
            <View style={styles.cardTop}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.cardName} numberOfLines={1}>{sel.node.name}</Text>
                <Text style={styles.cardMeta} numberOfLines={2}>
                  {[roleOf(sel.node),
                    stageLabel(sel.node.owneriq_stage) ? `Stage ${stageLabel(sel.node.owneriq_stage)}` : null,
                    sel.gen > 0 ? genLabel(sel.gen) : null,
                    sel.node.team_name,
                    sel.teamSize ? `${sel.teamSize} in team` : null,
                    sel.parent ? `reports to ${sel.parent.node.name.split(/\s+/)[0]}` : null].filter(Boolean).join(' · ')}
                </Text>
              </View>
              {selWeek && selWeek.sales != null ? (
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={styles.cardNum}>{selWeek.sales}{selWeek.target ? <Text style={styles.cardNumT}> / {selWeek.target}</Text> : null}</Text>
                  <Text style={styles.cardNumL}>sign-ups this week</Text>
                </View>
              ) : null}
              <TouchableOpacity onPress={() => setSelected(null)} style={{ padding: 6 }}><Ionicons name="close" size={18} color={colors.textMuted} /></TouchableOpacity>
            </View>
            {onOpen ? (
              <View style={styles.cardActions}>
                <TouchableOpacity style={styles.btn} onPress={() => onOpen(sel.node.id)} testID="spider-open-person">
                  <Text style={styles.btnText}>Open full breakdown</Text><Ionicons name="chevron-forward" size={15} color={INK_TEXT} />
                </TouchableOpacity>
              </View>
            ) : null}
            {canEditStage && sel.gen > 0 && onStageChange ? (
              <View style={styles.cardActions}>
                <TouchableOpacity style={[styles.btn, styles.btnPrimary, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => changeStage('promote')}>
                  <Text style={styles.btnPrimaryText}>Advance</Text><Ionicons name="arrow-up" size={15} color={brand.deep} />
                </TouchableOpacity>
                <TouchableOpacity style={[styles.btn, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => changeStage('demote')}>
                  <Text style={styles.btnText}>Demote</Text><Ionicons name="arrow-down" size={15} color={INK_TEXT} />
                </TouchableOpacity>
                {onRemove && !sel.node.is_super_admin ? (
                  <TouchableOpacity style={[styles.btn, styles.btnDanger, busy && { opacity: 0.5 }]} disabled={busy} onPress={remove} testID="spider-remove">
                    <Text style={styles.btnDangerText}>Remove</Text><Ionicons name="person-remove-outline" size={15} color="#fca5a5" />
                  </TouchableOpacity>
                ) : null}
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    </GestureHandlerRootView>
  );
}


const PANEL = 'rgba(12,32,26,0.95)';

const createStyles = (c: any) => StyleSheet.create({
  wrap: { flex: 1 },
  viewport: { flex: 1, overflow: 'hidden', backgroundColor: CANVAS, marginHorizontal: 12, marginBottom: 8, borderRadius: 18,
    borderWidth: 1, borderColor: 'rgba(183,223,88,0.14)' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  emptyText: { fontFamily: fonts.body, color: c.textMuted },
  node: { position: 'absolute', width: NODE_W, alignItems: 'center' },
  noSelect: { userSelect: 'none' } as any,
  grab: { cursor: 'grab' } as any,
  dropOk: { borderColor: brand.lime, borderWidth: 3, shadowColor: brand.lime, shadowOpacity: 1, shadowRadius: 22 },
  dropNo: { borderColor: '#f87171', borderWidth: 3, shadowColor: '#f87171', shadowOpacity: 0.8, shadowRadius: 16 },
  pillDrop: { backgroundColor: brand.lime, borderColor: brand.lime },
  ghost: { position: 'absolute', left: 0, top: 0, width: NODE_W, alignItems: 'center', zIndex: 50 },
  ghostPill: { flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: NODE_W, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999,
    backgroundColor: brand.lime, boxShadow: '0 8px 22px rgba(0,0,0,0.45), 0 0 18px rgba(183,223,88,0.5)' } as any,
  ghostText: { fontFamily: fonts.body, fontWeight: '800', fontSize: 12, color: brand.deep },
  hint: { position: 'absolute', top: 10, left: 10, right: 250, alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6,
    height: 32, paddingHorizontal: 10, borderRadius: 10, backgroundColor: PANEL, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', maxWidth: 420 },
  hintOn: { backgroundColor: brand.lime, borderColor: brand.lime },
  hintNo: { backgroundColor: '#7f1d1d', borderColor: '#f87171' },
  hintText: { flexShrink: 1, fontFamily: fonts.body, fontWeight: '600', fontSize: 12, color: brand.sage },
  teamTag: { backgroundColor: brand.lime, borderRadius: 5, paddingHorizontal: 5, paddingVertical: 1, marginBottom: 4, maxWidth: NODE_W - 6 },
  teamTagText: { fontFamily: fonts.body, fontWeight: '800', fontSize: 8.5, letterSpacing: 0.6, color: brand.deep, textTransform: 'uppercase' },
  ring: { alignItems: 'center', justifyContent: 'center', backgroundColor: CANVAS, shadowOffset: { width: 0, height: 0 } },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  avatarCoach: { backgroundColor: '#163a2d' },
  avatarBa: { backgroundColor: '#0e2620' },
  avatarText: { fontFamily: fonts.body, fontWeight: '700', fontSize: 13, color: '#eef4e6', letterSpacing: 0.3 },
  stage: { position: 'absolute', right: -6, bottom: -4, minWidth: 20, height: 18, paddingHorizontal: 4, borderRadius: 9,
    backgroundColor: CANVAS, borderWidth: 1.25, alignItems: 'center', justifyContent: 'center' },
  stageText: { fontFamily: fonts.body, fontWeight: '800', fontSize: 9.5, color: '#eef4e6' },
  pill: { marginTop: 7, maxWidth: NODE_W - 4, paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999,
    backgroundColor: '#0f2a22', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)' },
  pillText: { fontFamily: fonts.body, fontWeight: '600', fontSize: 11.5, color: '#eef4e6' },
  controls: { position: 'absolute', top: 10, right: 10, flexDirection: 'row', gap: 6 },
  find: { position: 'absolute', top: 52, right: 10, width: 280, maxWidth: '94%', padding: 8, borderRadius: 14, backgroundColor: 'rgba(7,23,15,0.96)', borderWidth: 1, borderColor: 'rgba(183,223,88,0.3)', zIndex: 20 },
  findBox: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 42, paddingHorizontal: 10, borderRadius: 10, backgroundColor: 'rgba(238,244,230,0.07)' },
  findInput: { flex: 1, fontFamily: fonts.body, fontSize: 15, color: INK_TEXT, padding: 0, outlineStyle: 'none' } as any,
  findRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 8, borderRadius: 10 },
  findName: { flex: 1, fontFamily: fonts.bodySemibold, fontSize: 14, color: INK_TEXT },
  findMeta: { flexShrink: 0, fontFamily: fonts.body, fontSize: 11.5, color: brand.sage },
  findNone: { fontFamily: fonts.body, fontSize: 12.5, color: brand.sage, padding: 10 },
  ctl: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 32, paddingHorizontal: 10, borderRadius: 10,
    backgroundColor: PANEL, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' },
  ctlText: { fontFamily: fonts.body, fontWeight: '600', fontSize: 12, color: INK_TEXT },
  ctlGroup: { flexDirection: 'row', alignItems: 'center', height: 32, borderRadius: 10,
    backgroundColor: PANEL, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' },
  ctlIcon: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  ctlPct: { fontFamily: fonts.mono, fontSize: 11, color: INK_TEXT, minWidth: 38, textAlign: 'center' },
  gens: { position: 'absolute', top: 10, left: 10, right: 150, flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  genChip: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 28, paddingHorizontal: 9, borderRadius: 9,
    backgroundColor: PANEL, borderWidth: 1 },
  genChipLabel: { fontFamily: fonts.mono, fontSize: 10.5, letterSpacing: 0.6, color: INK_TEXT, textTransform: 'uppercase' },
  genChipCount: { fontFamily: fonts.body, fontWeight: '800', fontSize: 13 },
  ranks: { position: 'absolute', left: 10, bottom: 10, width: 230, borderRadius: 14, backgroundColor: PANEL,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', overflow: 'hidden' },
  ranksHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, height: 40 },
  ranksTitle: { fontFamily: fonts.body, fontWeight: '800', fontSize: 12, letterSpacing: 1, color: INK_TEXT },
  ranksMeta: { flex: 1, fontFamily: fonts.body, fontSize: 11, color: brand.sage },
  ranksSection: { fontFamily: fonts.body, fontWeight: '700', fontSize: 10, letterSpacing: 1, color: brand.sage,
    textTransform: 'uppercase', paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 },
  rankRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 6 },
  rankRowOn: { backgroundColor: 'rgba(183,223,88,0.12)' },
  rankBadge: { minWidth: 26, height: 20, borderRadius: 10, borderWidth: 1.25, borderColor: brand.lime,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  rankBadgeText: { fontFamily: fonts.body, fontWeight: '800', fontSize: 10, color: '#eef4e6' },
  genDot: { width: 12, height: 12, borderRadius: 6, marginHorizontal: 7 },
  rankLabel: { flex: 1, fontFamily: fonts.body, fontSize: 12.5, color: '#eef4e6' },
  rankCount: { fontFamily: fonts.mono, fontSize: 12, color: brand.lime },
  card: { position: 'absolute', left: 10, right: 10, bottom: 10, padding: 12, borderRadius: 16,
    backgroundColor: PANEL, borderWidth: 1, borderColor: 'rgba(183,223,88,0.3)', gap: 10 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cardName: { fontFamily: fonts.display, fontSize: 16, color: '#eef4e6' },
  cardMeta: { fontFamily: fonts.body, fontSize: 12, color: brand.sage, marginTop: 2 },
  cardNum: { fontFamily: fonts.body, fontWeight: '700', fontSize: 17, color: '#eef4e6' },
  cardNumT: { fontWeight: '400', fontSize: 12, color: brand.sage },
  cardNumL: { fontFamily: fonts.body, fontSize: 10, color: brand.sage },
  cardActions: { flexDirection: 'row', gap: 8 },
  btn: { flex: 1, height: 40, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)' },
  btnText: { fontFamily: fonts.body, fontWeight: '700', fontSize: 13.5, color: INK_TEXT },
  btnPrimary: { backgroundColor: brand.lime, borderColor: brand.lime },
  btnDanger: { borderColor: 'rgba(248,113,113,0.6)', backgroundColor: 'rgba(127,29,29,0.35)' },
  btnDangerText: { fontFamily: fonts.body, fontWeight: '700', fontSize: 13.5, color: '#fca5a5' },
  btnPrimaryText: { fontFamily: fonts.body, fontWeight: '800', fontSize: 13.5, color: brand.deep },
});
