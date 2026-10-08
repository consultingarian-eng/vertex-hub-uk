/**
 * Sales Development Path — intro page ("how the path works").
 *
 * The front door for the second of the two ladders: the 30-day runway, the
 * six proficiency levels with the honest money arc, and how it's all
 * measured. Sister page to /cod-intro (the business-development ladder).
 *
 * Level lines and ramp targets render from the server's merged content when
 * the feature is live (admin-edited copy wins); static fallbacks otherwise
 * so the page still teaches while an office is dark.
 *
 * Visual system ("Ink & Cube", spec §4 P0): a pop hero bleeding under the
 * masthead with a 150px Rubik cube, the principle as an ink block quote in
 * gradient type, gradient section heads, the runway as a card stack with
 * numbered hex coins on a lit XP rail, the career map as coins on a neon
 * trail (JourneyPath), a gradient-rimmed level card with rank ribbons, a
 * glow CTA and an ink footer. Every user-visible string is untouched.
 *
 * ONE non-visual change rides along, called out so it is not mistaken for
 * styling: the ramp-target FALLBACK is now [7, 10, 12, 15], matching
 * `backend/core/sales_path.py` DEFAULT_RAMP_TARGETS and the live
 * sales_path_settings doc. b095e6d7 ("Ramp from the start week") moved the
 * ramp to 7/10/12/15 but only migrated two of the five frontend fallbacks,
 * so this one still rendered the abandoned 6/9/12 runway whenever the
 * feature is off or the API has not answered yet. See
 * docs/graphic-overhaul/orchestrator-findings.md §15.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useParallaxScroll } from '../src/components/ui/Parallax';
import { ScrollProgress, ScrollReveal } from '../src/components/ui/ScrollFx';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Polygon, Stop } from 'react-native-svg';
import { useQuery } from '@tanstack/react-query';
import { useColors, useTheme, fonts } from '../src/theme/ThemeContext';
import { GRADIENT, GRADIENT_TEXT, GRADIENT_XP } from '../src/theme/brand';
import { useTabBarClearance } from '../src/customization/CustomTabBar';
import { LinearGradient } from 'expo-linear-gradient';
import { apiService } from '../src/api/client';
import { EditorialHero } from '../src/components/ui/EditorialHero';
import { DepthCard, CardStack } from '../src/components/ui/DepthCard';
import { SectionHead } from '../src/components/ui/SectionHead';
import { GradientText } from '../src/components/ui/GradientText';
import { HexCoin, hexPoints } from '../src/components/ui/HexCoin';
import { RankRibbon } from '../src/components/ui/RankRibbon';
import { GlowButton } from '../src/components/ui/GlowButton';
import { SalesPathJourney } from '../src/components/salespath/SalesPathJourney';
import { NextUpChecklist } from '../src/components/salespath/NextUpChecklist';
import { GREEN_WEEK_MIN, WEEK_BAND_LABELS, AMBER_WEEK_MIN } from '../src/utils/weekBands';

// NOTE: these week bands duplicate TYPICAL_WEEKS in backend/core/sales_path.py.
// They were stale once already — the backend was halved on 2026-09-14 and this
// array still read "weeks 50–200" on screen. If you change one, change both.
const LEVELS = [
  { n: 1, emoji: '🌱', name: 'Beginner', weeks: '1–3',
    takes: 'Finish your 8 training days and get selling.',
    fallback: "Everyone starts here. You're learning the role — what you earn this week says nothing about what you'll earn next month." },
  { n: 2, emoji: '🥉', name: 'Competency', weeks: '2–10',
    takes: `Your first Green Week — ${GREEN_WEEK_MIN}+ sign-ups in one week, after training — plus your Stage 1 sales skills signed off.`,
    fallback: `Your first Green Week — ${GREEN_WEEK_MIN}+ sign-ups in one week. Real money starts here, and most people get here quickly.` },
  { n: 3, emoji: '🥈', name: 'Proficiency', weeks: '4–25',
    takes: '3 Green Weeks, a 15-a-week pace (3 sign-ups a day), 2+ sign-ups on 14 of your last 20 days out, and your Stage 2 sales skills signed off.',
    fallback: `15 sign-ups a week is your normal now — well past the ${GREEN_WEEK_MIN}-a-week Green Week. Steady, strong money.` },
  { n: 4, emoji: '🥇', name: 'Advanced', weeks: '10–25',
    takes: '2+ sign-ups on 16 of your last 20 days out — 8 in every 10 — at the 15-a-week pace (3 sign-ups a day).',
    fallback: "2+ sign-ups on 8 out of 10 days at a 15-a-week pace. You're one of the top earners now." },
  { n: 5, emoji: '🏅', name: 'Expert', weeks: '13–38',
    takes: '2+ sign-ups on 27 of 30 days at the 15-a-week pace — then do it again for the next 30. Then your coach signs it.',
    fallback: '2+ sign-ups on 9 out of 10 days, month after month. The biggest earnings in the field.' },
  { n: 6, emoji: '🐐', name: 'Mastery', weeks: '25–100',
    takes: 'Hold Expert for 12+ weeks and coach someone to their first Green Week. Signed by an admin.',
    fallback: 'The best of the best — the people everyone else learns from, and paid like it.' },
];

// Fallback meta for when the feature is dark or the query is still loading —
// which is what MOST viewers get, since Sales Path ships behind a flag. It is
// DERIVED from LEVELS above rather than retyped: this object used to hold its
// own copy of the week bands and still read the pre-halving "50–200" long
// after LEVELS was corrected, so the stale numbers were the ones on screen.
const FALLBACK_META = {
  level_names: Object.fromEntries(LEVELS.map((l) => [l.n, l.name])),
  typical_weeks: Object.fromEntries(LEVELS.map((l) => [l.n, l.weeks])),
};

// The Traffic Light System — the owner's "What Good Looks Like" weekly tiers
// (src/utils/weekBands.ts: Super Green 10+, Green 8–9, Amber 6–7, Red 5 and
// under). Kicks in AFTER the ramp-up weeks are done.
//
// `color` is the SIGNAL colour: the accent rail and the wash, where the vivid
// band hue belongs. `label` is the same band read as TYPE, and type has to
// clear 4.5:1 on the card face (spec §6.5) — the vivid greens/ambers do not
// (GREEN #22c55e is 2.1:1 on the washed paper face), so the label darkens in
// light and lightens in dark. Measured on the real faces (#FFFFFF / #102D25
// under each wash): 5.8/4.6/4.7/5.7 light, 12.0/9.1/8.8/5.9 dark.
const TLS = [
  { name: 'SUPER GREEN', band: `${WEEK_BAND_LABELS.super_green.range} sign-ups a week`, color: '#15803d', bg: '#15803d18',
    label: { light: '#0F6B33', dark: '#86EFAC' },
    lines: ['Run meetings for the whole office', 'Pitch for extra incentives & ££', 'First pick of new-starts', 'Learn & run campaign training'] },
  { name: 'GREEN', band: `${WEEK_BAND_LABELS.green.range} sign-ups a week`, color: '#22c55e', bg: '#22c55e18',
    label: { light: '#15803D', dark: '#4ADE80' },
    lines: ["In Coaches' Meetings", 'Pitch for new-starts & coach', 'Vice-captain sectors', 'Run sectors, sales impacts & retrains'] },
  { name: 'AMBER', band: `${WEEK_BAND_LABELS.amber.range} sign-ups a week`, color: '#d97706', bg: '#f59e0b20',
    label: { light: '#A15C07', dark: '#FBBF24' },
    lines: ["No Coaches' Meetings, no running sectors", 'In sales impact — everyday retraining', 'No office recruitment', '3 Amber weeks in a row = back to Stage 2'] },
  { name: 'RED', band: WEEK_BAND_LABELS.red.range, color: '#dc2626', bg: '#ef444418',
    label: { light: '#B91C1C', dark: '#F87171' },
    lines: ['Retrain the following Monday, goal of 7 that week', 'You get TWO weeks to climb out, not one', 'Two Reds back to back = deep red — one final week to turn it around (role suitability review)'] },
];

const MEASURED = [
  { icon: 'calendar' as const, text: "You don't fill anything in for this. It's taken automatically from your field performance." },
  { icon: 'flag' as const, text: "2 sign-ups and the day counts towards your level. 3 is the day you're actually after — that's the pace the top levels are set at. Get 1 and it's still a day you worked, it just doesn't count." },
  { icon: 'trending-up' as const, text: "It only looks at your last 20 days actually out on the doors. Days off, holidays and quiet weeks are skipped — they can't drag you down." },
  { icon: 'shield-checkmark' as const, text: "Once you reach a level you keep it. A bad week can't take it off you. The smaller numbers underneath just show how you're going right now." },
  { icon: 'people' as const, text: "The first few levels arrive on their own once your numbers get there. The top two don't — somebody has to watch you work and sign them off. That's what makes them worth having." },
];

// Hero lede — one string so EditorialHero gives it the house type (copy unchanged).
const HERO_LEDE = 'There are two ladders here. The Cycle of Development ladder — the COD — is about leading — and you can climb that one fast. This one is about selling: how good you actually are at the doors, from your first sign-up to the very top. It never stops, whatever your title is.';

// Ink glyph colour on light coin metals (HexCoin's numeral contrast rule).
const COIN_INK = '#0b211c';

// Hero cube (spec §1.2 "the brand cube is a live 3D object", §3.3 "Sales Path
// intro hero — 150 rubik").
//
const HERO_CUBE = { size: 150, right: -30, top: 118 } as const;
const RAMP_COIN = 36;
const RAMP_ROW_PAD = 12;
// Coin centre inside a runway row (row top padding + the coin column's 1px
// nudge + half a coin) — the only number the lit rail needs.
const RAMP_COIN_CENTER = RAMP_ROW_PAD + 1 + RAMP_COIN / 2;

// The runway rail is drawn PER ROW, never from a cross-row measurement: on
// react-native-web `onLayout` is a ResizeObserver on the element itself, so it
// fires when a row RESIZES but never when a row merely SHIFTS DOWN because the
// text above it re-wrapped (the web font swapping in re-wraps week 3). A rail
// sized from another row's y therefore froze at its first-layout value and
// stopped short of the trophy. Each row now lights its own slice of the XP
// gradient instead, so no row needs to know where another row sits.
const hexMix = (a: string, b: string, t: number) => {
  const parse = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const chan = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  return `#${chan(ar, br)}${chan(ag, bg)}${chan(ab, bb)}`;
};
/** GRADIENT_XP sampled at 0..1 — magenta → violet → cyan down the coin column. */
const xpAt = (t: number) => {
  const stops = GRADIENT_XP;
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  return hexMix(stops[i], stops[i + 1], x - i);
};

