import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { fonts } from '../../theme/ThemeContext';
import { ScheduleBlock } from '../../utils/scheduleNotifications';
import {
  DAY_SHORT, dayNum, dowOf, hhmmToMin, hourLabel, nowMinutes, timeRange,
} from '../../utils/calendarDates';
import {
  Lane, Placed, isDone, isPersonal, lanesForDay, occursOn, placeInLanes, placeOverlapping, textOn,
  blockGroups,
} from './calendarModel';

// Google Calendar-style time grid for the schedule (day or week).
//
// 'office' mode lays the Owner's timetable out in its lanes (Stage 4+ /
// Leaders / Stage 1/2, Wednesday splits Stage 2 and Stage 1), the way the
// office sheet reads, with the viewer's own items in a "You" lane on the
// right. 'mine' mode shows only what the viewer is in, Google-style, with
// overlapping items side by side.
//
// The canvas is forest green in both themes (the office sheet's dark look,
// on brand). Tapping an empty slot creates an item there.

export const CAL = {
  canvas: '#0d2720',
  panel: '#102d25',
  line: 'rgba(240,244,233,0.07)',
  lineStrong: 'rgba(240,244,233,0.13)',
  text: '#f0f4e9',
  muted: '#9fb8a8',
  faint: 'rgba(159,184,168,0.55)',
  lime: '#b7df58',
  onLime: '#102d25',
  todayCol: 'rgba(183,223,88,0.05)',
};

const GUTTER = 50;
const SNAP = 15;

type Props = {
  days: string[];
  blocks: ScheduleBlock[];
  mode: 'office' | 'mine';
  myGroup: string;
  isAdmin: boolean;
  hourHeight: number;
  dayLabels: Record<string, string>;
  today: string;
  absentDates: string[];
  /** Admin's full office view keeps absent days filled (it's the editor). */
  blankAbsent: boolean;
  compact: boolean;
  onPressBlock: (b: ScheduleBlock, iso: string) => void;
  onCreate: (iso: string, startMin: number) => void;
  onToggleDone: (b: ScheduleBlock, iso: string) => void;
  onPressDay?: (iso: string) => void;
};

