/**
 * CodTopicList — the PDF's capability list, live.
 *
 * Pillar headers that stand out, one row per capability with a status dot,
 * the topic, and the five K·D·D·T·S boxes — deliberately UNNUMBERED: within
 * a stage the order is not a sequence (only the Stage 1 days are), so
 * nothing here implies "finish this before starting that". Tap a row to
 * open the module.
 *
 * Visual system ("Ink & Cube" §4 COD): each pillar is a DepthCard floating on
 * the page field, its category bar is a 3px gradient rail in the pillar's own
 * hue, and the K·D·D ticks are 30px rungs.
 *
 * Review R2: at 0% (every admin/leader view) the region went flat — the pillar
 * bar was a bare grey `trackBg` track and 68 rungs were the same pale lavender.
 * So every progress bed is now the track blended toward the pillar's OWN hue —
 * an unlit rail that previews what filling it looks like — each bed keeps a
 * minimum lit stub
 * so a pillar at 0% still shows a lit rung of rail, the per-row rail gained the
 * same lit segment, and an unlit K/D/D/T rung is washed with the pillar hue
 * instead of generic lavender — which is what widens the gap between a done
 * rung (brand gradient + white check) and an undone one at arm's length.
 * The hues themselves are theme-split: the bright table reads on the dark card
 * but #0ea5e9 / #f59e0b / #10b981 measure 1.8–2.6:1 on the WHITE card, so light
 * theme uses darkened twins that all clear 3:1 (review R2, minor).
 *
 * The rungs are FLAT keys, not Keycaps (review R1 / finding 37). Keycap's own
 * header caps it at "≤12 per screen" — this list alone draws 18 (trainee) to
 * 68 (the 17-module leader/admin view) of them, each carrying two inset bevels
 * plus a drop shadow, which is what pushed /progress to 92 boxShadow elements
 * against spec §5's cap of 12, on the one screen reps open daily on mid-range
 * Android. `Rung` keeps Keycap's size, radius and tone exactly and drops only
 * the bevel, so the ladder costs one View per rung. The card's pillar hue now
 * also runs down the rows as a ladder rail behind the dots and across a thin
 * "at Deliver" bar under the header, so 1500px of list reads as progress
 * rather than as an unchanging table. No handler, no state and no copy moved:
 * the row's TouchableOpacity still owns every tap.
 */
import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useColors, useTheme, fonts } from '../../theme/ThemeContext';
import { GRADIENT } from '../../theme/brand';
import { DepthCard } from '../ui/DepthCard';

// Pillar hues, per theme. DARK uses the bright table (every entry clears 3:1 on
// the raised forest card face #102d25); LIGHT uses darkened twins because the
// bright cyan/amber/green sample 2.8 / 2.2 / 2.6:1 on a white card — under the
// 3:1 a meaningful graphic needs, so the strip marking a rep's pillar was
// effectively invisible (review R2).
const PILLAR_COLORS: Record<string, string> = {
  'The Standard': '#b7df58',        // brand lime (9.6:1 on the forest card)
  'Commercial Craft': '#0ea5e9',
  'Self Leadership': '#f59e0b',
  'People Leadership': '#10b981',
  'Digital & Data': '#ef4444',
};
const PILLAR_COLORS_LIGHT: Record<string, string> = {
  'The Standard': '#2F6A4B',        // brand green, 6.2:1 on the card
  'Commercial Craft': '#0284C7',    // 4.1:1 (bright #0ea5e9 was 2.8:1)
  'Self Leadership': '#C2740A',     // 3.6:1 (bright #f59e0b was 2.2:1)
  'People Leadership': '#059669',   // 3.8:1 (bright #10b981 was 2.6:1)
  'Digital & Data': '#DC2626',      // 4.9:1
};

// Deepest brand green — the direction every gradient end is darkened toward.
const SHADE_INK = '#050f0c';

/**
 * Opaque blend of two 6-digit hex colours (t = 0 → a, 1 → b). Tokens are read,
 * never concatenated — and a non-hex value (should a theme ever make one rgba)
 * falls through unblended rather than producing `NaN`.
 */
const HEX6 = /^#[0-9a-fA-F]{6}$/;
function mix(a: string, b: string, t: number): string {
  if (!HEX6.test(a) || !HEX6.test(b)) return a;
  const pa = parseInt(a.slice(1, 7), 16);
  const pb = parseInt(b.slice(1, 7), 16);
  const ch = (shift: number) => Math.round(((pa >> shift) & 255) * (1 - t) + ((pb >> shift) & 255) * t);
  return '#' + [16, 8, 0].map((sh) => ch(sh).toString(16).padStart(2, '0')).join('');
}

/**
 * The pillar's 3px gradient (spec §4): its own hue as the MID stop with both
 * ends darkened toward the plum ink, so a filled bar is a gradient rail rather
 * than a flat status colour and every stop stays ≥3:1 on the card face.
 */
