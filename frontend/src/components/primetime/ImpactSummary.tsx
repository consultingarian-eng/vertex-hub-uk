/**
 * ImpactSummary — the grouped read view of a day's Primetime, shared by the
 * Home tile and the Weekly Planner's day page so both read identically.
 *
 * One block per impact rather than one row per person: a per-person list
 * printed both sides of the same arrangement as separate lines, which looked
 * like duplicates and hid the useful shape — who is running what, and who is
 * in it. Admins see the whole office, where that clutter is worst.
 *
 * Nothing is truncated. Every attendee is named.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors, fonts } from '../../theme/ThemeContext';

export type ImpactSession = {
  session_id: string;
  topic: string;
  host_user_id: string;
  host_name: string;
  attendees: { user_id: string; name: string; mode: string }[];
};

export type ImpactSolo = {
  user_id: string;
  name: string;
  mode: string;
  topic: string;
  with_label?: string;
};

export const MODE_ICON: Record<string, any> = {
  teaching: 'megaphone',
  learning: 'school',
  watching: 'eye',
};

// A stable colour per PERSON RUNNING the session, not per topic. Two people
// can run the same topic at the same time and those are genuinely separate
// sessions — keying on the topic made them look like one thing.
const HUES = ['#2f6a4b', '#ec4899', '#0ea5e9', '#16a34a', '#f59e0b', '#6366f1', '#ef4444'];

export function hueFor(key: string): string {
  const k = (key || 'x').trim().toLowerCase();
  let h = 0;
  for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length];
}

export function initials(name: string): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/** Overlapping initial badges — the "how many people" signal you read first. */
function Faces({ names, color, styles }: { names: string[]; color: string; styles: any }) {
  const shown = names.slice(0, 4);
  const extra = names.length - shown.length;
  return (
    <View style={styles.faces}>
      {shown.map((n, i) => (
        <View
          key={`${n}-${i}`}
          style={[styles.face, { backgroundColor: color, marginLeft: i === 0 ? 0 : -7, zIndex: 10 - i }]}
        >
          <Text style={styles.faceTxt}>{initials(n)}</Text>
        </View>
      ))}
      {extra > 0 && (
        <View style={[styles.face, styles.faceMore, { marginLeft: -7 }]}>
          <Text style={[styles.faceTxt, { color }]}>+{extra}</Text>
        </View>
      )}
    </View>
  );
}

export default function ImpactSummary({
  sessions, solo, renderSessionAction, compact,
}: {
  sessions: ImpactSession[];
  solo: ImpactSolo[];
  /** Optional per-session control, e.g. "Add my person" in the planner. */
  renderSessionAction?: (s: ImpactSession) => React.ReactNode;
  /** Slightly tighter spacing when nested inside a planner card. */
  compact?: boolean;
}) {
  const colors = useColors();
  const styles = React.useMemo(() => createStyles(colors, !!compact), [colors, compact]);

  // Biggest impacts first — that's the one a spare trainee should join.
  const ordered = React.useMemo(
    () => [...sessions].sort((a, b) => b.attendees.length - a.attendees.length),
    [sessions],
  );

  return (
    <>
      {ordered.map((s) => {
        const hue = hueFor(s.host_user_id || s.session_id);
        const names = s.attendees.map((a) => a.name);
        return (
          <View key={s.session_id} style={styles.session}>
            <View style={[styles.accent, { backgroundColor: hue }]} />
            <View style={styles.sessionBody}>
              {/* Who is running it leads the block — the session is theirs. */}
              <View style={styles.hostRow}>
                <View style={[styles.hostFace, { backgroundColor: hue }]}>
                  <Text style={styles.hostFaceTxt}>{initials(s.host_name)}</Text>
                </View>
                <Text style={styles.hostName} numberOfLines={1}>{s.host_name}</Text>
                <View style={[styles.headcount, { backgroundColor: `${hue}1A` }]}>
                  <Ionicons name="people" size={10} color={hue} />
                  <Text style={[styles.headcountTxt, { color: hue }]}>{s.attendees.length + 1}</Text>
                </View>
              </View>

              <Text style={[styles.topic, { color: hue }]}>{s.topic || 'Untitled topic'}</Text>

              {names.length > 0 ? (
                <View style={styles.attRow}>
                  <Faces names={names} color={hue} styles={styles} />
                  {/* Every attendee named in full — nothing behind a "+N more". */}
                  <Text style={styles.attTxt}>{names.join(', ')}</Text>
                </View>
              ) : (
                <Text style={styles.nobody}>Nobody has joined yet</Text>
              )}

              {renderSessionAction?.(s)}
            </View>
          </View>
        );
      })}

      {solo.length > 0 && (
        <View style={styles.soloWrap}>
          <Text style={styles.soloLbl}>On their own</Text>
          {solo.map((p, i) => (
            // user_id alone collided when a data bug sent the same person
            // twice; the index suffix keeps React quiet no matter what.
            <View key={`${p.user_id}-${i}`} style={styles.soloRow}>
              <Ionicons name={MODE_ICON[p.mode]} size={12} color={colors.textMuted} />
              <Text style={styles.soloName} numberOfLines={1}>{p.name}</Text>
              <Text style={styles.soloTopic} numberOfLines={1}>
                {p.topic || p.mode}
                {p.with_label ? ` · ${p.with_label}` : ''}
              </Text>
            </View>
          ))}
        </View>
      )}
    </>
  );
}

const createStyles = (c: any, compact: boolean) => StyleSheet.create({
  session: {
    flexDirection: 'row', backgroundColor: compact ? c.surfaceAlt : c.background,
    borderRadius: 12, marginBottom: compact ? 6 : 8, overflow: 'hidden',
  },
  accent: { width: 3.5 },
  sessionBody: { flex: 1, paddingVertical: compact ? 9 : 10, paddingHorizontal: 11, gap: 5 },

  hostRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  hostFace: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  hostFaceTxt: { fontFamily: fonts.bodyBold, fontSize: 9.5, color: '#fff' },
  hostName: { fontFamily: fonts.display, fontSize: 13.5, color: c.text, flex: 1 },
  headcount: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999 },
  headcountTxt: { fontFamily: fonts.bodyBold, fontSize: 10.5 },

  topic: { fontFamily: fonts.bodyBold, fontSize: 12.5, marginLeft: 31 },

  attRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, marginLeft: 31 },
  faces: { flexDirection: 'row', alignItems: 'center' },
  face: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: c.background },
  faceMore: { backgroundColor: c.surfaceAlt },
  faceTxt: { fontFamily: fonts.bodyBold, fontSize: 8.5, color: '#fff' },
  attTxt: { fontFamily: fonts.body, fontSize: 11, color: c.textMuted, flex: 1, lineHeight: 16 },
  nobody: { fontFamily: fonts.body, fontSize: 11, color: c.textMuted, fontStyle: 'italic', marginLeft: 31 },

  soloWrap: { marginTop: 2, gap: 5 },
  soloLbl: { fontFamily: fonts.bodySemibold, fontSize: 9.5, color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 4 },
  soloRow: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 3 },
  soloName: { fontFamily: fonts.bodySemibold, fontSize: 12, color: c.text, maxWidth: 130 },
  soloTopic: { fontFamily: fonts.body, fontSize: 11, color: c.textMuted, flex: 1 },
});
