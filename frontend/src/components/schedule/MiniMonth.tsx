import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { fonts } from '../../theme/ThemeContext';
import { monthGrid, monthOf, monthTitle, startOfWeek } from '../../utils/calendarDates';
import { CAL } from './CalendarGrid';

// Google-style mini month: pick any date, the selected week is shaded and
// today is the lime dot. `marked` dates (your own one-off items) get a tick.
export default function MiniMonth({ selected, today, weekMode, marked, onPick }: {
  selected: string; today: string; weekMode: boolean; marked?: Set<string>;
  onPick: (iso: string) => void;
}) {
  const [{ year, month0 }, setMonth] = useState(() => monthOf(selected));
  useEffect(() => { setMonth(monthOf(selected)); }, [selected]);
  const grid = monthGrid(year, month0);
  const selWeek = startOfWeek(selected);
  const shift = (n: number) => setMonth(({ year: y, month0: m }) => {
    const t = m + n;
    return { year: y + Math.floor(t / 12), month0: ((t % 12) + 12) % 12 };
  });

  return (
    <View>
      <View style={s.head}>
        <Text style={s.title}>{monthTitle(year, month0)}</Text>
        <Pressable onPress={() => shift(-1)} style={s.arrow} accessibilityLabel="Previous month" hitSlop={6}>
          <Ionicons name="chevron-back" size={15} color={CAL.muted} />
        </Pressable>
        <Pressable onPress={() => shift(1)} style={s.arrow} accessibilityLabel="Next month" hitSlop={6}>
          <Ionicons name="chevron-forward" size={15} color={CAL.muted} />
        </Pressable>
      </View>
      <View style={s.row}>
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <Text key={i} style={s.dow}>{d}</Text>)}
      </View>
      {Array.from({ length: 6 }, (_, w) => {
        const week = grid.slice(w * 7, w * 7 + 7);
        const inSel = weekMode && week[0] === selWeek;
        return (
          <View key={w} style={[s.row, inSel && s.selWeek]}>
            {week.map((iso) => {
              const out = monthOf(iso).month0 !== month0;
              const isToday = iso === today;
              const isSel = !weekMode && iso === selected;
              return (
                <Pressable
                  key={iso}
                  onPress={() => onPick(iso)}
                  style={(st: any) => [s.cell, st.hovered && s.cellHover]}
                  accessibilityLabel={iso}
                >
                  <View style={[s.num, isSel && s.numSel, isToday && s.numToday]}>
                    <Text style={[s.numText, out && { color: CAL.faint }, isToday && { color: CAL.onLime, fontFamily: fonts.bodyBold }]}>
                      {parseInt(iso.slice(8), 10)}
                    </Text>
                  </View>
                  {marked?.has(iso) && !isToday && <View style={s.mark} />}
                </Pressable>
              );
            })}
          </View>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', marginBottom: 6, paddingLeft: 4 },
  title: { flex: 1, fontFamily: fonts.bodyBold, fontSize: 13, color: CAL.text },
  arrow: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', borderRadius: 14 },
  selWeek: { backgroundColor: 'rgba(183,223,88,0.12)' },
  dow: { flex: 1, textAlign: 'center', fontFamily: fonts.mono, fontSize: 9.5, color: CAL.faint, paddingVertical: 3 },
  cell: { flex: 1, alignItems: 'center', paddingVertical: 1, borderRadius: 14 },
  cellHover: { backgroundColor: 'rgba(240,244,233,0.06)' },
  num: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  numSel: { borderWidth: 1, borderColor: CAL.lime },
  numToday: { backgroundColor: CAL.lime },
  numText: { fontFamily: fonts.body, fontSize: 11.5, color: CAL.text, fontVariant: ['tabular-nums'] as any },
  mark: { position: 'absolute', bottom: 1, width: 4, height: 4, borderRadius: 2, backgroundColor: '#4fd1c5' },
});