const barStops = (hue: string, dark: boolean) => (dark
  // On the dark card the ends must stay lifted or they sink into the face (at
  // 0.22 the darkest stop still measures ≥3.1:1 on #102D25); on white they can
  // go deep, which is what keeps every stop ≥3:1 there (8.7–12.7:1).
  ? [mix(hue, SHADE_INK, 0.1), hue, mix(hue, SHADE_INK, 0.22)] as const
  : [mix(hue, SHADE_INK, 0.28), hue, mix(hue, SHADE_INK, 0.46)] as const);
/**
 * The same rail UNLIT: the track blended toward the pillar's hue, so an empty
 * bar still shows the rail it is meant to fill (a flat `trackBg` at 0% was the
 * bare grey slot review R2 flagged). Blended, not alpha-over-track: a low-alpha
 * hue over the lavender track composites to a muddy grey-green/grey-pink.
 */
const bedStops = (hue: string, track: string) =>
  [mix(track, hue, 0.38), mix(track, hue, 0.2), mix(track, hue, 0.32)] as const;

const ALL_BOXES = [
  { rung: 1, letter: 'K' },
  { rung: 2, letter: 'D' },
  { rung: 3, letter: 'D' },
  { rung: 4, letter: 'T' },
  { rung: 5, letter: 'S' },
];

// Rungs: 30px per spec §4; the five-rung ladders (Stage 4 / SL) step down
// to 26px so the topic still gets two full lines at 390px.
const KEY_GAP = 4;
const keySize = (n: number) => (n >= 5 ? 26 : 30);

/**
 * Rung — a flat K·D·D·T·S key: Keycap's face and geometry with no bevel and
 * no drop shadow (spec §5 caps a screen at 12 boxShadow elements; a list row
 * must never carry one). Lit rungs keep the brand gradient so a signed-off
 * capability still pops off the row; an unlit rung is the card face washed 12%
 * toward the PILLAR's hue with a hue-tinted hairline — so the empty half of a
 * ladder is colour-coded to its pillar instead of the one pale lavender that
 * made 68 undone rungs read as an untouched table (review R2), and the step
 * from "washed hue" to "magenta→indigo gradient + white check" is wide enough
 * to read at arm's length.
 */
function Rung({ size, radius, lit, hue, ring, children }: {
  size: number;
  radius: number;
  lit: boolean;
  hue: string;
  ring?: string;
  children?: React.ReactNode;
}) {
  const colors = useColors();
  const box = { width: size, height: size, borderRadius: radius } as const;
  if (lit) {
    return (
      <LinearGradient
        colors={GRADIENT}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={[s.rung, box]}
      >
        {children}
      </LinearGradient>
    );
  }
  return (
    <View
      style={[s.rung, box, {
        backgroundColor: mix(colors.background, hue, 0.1),
        borderWidth: ring ? 1.5 : 1,
        borderColor: ring || mix(colors.border, hue, 0.62),
      }]}
    >
      {children}
    </View>
  );
}