export default function CalendarGrid(p: Props) {
  const scrollRef = useRef<ScrollView>(null);
  const [now, setNow] = useState(() => nowMinutes());
  const [gridW, setGridW] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNow(nowMinutes()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Hours shown: 8am–9pm, stretched to fit anything earlier or later.
  const { startHour, endHour } = useMemo(() => {
    let lo = 8 * 60, hi = 21 * 60;
    for (const b of p.blocks) {
      if (!p.days.some((d) => occursOn(b, d))) continue;
      const s = hhmmToMin(b.start_time), e = hhmmToMin(b.end_time);
      if (s !== null) lo = Math.min(lo, s);
      if (e !== null) hi = Math.max(hi, e);
    }
    return { startHour: Math.floor(lo / 60), endHour: Math.min(24, Math.ceil(hi / 60)) };
  }, [p.blocks, p.days]);
  const startMin = startHour * 60;
  const totalH = (endHour - startHour) * p.hourHeight;
  const yOf = (min: number) => ((min - startMin) / 60) * p.hourHeight;

  // Per-day layout.
  const columns = useMemo(() => p.days.map((iso) => {
    const absent = p.blankAbsent && p.absentDates.includes(iso);
    const todays = absent ? [] : p.blocks.filter((b) => occursOn(b, iso));
    const office = todays.filter((b) => !isPersonal(b));
    const mine = todays.filter(isPersonal);
    let lanes: Lane[] = [];
    let placed: Placed[];
    if (p.mode === 'office') {
      lanes = lanesForDay(office);
      const youShare = mine.length ? 1 / (lanes.length + 1) : 0;
      placed = [
        ...placeInLanes(office, lanes, 0, 1 - youShare),
        ...(mine.length ? placeOverlapping(mine, 1 - youShare, youShare) : []),
      ];
    } else {
      const inMyLane = office.filter((b) => blockGroups(b).includes(p.myGroup));
      placed = placeOverlapping([...inMyLane, ...mine]);
    }
    return { iso, absent, lanes, placed, hasMine: mine.length > 0 };
  }), [p.days, p.blocks, p.mode, p.myGroup, p.absentDates, p.blankAbsent]);

  // Open near "now" on today's view, otherwise at the top of the day.
  const showsToday = p.days.includes(p.today);
  useEffect(() => {
    const y = showsToday ? Math.max(0, yOf(now) - p.hourHeight * 1.5) : 0;
    const t = setTimeout(() => scrollRef.current?.scrollTo({ y, animated: false }), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.days.join(','), showsToday]);

  const colW = gridW ? gridW / p.days.length : 0;
  const showLaneHeads = p.mode === 'office' && colW > 0;
  const tinyLanes = colW > 0 && colW < 260;

  return (
    <View style={s.canvas}>
      {/* Day headers (fixed) */}
      <View style={s.headRow}>
        <View style={{ width: GUTTER }} />
        {columns.map(({ iso, lanes, hasMine }) => {
          const isToday = iso === p.today;
          const label = p.dayLabels[String(dowOf(iso))];
          return (
            <View key={iso} style={[s.headCell, p.days.length > 1 && s.headCellSep]}>
              <Pressable
                onPress={() => p.onPressDay?.(iso)}
                disabled={!p.onPressDay}
                style={s.headTap}
                accessibilityRole="button"
                accessibilityLabel={`${DAY_SHORT[dowOf(iso)]} ${dayNum(iso)}`}
              >
                <Text style={[s.headDow, isToday && { color: CAL.lime }]}>{DAY_SHORT[dowOf(iso)].toUpperCase()}</Text>
                <View style={[s.headNum, isToday && s.headNumToday]}>
                  <Text style={[s.headNumText, isToday && { color: CAL.onLime }]}>{dayNum(iso)}</Text>
                </View>
              </Pressable>
              {label ? <Text style={s.headLabel} numberOfLines={1}>{label}</Text> : <View style={{ height: 14 }} />}
              {showLaneHeads && (
                <View style={s.laneHeadRow}>
                  {[...lanes, ...(hasMine ? [{ key: 'you', label: 'You', groups: [] } as Lane] : [])].map((l) => {
                    const mineLane = l.key === 'you' || l.groups.includes(p.myGroup);
                    return (
                      <View key={l.key} style={[s.laneHead, mineLane && !p.isAdmin && s.laneHeadMine]}>
                        <Text style={[s.laneHeadText, mineLane && !p.isAdmin && { color: CAL.lime }]} numberOfLines={1}>
                          {tinyLanes ? shortLane(l) : l.label}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              )}
            </View>
          );
        })}
      </View>

      <ScrollView ref={scrollRef} style={{ flex: 1 }} showsVerticalScrollIndicator={Platform.OS === 'web'}>
        <View style={{ flexDirection: 'row', height: totalH + 12 }}>
          {/* Hour gutter */}
          <View style={{ width: GUTTER }}>
            {Array.from({ length: endHour - startHour }, (_, i) => (
              <Text key={i} style={[s.hour, { top: i * p.hourHeight - 6 }]}>{i === 0 ? '' : hourLabel(startHour + i)}</Text>
            ))}
          </View>

          <View style={{ flex: 1, flexDirection: 'row' }} onLayout={(e) => setGridW(e.nativeEvent.layout.width)}>
            {columns.map(({ iso, absent, placed }) => {
              const isToday = iso === p.today;
              return (
                <View key={iso} style={[s.col, p.days.length > 1 && s.colSep, isToday && { backgroundColor: CAL.todayCol }]}>
                  {/* Hour + half-hour lines */}
                  {Array.from({ length: endHour - startHour }, (_, i) => (
                    <React.Fragment key={i}>
                      <View pointerEvents="none" style={[s.hLine, { top: i * p.hourHeight }]} />
                      {p.hourHeight >= 48 && <View pointerEvents="none" style={[s.hHalf, { top: i * p.hourHeight + p.hourHeight / 2 }]} />}
                    </React.Fragment>
                  ))}

                  {/* Tap an empty slot to add something there */}
                  <Pressable
                    style={StyleSheet.absoluteFill}
                    onPress={(e) => {
                      const y = (e.nativeEvent as any).locationY ?? 0;
                      const min = startMin + Math.floor(((y / p.hourHeight) * 60) / SNAP) * SNAP;
                      p.onCreate(iso, Math.min(min, 23 * 60));
                    }}
                    accessibilityLabel={`Add to ${iso}`}
                  />

                  {absent && (
                    <View pointerEvents="none" style={s.absent}>
                      <Ionicons name="moon-outline" size={16} color={CAL.muted} />
                      <Text style={s.absentText}>Marked absent</Text>
                    </View>
                  )}

                  {placed.map((it) => (
                    <EventChip
                      key={`${it.block.id}-${iso}`}
                      it={it}
                      iso={iso}
                      top={yOf(it.start)}
                      height={Math.max(14, yOf(it.end) - yOf(it.start))}
                      dim={p.mode === 'office' && !p.isAdmin && !isPersonal(it.block) && !blockGroups(it.block).includes(p.myGroup)}
                      onPress={() => p.onPressBlock(it.block, iso)}
                      onToggleDone={() => p.onToggleDone(it.block, iso)}
                    />
                  ))}

                  {isToday && now >= startMin && now <= endHour * 60 && (
                    <View pointerEvents="none" style={[s.nowLine, { top: yOf(now) }]}>
                      <View style={s.nowDot} />
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

function shortLane(l: Lane): string {
  if (l.key === 's4') return '4+';
  if (l.key === 'ld') return 'Ldr';
  if (l.key === 's12') return '1/2';
  if (l.key === 's2') return 'S2';
  if (l.key === 's1') return 'S1';
  return 'You';
}

function EventChip({ it, iso, top, height, dim, onPress, onToggleDone }: {
  it: Placed; iso: string; top: number; height: number; dim: boolean;
  onPress: () => void; onToggleDone: () => void;
}) {
  const b = it.block;
  const personal = isPersonal(b);
  const task = b.kind === 'task';
  const done = isDone(b, iso);
  const fill = b.color || '#2c5a26';
  const fg = personal ? CAL.text : textOn(fill);
  const short = height < 22;
  const lines = Math.max(1, Math.floor((height - 6) / 13));
  return (
    <Pressable
      onPress={onPress}
      style={(state: any) => [
        s.chip,
        {
          top: top + 1, height: height - 2,
          left: `${it.left * 100}%` as any, width: `${it.width * 100}%` as any,
          backgroundColor: personal ? 'rgba(16,45,37,0.92)' : fill,
          borderColor: personal ? fill : 'rgba(255,255,255,0.10)',
          borderLeftColor: personal ? fill : 'rgba(255,255,255,0.35)',
        },
        personal && s.chipPersonal,
        dim && { opacity: 0.38 },
        done && { opacity: 0.55 },
        state.hovered && s.chipHover,
      ]}
      accessibilityRole="button"
      accessibilityLabel={`${b.title}, ${timeRange(b.start_time, b.end_time)}`}
    >
      <View style={{ flexDirection: 'row', alignItems: short ? 'center' : 'flex-start', gap: 4, flex: 1, minWidth: 0 }}>
        {task && (
          <Pressable onPress={onToggleDone} hitSlop={8} accessibilityRole="checkbox" accessibilityState={{ checked: done }}>
            <Ionicons name={done ? 'checkmark-circle' : 'ellipse-outline'} size={short ? 12 : 14} color={personal ? fill : fg} />
          </Pressable>
        )}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            style={[s.chipTitle, { color: fg }, (short || height < 44) && s.chipTitleSmall, done && s.strike]}
            numberOfLines={short ? 1 : height >= 44 ? Math.max(1, lines - 1) : lines}
          >
            {b.title}
          </Text>
          {height >= 44 && (
            <Text style={[s.chipTime, { color: fg }]} numberOfLines={1}>{timeRange(b.start_time, b.end_time)}</Text>
          )}
        </View>
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  canvas: { flex: 1, backgroundColor: CAL.canvas, borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(183,223,88,0.10)' },
  headRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: CAL.lineStrong, backgroundColor: CAL.panel },
  headCell: { flex: 1, alignItems: 'center', paddingTop: 6, minWidth: 0 },
  headCellSep: { borderLeftWidth: 1, borderLeftColor: CAL.line },
  headTap: { alignItems: 'center', paddingHorizontal: 8, borderRadius: 10 },
  headDow: { fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1.2, color: CAL.muted },
  headNum: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  headNumToday: { backgroundColor: CAL.lime, boxShadow: '0 0 14px rgba(183,223,88,0.45)' } as any,
  headNumText: { fontFamily: fonts.bodyBold, fontSize: 16, color: CAL.text, fontVariant: ['tabular-nums'] as any },
  headLabel: { fontFamily: fonts.bodySemibold, fontSize: 10, color: CAL.lime, marginTop: 1, height: 14, paddingHorizontal: 4 },
  laneHeadRow: { flexDirection: 'row', alignSelf: 'stretch', marginTop: 4, borderTopWidth: 1, borderTopColor: CAL.line },
  laneHead: { flex: 1, alignItems: 'center', paddingVertical: 4, minWidth: 0 },
  laneHeadMine: { backgroundColor: 'rgba(183,223,88,0.10)', borderBottomWidth: 2, borderBottomColor: CAL.lime },
  laneHeadText: { fontFamily: fonts.mono, fontSize: 9.5, letterSpacing: 0.4, color: CAL.muted },

  hour: { position: 'absolute', right: 8, fontFamily: fonts.mono, fontSize: 10, color: CAL.faint },
  col: { flex: 1, position: 'relative', minWidth: 0 },
  colSep: { borderLeftWidth: 1, borderLeftColor: CAL.line },
  hLine: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: CAL.line },
  hHalf: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: 'rgba(240,244,233,0.03)' },

  chip: {
    position: 'absolute', borderRadius: 6, paddingHorizontal: 4, paddingVertical: 2,
    borderWidth: 1, borderLeftWidth: 3, overflow: 'hidden', marginHorizontal: 1,
    boxShadow: '0 2px 6px rgba(0,0,0,0.25)',
  } as any,
  chipPersonal: { borderStyle: 'dashed', borderLeftWidth: 3 },
  chipHover: { boxShadow: '0 0 0 1px rgba(183,223,88,0.6), 0 6px 16px rgba(0,0,0,0.35)', zIndex: 5 } as any,
  chipTitle: { fontFamily: fonts.bodyBold, fontSize: 11.5, lineHeight: 14 },
  chipTitleSmall: { fontSize: 10.5, lineHeight: 12.5 },
  chipTime: { fontFamily: fonts.mono, fontSize: 9.5, opacity: 0.85, marginTop: 1 },
  strike: { textDecorationLine: 'line-through' },

  absent: { position: 'absolute', top: 12, left: 0, right: 0, alignItems: 'center', gap: 4 },
  absentText: { fontFamily: fonts.bodySemibold, fontSize: 11, color: CAL.muted },

  nowLine: { position: 'absolute', left: 0, right: 0, height: 2, backgroundColor: CAL.lime, zIndex: 10, boxShadow: '0 0 8px rgba(183,223,88,0.7)' } as any,
  nowDot: { position: 'absolute', left: -5, top: -4, width: 10, height: 10, borderRadius: 5, backgroundColor: CAL.lime },
});