/**
 * BandHex — the traffic-light band as a rank medallion: the house hex coin cut
 * in the band's own signal colour (light rim, dark underside), so a GREEN+ /
 * GREEN / AMBER / RED week reads as a LEVEL at a glance, the way every other
 * level on this page does. Pure SVG: no shadow element, no loop.
 *
 * It carries no glyph on purpose — the band name sits beside it and the copy
 * is frozen, so the coin adds rank language without inventing a label.
 */
function BandHex({ color, size }: { color: string; size: number }) {
  const uid = React.useId().replace(/[^a-zA-Z0-9]/g, '');
  const id = `bandhex${uid}`;
  const r = size * 0.47;
  const face = hexPoints(size / 2, size / 2, r);
  const rimW = Math.max(1, size * 0.06);
  const rim = hexPoints(size / 2, size / 2, r - rimW * 0.9);
  return (
    <Svg width={size} height={size} pointerEvents="none">
      <Defs>
        <SvgLinearGradient id={id} x1={0} y1={0} x2={1} y2={1}>
          <Stop offset="0%" stopColor={hexMix(color, '#ffffff', 0.62)} />
          <Stop offset="55%" stopColor={color} />
          <Stop offset="100%" stopColor={hexMix(color, '#000000', 0.32)} />
        </SvgLinearGradient>
      </Defs>
      <Polygon points={face} fill={`url(#${id})`} />
      <Polygon
        points={rim}
        fill="none"
        stroke={hexMix(color, '#ffffff', 0.7)}
        strokeOpacity={0.9}
        strokeWidth={rimW}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export default function SalesPathIntroScreen() {
  const colors = useColors();
  const { effective } = useTheme();
  const isDark = effective === 'dark';
  const styles = useMemo(() => createStyles(colors), [colors]);
  const tabBarClearance = useTabBarClearance();
  const router = useRouter();

  // Live copy + ramp targets when the feature is on (admin edits win).
  const salesPathQ = useQuery({
    queryKey: ['sales-path-me'],
    queryFn: () => apiService.getMySalesPath().then((r) => r.data),
  });
  const content = salesPathQ.data?.enabled ? salesPathQ.data?.content : undefined;
  // Fallback mirrors backend DEFAULT_RAMP_TARGETS (see the header note) — not a
  // visual change; keep the two in step if the office ramp ever moves again.
  const targets = content?.ramp_targets || [7, 10, 12, 15];
  // The ramp week that first reaches a Green Week — its row carries the
  // Green Week line, wherever the office's runway puts it.
  const greenRampIdx = targets.findIndex((t) => t >= GREEN_WEEK_MIN);
  const myLevel = salesPathQ.data?.enabled ? salesPathQ.data?.path?.level : null;
  // Live progress toward the level above — the server's own gate numbers.
  // Null at Mastery (no next level) and while the feature is dark.
  const nextUp = (salesPathQ.data?.enabled && salesPathQ.data?.path?.next_up) || null;
  // Tap a level on the map → its what-it-takes card. Defaults to the level
  // AFTER yours (the one you're chasing).
  const [sel, setSel] = useState<number | null>(null);
  // Scroll-reactive layer: hero parallax, read-progress bar, sections that
  // glide in as they enter the viewport.
  const { scrollY, onScroll } = useParallaxScroll();
  const [contentH, setContentH] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const shown = sel ?? Math.min((myLevel || 1) + 1, 6);
  const shownDef = LEVELS[shown - 1];
  // The map renders even while the feature is dark / data is loading — a
  // brand-new hire on day 1 still gets the whole picture.
  const journeyPath = (salesPathQ.data?.enabled && salesPathQ.data?.path)
    ? salesPathQ.data.path
    : ({ level: 1, green_weeks: 0, ramp: null } as any);
  const journeyMeta = (salesPathQ.data?.enabled && salesPathQ.data?.meta)
    ? salesPathQ.data.meta
    : (FALLBACK_META as any);

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: 'The Sales Path' }} />
      <ScrollProgress scrollY={scrollY} contentH={contentH} viewportH={viewportH} />
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingTop: 0, paddingBottom: 32 + tabBarClearance }}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onContentSizeChange={(_w, h) => setContentH(h)}
        onLayout={(e) => setViewportH(e.nativeEvent.layout.height)}
      >
        {/* Pop hero: bleeds edge-to-edge straight under the masthead hairline
            (square top, `topEdge`), with the Rubik cube cut off at the right.
            The masthead already pads the safe area, so the block's own top
            padding is a fixed 26 — not insets.top. */}
        <EditorialHero
          variant="pop"
          topEdge
          scrollY={scrollY}
          cube={HERO_CUBE}
          kicker={<Text style={styles.kicker}>SALES DEVELOPMENT PATH</Text>}
          title="Two ladders. One person."
          lede={<Text style={styles.lede}>{HERO_LEDE}</Text>}
          style={styles.hero}
        />

        {/* The principle — an ink block quote riding up over the hero's bottom edge. */}
        <DepthCard variant="ink" index={0} style={styles.principleCard}>
          <View style={styles.principleRule}>
            <LinearGradient colors={GRADIENT_XP} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
          </View>
          <GradientText colors={GRADIENT_TEXT} style={styles.principleText}>
            Your level comes from what you do — not how long you've been here or what your title is.
          </GradientText>
        </DepthCard>

        <SectionHead size={26} style={styles.sectionHead}>Your first 30 days — the runway</SectionHead>
        <Text style={styles.sectionSub}>
          {content?.journey_ramp_body ||
            `Your ramp starts the week you do — BA Academy, first field days, first sign-ups, all counting from day one. A Green Week (${GREEN_WEEK_MIN}+ sign-ups) is the minimum to build to, not the finish line.`}
        </Text>
        <ScrollReveal scrollY={scrollY}>
        {/* depth={1}: one ghost behind the deck keeps the screen inside the
            ≤12 boxShadow budget (spec §5) — CardStack ghosts are real DepthCards. */}
        <CardStack depth={1} style={styles.rampStack}>
        <DepthCard style={styles.card} sheen>
          {targets.map((t, i) => (
            <View key={i} style={styles.rampRow}>
              {/* This row's slice of the lit rail: coin centre → row bottom on
                  the first row, top → bottom on the rest. Self-contained, so a
                  re-wrap above can never leave the rail hanging in mid-air. */}
              <View
                pointerEvents="none"
                style={[
                  styles.rampRail,
                  // Only the true ends of the rail are capped, so consecutive
                  // rows butt together with no pinch at the join.
                  i === 0 && { top: RAMP_COIN_CENTER, borderTopLeftRadius: 1.5, borderTopRightRadius: 1.5 },
                ]}
              >
                <LinearGradient
                  colors={[xpAt(i / targets.length), xpAt((i + 1) / targets.length)]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 0, y: 1 }}
                  style={StyleSheet.absoluteFill}
                />
              </View>
              <View style={styles.rampCoinCol}>
                <HexCoin size={RAMP_COIN} tint="purple" animate={false}>{String(i + 1)}</HexCoin>
              </View>
              <View style={[styles.rampBody, styles.rowDivider]}>
                <Text style={styles.rampName}>Week {i + 1} — build to {t} sign-ups</Text>
                <Text style={styles.rampDesc}>
                  {i === 0 ? 'Your start week: BA Academy, your first field days, your first sign-ups. Missing a week never locks anything — your coach works through it with you.'
                    : i === greenRampIdx ? `${t} — that's a Green Week (${GREEN_WEEK_MIN}+). See the Earnings Calculator for what it's worth.`
                    : greenRampIdx >= 0 && i > greenRampIdx ? `${t} — prove the Green Week is behind you. This is the pace that lasts.`
                    : `${t} is the worst case, not the aim — your training days finish and the doors are yours.`}
                </Text>
              </View>
            </View>
          ))}
          <View style={styles.rampRow}>
            {/* The rail's last stub — stops dead on the trophy's centre. */}
            <View pointerEvents="none" style={styles.rampRailStub}>
              <LinearGradient
                colors={[xpAt(1), xpAt(1)]}
                start={{ x: 0, y: 0 }}
                end={{ x: 0, y: 1 }}
                style={StyleSheet.absoluteFill}
              />
            </View>
            <View style={styles.rampCoinCol}>
              <HexCoin size={RAMP_COIN} tint="green" animate={false}>
                <Ionicons name="trophy" size={16} color={COIN_INK} />
              </HexCoin>
            </View>
            <View style={styles.rampBody}>
              <Text style={styles.rampName}>Ramp complete</Text>
              <Text style={styles.rampDesc}>Whenever your Green Week lands — week 3 or week 6, it counts the same.</Text>
            </View>
          </View>
        </DepthCard>
        </CardStack>
        </ScrollReveal>
        <Text style={styles.floorNote}>
          Those weekly numbers are an example runway, not a limit — plenty of people smash past them and hit their Green Week early. If that's you, brilliant: the ladder starts climbing sooner.
        </Text>

        <SectionHead size={26} style={styles.sectionHead}>After the ramp: the Traffic Light System</SectionHead>
        <Text style={styles.sectionSub}>
          Once your ramp-up weeks are done, every week gets a colour. Green is the standard — steady money — and the colours come with real perks and real consequences.
        </Text>
        {TLS.map((t, idx) => {
          const label = isDark ? t.label.dark : t.label.light;
          // The top tier is told apart by DEPTH, not another green: GREEN+ wears
          // the gradient rim and the glow halo the rest of the system reserves
          // for "the one you're chasing", so it can never be mistaken for GREEN
          // at arm's length in sunlight.
          const top = idx === 0;
          // The top tier is told apart by its OWN hue: a 2px rim in the band's
          // colour (the bright label tint in dark, where the deep green would
          // sink into the card). It used to wear the brand gradient rim + glow
          // halo — but magenta→violet is this app's "this is you / current"
          // accent everywhere else, so a new hire read the top tier as their own
          // selected state, and a magenta rim around a green card clashed.
          // Featured now = bigger medallion + a lit rim in its own colour.
          const rim = isDark ? t.label.dark : t.color;
          return (
          <ScrollReveal key={t.name} scrollY={scrollY}>
          {/* No sheen on the band cards: the holographic gleam washes cyan over
              the two GREEN cards, and the colour IS the content here (spec §5
              also keeps sheen off list rows). The wash + accent rail carry it. */}
          <DepthCard style={[styles.tlsCard, top && { borderWidth: 2, borderColor: rim }]}>
            {/* Colour wash: the measured strength stays where the type sits (top
                left) and fades away down the face, so the card lifts off the
                lavender field instead of lying flat on it. */}
            <LinearGradient
              pointerEvents="none"
              colors={[t.bg, t.color + '08']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={[StyleSheet.absoluteFill, styles.tlsWash]}
            />
            {/* Accent rail — lit metal, not a flat bar. */}
            <View pointerEvents="none" style={styles.tlsRail}>
              <LinearGradient
                colors={[hexMix(t.color, '#ffffff', 0.5), t.color, hexMix(t.color, '#000000', 0.3)]}
                start={{ x: 0.5, y: 0 }}
                end={{ x: 0.5, y: 1 }}
                style={StyleSheet.absoluteFill}
              />
            </View>
            <View style={styles.tlsHead}>
              <BandHex color={t.color} size={top ? 30 : 26} />
              <Text style={[styles.tlsName, { color: label }]}>{t.name}</Text>
              {/* The band figure promoted out of the run-on: its own chip on the
                  right of the header row, rimmed in the band's colour. */}
              <View
                style={[
                  styles.tlsBandChip,
                  {
                    borderColor: t.color + '66',
                    backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.86)',
                  },
                ]}
              >
                <Text style={[styles.tlsBand, { color: label }]}>{t.band}</Text>
              </View>
            </View>
            {/* Real hanging indent: the bullet owns a fixed column so a wrapped
                line keeps the list's left edge (strings unchanged). */}
            {t.lines.map((ln, i) => (
              <View key={i} style={styles.tlsBullet}>
                <Text style={styles.tlsDot}>•</Text>
                <Text style={styles.tlsLine}>{ln}</Text>
              </View>
            ))}
          </DepthCard>
          </ScrollReveal>
          );
        })}
        <Text style={styles.floorNote}>
          Drop under {AMBER_WEEK_MIN} and you're in the red zone — you start the next week on Red. Sickness or business travel counts pro-rata, so a short week never unfairly colours you.
        </Text>

        <SectionHead size={26} style={styles.sectionHead}>The full path, in one picture</SectionHead>
        <Text style={styles.sectionSub}>
          {content?.arc_line || "Getting good takes a few weeks. Getting great takes months — and pays a lot more. Don't judge yourself on one bad week."}
        </Text>
        <SalesPathJourney path={journeyPath} meta={journeyMeta} onSelectLevel={setSel} />
        {shownDef && (
          <DepthCard edge="gradient" style={styles.levelDetail}>
            <View style={styles.levelTitleRow}>
              <Text style={styles.levelDetailTitle}>{shownDef.emoji} {shownDef.n}. {shownDef.name}</Text>
              {myLevel === shownDef.n
                ? <RankRibbon tint="purple" size="sm">YOU ARE HERE</RankRibbon>
                : myLevel != null && shownDef.n === Math.min(myLevel + 1, 6) && myLevel < 6
                  ? <RankRibbon tint="purple" size="sm">NEXT UP</RankRibbon>
                  : null}
            </View>
            {/* The level you're actually chasing gets the LIVE scoreboard —
                each requirement with your own number against the target and a
                tick when it lands (the sentence version is folded away inside
                it). Every other level keeps the one-line rule: there are no
                numbers to show against a rung two above you. */}
            {nextUp && shownDef.n === nextUp.level ? (
              <NextUpChecklist nextUp={nextUp} fullRule={shownDef.takes} style={styles.levelChecklist} />
            ) : (
              /* The lead-in carries the brand colour; the requirement itself is
                 body copy. Purple + bold across all three lines read as a link
                 block. String unchanged (the nested Text renders identically). */
              <Text style={styles.levelTakes}>
                <Text style={styles.levelTakesLead}>What it takes: </Text>{shownDef.takes}
              </Text>
            )}
            <Text style={styles.levelDesc}>{content?.level_arc?.[String(shownDef.n)] || shownDef.fallback}</Text>
            <Text style={styles.levelWeeks}>Most people get here between weeks {shownDef.weeks} — plenty get there faster. It's not a race, and it's not a limit.</Text>
            <Text style={styles.tapHint}>Tap any level on the map to see what it takes.</Text>
          </DepthCard>
        )}

        <SectionHead size={26} style={styles.sectionHead}>How it's measured</SectionHead>
        <ScrollReveal scrollY={scrollY}>
        <DepthCard style={styles.card}>
          {MEASURED.map((m, i) => (
            <View key={i} style={[styles.measureRow, i < MEASURED.length - 1 && styles.rowDivider]}>
              <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.measureWell}>
                <View style={styles.measureWellInner}>
                  <Ionicons name={m.icon} size={15} color={colors.primary} />
                </View>
              </LinearGradient>
              <Text style={styles.measureText}>{m.text}</Text>
            </View>
          ))}
        </DepthCard>
        </ScrollReveal>

        <GlowButton
          style={styles.ctaBtn}
          onPress={() => router.push('/(tabs)/progress' as never)}
          testID="sales-path-intro-cta"
        >
          <Ionicons name="trending-up" size={17} color="#fff" />
          <Text style={styles.ctaText}>See where I am on the path</Text>
        </GlowButton>

        <DepthCard variant="ink" style={styles.footerCard}>
          <Ionicons name="time" size={18} color={colors.inkMuted} />
          <Text style={styles.footerText}>
            {content?.long_game_body ||
              "Nobody is good at this in week one — that's why you get a 30-day ramp-up. Stay consistent and you'll be earning steady money. Keep training after that and it goes a lot higher. One bad day or week means nothing. Keep going."}
          </Text>
        </DepthCard>
      </ScrollView>
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  // EditorialHero owns the bleed/radii; we only pin the top padding (the
  // masthead already covers the safe area) and keep a little air on top.
  hero: { paddingTop: 26 },
  // Unbounded-SemiBold: never add fontWeight (faux-bold on web).
  kicker: { fontFamily: fonts.displayWide, fontSize: 11, letterSpacing: 1.6, color: 'rgba(255,255,255,0.85)', marginBottom: 10 },
  // Lede keeps to the left ~78% so the cube owns the right column beside it (no glyph/edge collisions).
  lede: { fontFamily: fonts.body, fontSize: 16, lineHeight: 23, color: 'rgba(255,255,255,0.92)', marginTop: 10, maxWidth: '78%' },
  principleCard: { borderRadius: 20, paddingVertical: 20, paddingHorizontal: 18, marginBottom: 4, alignItems: 'center' },
  principleRule: { width: 36, height: 3, borderRadius: 1.5, overflow: 'hidden', marginBottom: 12 },
  // Unbounded-Black: never add fontWeight.
  principleText: { fontFamily: fonts.displayBlack, fontSize: 20, lineHeight: 28, letterSpacing: -0.4, textAlign: 'center' },
  sectionHead: { marginTop: 26, marginBottom: 8 },
  sectionSub: { fontFamily: fonts.body, fontSize: 13.5, lineHeight: 20, color: colors.textSecondary, marginBottom: 12 },
  card: { borderRadius: 20, paddingHorizontal: 14 },
  // Ghosts fan 16px below the deck — leave them room.
  rampStack: { marginBottom: 20 },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.border },

  // position:relative so each row owns its rail slice (RN default, pinned here
  // deliberately — the rail is positioned against THIS row, nothing else).
  rampRow: { position: 'relative', flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingTop: RAMP_ROW_PAD },
  rampCoinCol: { width: RAMP_COIN, alignItems: 'center', marginTop: 1 },
  rampBody: { flex: 1, paddingBottom: RAMP_ROW_PAD },
  // Straight down the middle of this row's coin column, edge to edge of the row.
  rampRail: {
    position: 'absolute', width: 3, overflow: 'hidden',
    left: RAMP_COIN / 2 - 1.5, top: 0, bottom: 0,
  },
  // The trophy row's half-rail: row top → the coin's centre, then nothing.
  rampRailStub: {
    position: 'absolute', width: 3, overflow: 'hidden',
    left: RAMP_COIN / 2 - 1.5, top: 0, height: RAMP_COIN_CENTER,
    borderBottomLeftRadius: 1.5, borderBottomRightRadius: 1.5,
  },
  rampName: { fontFamily: fonts.display, fontSize: 15, color: colors.text },
  rampDesc: { fontFamily: fonts.body, fontSize: 12.5, lineHeight: 18.5, color: colors.textSecondary, marginTop: 2 },

  levelDetail: { borderRadius: 20, padding: 16, marginTop: 8 },
  levelTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  levelDetailTitle: { fontFamily: fonts.display, fontSize: 17, color: colors.text },
  tapHint: { fontFamily: fonts.body, fontSize: 10.5, color: colors.textMuted, marginTop: 10, textAlign: 'center' },
  levelWeeks: { fontFamily: fonts.body, fontSize: 11.5, color: colors.textMuted, fontStyle: 'italic', marginTop: 3 },
  levelTakes: { fontFamily: fonts.body, fontSize: 12.5, color: colors.text, marginTop: 6, lineHeight: 18 },
  levelChecklist: { marginTop: 10, marginBottom: 2 },
  // `primary` (never primaryDark — 2.74:1 on the dark card face).
  levelTakesLead: { fontFamily: fonts.bodyBold, color: colors.primary },
  floorNote: { fontFamily: fonts.body, fontSize: 12, color: colors.textSecondary, lineHeight: 18, marginTop: 10, fontStyle: 'italic' },
  tlsCard: { borderRadius: 20, paddingVertical: 14, paddingLeft: 24, paddingRight: 14, marginBottom: 12 },
  tlsWash: { borderRadius: 20 },
  tlsRail: {
    position: 'absolute', left: 10, top: 14, bottom: 14, width: 4,
    borderRadius: 2, overflow: 'hidden',
  },
  tlsHead: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 },
  // Band label = the uppercase LABEL role, so Unbounded-SemiBold (displayWide,
  // sanctioned ≥11px uppercase) — displayBlack is reserved for ≥20px display
  // roles (§2.4/§7). Never add fontWeight to either.
  tlsName: { fontFamily: fonts.displayWide, fontSize: 16, letterSpacing: 0.4 },
  tlsBandChip: {
    marginLeft: 'auto', borderWidth: 1, borderRadius: 999,
    paddingHorizontal: 10, paddingVertical: 3,
  },
  tlsBand: { fontFamily: fonts.bodyBold, fontSize: 12 },
  // One rhythm for all four tier cards: the bullet sits in its own fixed
  // column so a wrapped line hangs under the text, never under the glyph.
  tlsBullet: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 5 },
  tlsDot: { width: 14, fontFamily: fonts.body, fontSize: 12.5, lineHeight: 19, color: colors.text },
  tlsLine: { flex: 1, fontFamily: fonts.body, fontSize: 12.5, lineHeight: 19, color: colors.text },
  levelDesc: { fontFamily: fonts.body, fontSize: 13, lineHeight: 19, color: colors.textSecondary, marginTop: 4 },

  measureRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 12 },
  // Gradient-rimmed icon well: a 1.5px brand rim around an inset face.
  measureWell: { width: 32, height: 32, borderRadius: 11, padding: 1.5, marginTop: 1 },
  measureWellInner: {
    flex: 1, borderRadius: 9.5, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  measureText: { flex: 1, fontFamily: fonts.body, fontSize: 13, lineHeight: 19.5, color: colors.text },

  ctaBtn: { borderRadius: 16, marginTop: 20 },
  ctaText: { fontFamily: fonts.bodyBold, fontSize: 15, color: '#fff' },
  footerCard: { flexDirection: 'row', gap: 12, alignItems: 'flex-start', borderRadius: 20, padding: 16, marginTop: 16 },
  footerText: { flex: 1, fontFamily: fonts.body, fontSize: 13, lineHeight: 19.5, color: colors.inkText },
});