export function CodTopicList({ modules, progressById, onPress }: {
  modules: any[];
  progressById: Record<string, any>;
  onPress: (m: any) => void;
}) {
  const colors = useColors();
  const dark = useTheme().effective === 'dark';
  // Ladder height per stage: 1-2 → Deliver, 3 → Teach, 4/SL → Systemize.
  const stage = modules[0]?.stage as number | undefined;
  const BOXES = ALL_BOXES.filter((b) => b.rung <= (!stage ? 5 : stage <= 2 ? 3 : stage === 3 ? 4 : 5));
  const KEY = keySize(BOXES.length);
  const byCategory: Record<string, any[]> = {};
  const order: string[] = [];
  modules.forEach((m) => {
    const c = m.category || 'Other';
    if (!byCategory[c]) { byCategory[c] = []; order.push(c); }
    byCategory[c].push(m);
  });

  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 4 }}>
      {order.map((cat, ci) => {
        const accent = (dark ? PILLAR_COLORS[cat] : PILLAR_COLORS_LIGHT[cat]) || colors.primary;
        const bar = barStops(accent, dark);
        const bed = bedStops(accent, colors.trackBg);
        const rows = byCategory[cat];
        const delivered = rows.filter((m) => (progressById[m.id]?.ladder || 0) >= 3).length;
        const pct = Math.round((delivered / Math.max(1, rows.length)) * 100);
        return (
          <DepthCard key={cat} style={s.card} index={ci}>
            <View style={s.pillarHead}>
              {/* 3px gradient rail — the pillar's hue, brightest at the top and
                  darkening into the card. Every stop is opaque and ≥3:1 on the
                  card face: the old `accent + '33'` tail sampled 1.8:1 on white,
                  i.e. the strip marking a rep's pillar was invisible (R2). */}
              <LinearGradient
                colors={dark
                  ? [accent, mix(accent, SHADE_INK, 0.1), mix(accent, SHADE_INK, 0.22)] as const
                  : [accent, mix(accent, SHADE_INK, 0.3), mix(accent, SHADE_INK, 0.5)] as const}
                start={{ x: 0, y: 0 }}
                end={{ x: 0, y: 1 }}
                style={s.pillarBar}
              />
              <Text style={[s.pillarTitle, { color: colors.text }]}>{cat}</Text>
              <Text style={[s.pillarCount, { color: colors.textMuted }]}>
                {delivered}/{rows.length} at Deliver
              </Text>
            </View>
            {/* The same count as a bar: how far down this pillar's ladder the
                rep actually is. The BED is the same rail unlit (the track blended
                toward the pillar hue, never bare grey) and the fill keeps a
                minimum stub, so a pillar at 0% still shows the rail it is meant
                to fill instead of going flat (R2). Static, no loop. */}
            <LinearGradient
              colors={bed}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={s.track}
            >
              <LinearGradient
                colors={bar}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={[s.trackFill, { width: `${pct}%` }]}
              />
            </LinearGradient>
            <View style={s.rows}>
              {/* Ladder rail: the hue runs behind the status dots so a long
                  list reads as one climb per pillar, not a table of ticks. */}
              {rows.length > 1 ? (
                <View pointerEvents="none" style={[s.rail, { backgroundColor: mix(colors.border, accent, 0.45) }]}>
                  <LinearGradient
                    colors={bar}
                    start={{ x: 0.5, y: 0 }}
                    end={{ x: 0.5, y: 1 }}
                    style={[s.railFill, { height: `${pct}%` }]}
                  />
                </View>
              ) : null}
              {rows.map((m, i) => {
                const p = progressById[m.id];
                const ladder = p?.ladder || 0;
                const pendingRung = !!p?.ready_for_check;
                return (
                  <TouchableOpacity
                    key={m.id}
                    style={[s.row, i > 0 && { borderTopWidth: 1, borderTopColor: colors.border }]}
                    activeOpacity={0.7}
                    onPress={() => onPress(m)}
                  >
                    <View style={[s.dot,
                      ladder >= 3 ? { backgroundColor: colors.green }
                        : (ladder > 0 || pendingRung || p?.quiz_passed) ? { backgroundColor: colors.yellow }
                          : { backgroundColor: colors.borderDark }]} />
                    <Text style={[s.topic, { color: colors.text }]} numberOfLines={2}>{m.topic}</Text>
                    <View style={[s.boxRow, { gap: KEY_GAP }]}>
                      {BOXES.map((b) => {
                        const on = ladder >= b.rung;
                        const pending = !on && pendingRung && b.rung === ladder + 1;
                        const radius = Math.round(KEY * 0.3);
                        return (
                          <Rung key={b.rung} size={KEY} radius={radius} lit={on} hue={accent} ring={pending ? colors.yellow : undefined}>
                            {on
                              ? <Ionicons name="checkmark" size={Math.round(KEY * 0.5)} color="#fff" />
                              : pending
                                ? <Ionicons name="hourglass-outline" size={Math.round(KEY * 0.45)} color={colors.yellow} />
                                : <Text style={[s.boxLetter, { color: colors.textMuted }]}>{b.letter}</Text>}
                          </Rung>
                        );
                      })}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          </DepthCard>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  // DepthCard owns the face + layered shadow (no overflow:'hidden' — it would
  // clip the card's own drop shadow on Android).
  card: { borderRadius: 18, marginTop: 12, paddingHorizontal: 12, paddingBottom: 6 },
  pillarHead: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12, marginBottom: 6 },
  pillarBar: { width: 3, alignSelf: 'stretch', minHeight: 20, borderRadius: 2 },
  pillarTitle: { flex: 1, fontFamily: fonts.display, fontSize: 15, letterSpacing: -0.2 },
  pillarCount: { fontFamily: fonts.bodyBold, fontSize: 11 },
  track: { height: 5, borderRadius: 2.5, overflow: 'hidden', marginBottom: 2 },
  // minWidth is the zero-state: 7px of lit rail even at 0% (spec's 2–3px floor
  // plus the radius), so the bar never renders as an empty grey slot.
  trackFill: { height: '100%', borderRadius: 2.5, minWidth: 7 },
  rows: { position: 'relative' },
  // Sits under the 9px dots (centre x = 4.5); the 22px insets land it on the
  // first and last dot whether the topic wraps to one line or two.
  rail: { position: 'absolute', left: 3.5, top: 22, bottom: 22, width: 2, borderRadius: 1, overflow: 'hidden' },
  railFill: { position: 'absolute', top: 0, left: 0, right: 0, borderRadius: 1, minHeight: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 9 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  topic: { flex: 1, fontFamily: fonts.body, fontSize: 13.5, lineHeight: 18 },
  boxRow: { flexDirection: 'row' },
  // Flat key: Keycap's geometry, none of its bevel/drop shadow (see header).
  rung: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  // Unbounded SemiBold — never add fontWeight to displayWide (faux-bold on web)
  boxLetter: { fontFamily: fonts.displayWide, fontSize: 10.5 },
});
