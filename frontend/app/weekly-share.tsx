/**
 * Countrywide bulletins hub — admins and leaders.
 * Two cards: Sign-ups (the weekly bulletin), Team.
 * Week picker at the top controls which week the bulletins open to.
 *
 * Admins and leaders can open and share the ready-to-go weekly exports.
 * Bulletin data itself is derived through read-only endpoints.
 * Also wired to the Monday 09:00 admin push notification.
 */
import React, { useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Platform,
} from 'react-native';
import { router, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useColors } from '../src/theme/ThemeContext';
import { useTabBarClearance } from '../src/customization/CustomTabBar';
import { isoAddDays, lastWeekEndingISO as lastSundayISO, prettyWeekRange, POSTER } from '../src/utils/bulletinWeek';

export default function BulletinsHubScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [weekEnding, setWeekEnding] = useState<string>(lastSundayISO());

  const goSales = () => {
    router.push({ pathname: '/bulletin', params: { week_ending: weekEnding } });
  };
  const goTeam = () => {
    router.push({ pathname: '/team-bulletin', params: { week_ending: weekEnding } });
  };
  const goShareSales = () => {
    router.push({ pathname: '/bulletin', params: { autoshare: '1', week_ending: weekEnding } });
  };
  const goShareTeam = () => {
    router.push({ pathname: '/team-bulletin', params: { autoshare: '1', week_ending: weekEnding } });
  };

  const prevWeek = () => setWeekEnding(isoAddDays(weekEnding, -7));
  const nextWeek = () => {
    const candidate = isoAddDays(weekEnding, 7);
    if (candidate <= lastSundayISO()) setWeekEnding(candidate);
  };
  const isLatest = weekEnding >= lastSundayISO();

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Countrywide Bulletins</Text>
        <View style={{ width: 28 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 + tabBarClearance }}>

        {/* Week picker */}
        <View style={styles.weekRow}>
          <TouchableOpacity onPress={prevWeek} style={styles.weekArrow} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="chevron-back" size={18} color={colors.primary} />
          </TouchableOpacity>
          <View style={styles.weekLabelWrap}>
            <Ionicons name="calendar-outline" size={13} color={colors.primary} />
            <Text style={styles.weekLabel}>{prettyWeekRange(weekEnding)}</Text>
          </View>
          <TouchableOpacity
            onPress={nextWeek}
            style={[styles.weekArrow, isLatest && styles.weekArrowDisabled]}
            disabled={isLatest}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name="chevron-forward" size={18} color={isLatest ? colors.textMuted : colors.primary} />
          </TouchableOpacity>
        </View>

        {/* Sign-ups Bulletin */}
        <BulletinCard
          icon="trophy"
          iconBg={POSTER.forest}
          iconColor={POSTER.paper}
          title="Sign-ups Bulletin"
          meta="Top 5 sign-ups · £15+ %"
          onOpen={goSales}
          onShare={goShareSales}
          styles={styles}
          colors={colors}
        />

        {/* Team Bulletin */}
        <BulletinCard
          icon="people"
          iconBg={POSTER.lime}
          iconColor={POSTER.forest}
          title="Team Bulletin"
          meta="Top 5 eligible teams by total sign-ups · all offices"
          onOpen={goTeam}
          onShare={goShareTeam}
          styles={styles}
          colors={colors}
        />

      </ScrollView>
    </View>
  );
}

function BulletinCard({
  icon, iconBg, iconColor, title, meta, onOpen, onShare, styles, colors, noWeek = false,
}: {
  icon: any; iconBg: string; iconColor: string; title: string; meta: string;
  onOpen: () => void; onShare: () => void;
  styles: any; colors: any; noWeek?: boolean;
}) {
  return (
    <TouchableOpacity activeOpacity={0.85} style={styles.card} onPress={onOpen}>
      <View style={[styles.cardIcon, { backgroundColor: iconBg }]}>
        <Ionicons name={icon} size={26} color={iconColor} />
      </View>
      <View style={styles.cardBody}>
        <Text style={styles.cardTitle}>{title}</Text>
        <Text style={styles.cardMeta}>{meta}{noWeek ? '' : ''}</Text>
      </View>
      <View style={styles.cardActions}>
        <TouchableOpacity
          onPress={onShare}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          style={styles.shareBtn}
        >
          <Ionicons name="share-outline" size={18} color={colors.primary} />
          <Text style={styles.shareBtnText}>Share</Text>
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  backBtn: { padding: 4 },
  headerTitle: { fontSize: 17, fontWeight: '800', color: colors.text },
  weekRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border,
    paddingVertical: 10, paddingHorizontal: 14, marginBottom: 20,
  },
  weekArrow: { padding: 2 },
  weekArrowDisabled: { opacity: 0.35 },
  weekLabelWrap: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, justifyContent: 'center' },
  weekLabel: { fontSize: 14, fontWeight: '800', color: colors.primary },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    padding: 16, borderRadius: 14, marginBottom: 12,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
      android: { elevation: 2 },
      // web: same soft shadow as iOS (rnweb maps shadow* → box-shadow) so
      // cards don't render flat on the PWA.
      default: { shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
    }),
  },
  cardIcon: {
    width: 52, height: 52, borderRadius: 13,
    alignItems: 'center', justifyContent: 'center',
  },
  cardBody: { flex: 1 },
  cardTitle: { fontSize: 16, fontWeight: '800', color: colors.text },
  cardMeta: { fontSize: 12, color: colors.textMuted, marginTop: 3 },
  cardActions: { alignItems: 'center' },
  shareBtn: { alignItems: 'center', gap: 2, paddingHorizontal: 8 },
  shareBtnText: { fontSize: 11, fontWeight: '700', color: colors.primary, letterSpacing: 0.3 },
});
