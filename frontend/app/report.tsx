/**
 * AI Performance Report (admin-only). Collates a BA's — or a team's — Field
 * KPIs and Bells attendance for a period, with a Claude-written
 * narrative on top. Numbers are computed server-side (deterministic); the AI
 * only analyses them.
 *
 * Opened two ways:
 *   • with params (?scope=individual&id=<user_id>&name=…) — e.g. tapping a BA
 *     on the Field KPIs tab — generates that report immediately.
 *   • with no params (from Profile → AI Reports) — shows a person/team picker.
 */
import React, { useMemo, useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, apiService } from '../src/api/client';
import { useAuth } from '../src/auth/AuthContext';
import { useColors, fonts } from '../src/theme/ThemeContext';
import { useTabBarClearance } from '../src/customization/CustomTabBar';
import { ScrollReveal } from '../src/components/ui/ScrollFx';
import { useParallaxScroll } from '../src/components/ui/Parallax';
import { APP_LOCALE } from '../src/utils/appTime';
import { roleWord } from '../src/utils/roleTitle';

type Scope = 'individual' | 'team';
const PERIODS = [
  { key: 'week', label: '1 Week' },
  { key: 'month', label: '1 Month' },
  { key: 'quarter', label: '1 Quarter' },
];
const fmt = (n: any) => (n === null || n === undefined ? '—' : Number(n).toLocaleString(APP_LOCALE));
const fmt1 = (n: any) => (n === null || n === undefined ? '—' : Number(n).toFixed(n >= 100 ? 0 : 1));

// Render the plain-text narrative: SHORT CAPS lines = headers, "- " = bullets.
function Narrative({ text, styles, colors }: any) {
  const lines = (text || '').split('\n');
  return (
    <View>
      {lines.map((ln: string, i: number) => {
        const t = ln.trim();
        if (!t) return <View key={i} style={{ height: 6 }} />;
        const isHeader = t.length <= 26 && t === t.toUpperCase() && /[A-Z]/.test(t);
        if (isHeader) return <Text key={i} style={styles.nHeader}>{t}</Text>;
        if (t.startsWith('- ') || t.startsWith('• ')) {
          return (
            <View key={i} style={styles.nBulletRow}>
              <Ionicons name="ellipse" size={5} color={colors.primary} style={{ marginTop: 7, marginRight: 8 }} />
              <Text style={styles.nBullet}>{t.replace(/^[-•]\s*/, '')}</Text>
            </View>
          );
        }
        return <Text key={i} style={styles.nPara}>{t}</Text>;
      })}
    </View>
  );
}

export default function ReportScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { user } = useAuth();
  const { scrollY, onScroll } = useParallaxScroll();
  const params = useLocalSearchParams<{ scope?: string; id?: string; name?: string; period?: string }>();

  const [scope, setScope] = useState<Scope>((params.scope as Scope) || 'individual');
  const [subjectId, setSubjectId] = useState<string | undefined>(typeof params.id === 'string' ? params.id : undefined);
  const [subjectName, setSubjectName] = useState<string>(typeof params.name === 'string' ? params.name : '');
  const [period, setPeriod] = useState<string>(typeof params.period === 'string' ? params.period : 'month');
  const [search, setSearch] = useState('');
  const [prompt, setPrompt] = useState('');
  const [reportData, setReportData] = useState<any>(null);
  const [periodLabel, setPeriodLabel] = useState<string>('');

  const gen = useMutation({
    mutationFn: async (v: { scope: Scope; id: string; period: string }) => {
      const body: any = { scope: v.scope, period: v.period, ai: true };
      if (v.scope === 'team') body.leader_id = v.id; else body.user_id = v.id;
      return (await api.post('/reports/generate', body)).data;
    },
    onSuccess: (d) => { setReportData(d); setPeriodLabel(''); },
  });

  const promptM = useMutation({
    mutationFn: async (text: string) => (await api.post('/reports/prompt', { text })).data,
    onSuccess: (d) => {
      const r = d.resolved || {};
      setReportData(d); setScope(r.scope || 'individual');
      setSubjectId(r.entity_id); setSubjectName(r.name || ''); setPeriodLabel(r.period_label || '');
    },
  });

  const run = useCallback((id: string, name: string, sc: Scope, p: string) => {
    setSubjectId(id); setSubjectName(name); setScope(sc); setPeriod(p);
    gen.mutate({ scope: sc, id, period: p });
  }, [gen]);

  const reset = () => { setReportData(null); setSubjectId(undefined); setPeriodLabel(''); };

  // Auto-run when opened with params.
  useEffect(() => {
    if (subjectId) gen.mutate({ scope, id: subjectId, period });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busy = gen.isPending || promptM.isPending;

  // Picker data (only when no subject chosen).
  const usersQ = useQuery({
    enabled: !subjectId,
    queryKey: ['report-users'],
    queryFn: async () => (await apiService.getUsers()).data,
  });
  const people: any[] = (usersQ.data?.users || usersQ.data || []) as any[];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = people;
    if (scope === 'team') list = people.filter((u) => u.role === 'leader' || u.role === 'admin');
    if (q) list = list.filter((u) => (u.name || '').toLowerCase().includes(q));
    return list.slice(0, 60);
  }, [people, search, scope]);

  const data = reportData;
  const s = data?.structured;

  // Screen-level guard to match the server's require_admin — the Profile
  // entry is already admin-only, but the URL is directly reachable on web.
  // Placed after every hook so the hook order never varies.
  if (user && user.role !== 'admin') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, gap: 8, padding: 32 }}>
        <Stack.Screen options={{ title: 'AI Report' }} />
        <Ionicons name="lock-closed-outline" size={32} color={colors.textMuted} />
        <Text style={{ color: colors.text, fontSize: 15, fontWeight: '700' }}>Admins only</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: 'AI Report', headerTitleStyle: { fontFamily: fonts.display, color: colors.text } }} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: tabBarClearance + 32 }} keyboardShouldPersistTaps="handled" onScroll={onScroll} scrollEventThrottle={16}>
        {!reportData ? (
          <>
            {/* natural-language prompt */}
            <View style={styles.promptBox}>
              <Ionicons name="sparkles" size={16} color={colors.primary} />
              <TextInput
                style={styles.promptInput}
                value={prompt}
                onChangeText={setPrompt}
                placeholder="Ask… e.g. “Team Thryve’s report for July”"
                placeholderTextColor={colors.textMuted}
                returnKeyType="go"
                onSubmitEditing={() => prompt.trim() && promptM.mutate(prompt.trim())}
              />
              <TouchableOpacity disabled={!prompt.trim() || busy} onPress={() => promptM.mutate(prompt.trim())}
                style={[styles.promptGo, (!prompt.trim() || busy) && { opacity: 0.4 }]}>
                <Ionicons name="arrow-forward" size={16} color={colors.onPrimary} />
              </TouchableOpacity>
            </View>
            {promptM.isError && <Text style={styles.err}>{(promptM.error as any)?.response?.data?.detail || 'Couldn’t read that request.'}</Text>}
            {busy && <ActivityIndicator style={{ marginVertical: 16 }} color={colors.primary} />}

            <Text style={styles.orLine}>or pick manually</Text>
            {/* subject + period controls */}
            <View style={styles.scopeRow}>
              {(['individual', 'team'] as Scope[]).map((sc) => (
                <TouchableOpacity key={sc} onPress={() => { setScope(sc); }} style={[styles.scopeBtn, scope === sc && styles.scopeOn]}>
                  <Text style={[styles.scopeTxt, scope === sc && styles.scopeTxtOn]}>{sc === 'individual' ? 'Individual' : 'Team'}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.search}>
              <Ionicons name="search" size={16} color={colors.textMuted} />
              <TextInput style={styles.searchInput} value={search} onChangeText={setSearch}
                placeholder={scope === 'team' ? 'Find a coach…' : 'Find a BA…'} placeholderTextColor={colors.textMuted}
                autoCapitalize="words" autoCorrect={false} />
            </View>
            {usersQ.isLoading ? <ActivityIndicator style={{ marginTop: 24 }} color={colors.primary} /> : (
              filtered.map((u) => (
                <TouchableOpacity key={u.id} style={styles.pickRow} onPress={() => run(u.id, u.name, scope, period)}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.pickName}>{u.name}</Text>
                    <Text style={styles.pickRole}>{roleWord(u.role)}{scope === 'team' ? ' · team report' : ''}</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
                </TouchableOpacity>
              ))
            )}
          </>
        ) : (
          <>
            {/* header */}
            <Text style={styles.subject}>{subjectName || s?.name || 'Report'}</Text>
            {!!periodLabel && <Text style={styles.periodLabel}>{periodLabel}</Text>}
            <View style={styles.periodRow}>
              {PERIODS.map((p) => (
                <TouchableOpacity key={p.key} onPress={() => run(subjectId!, subjectName, scope, p.key)}
                  style={[styles.periodChip, !periodLabel && period === p.key && styles.periodOn]}>
                  <Text style={[styles.periodTxt, !periodLabel && period === p.key && styles.periodTxtOn]}>{p.label}</Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity onPress={reset} style={styles.changeBtn}>
                <Text style={styles.changeTxt}>Change</Text>
              </TouchableOpacity>
            </View>

            {gen.isPending ? (
              <View style={styles.loadingBox}>
                <ActivityIndicator color={colors.primary} />
                <Text style={styles.loadingTxt}>Building report & analysis…</Text>
              </View>
            ) : gen.isError ? (
              <Text style={styles.err}>Couldn’t build the report. Try again.</Text>
            ) : s ? (
              <>
                {/* AI narrative */}
                {!!data.narrative && (
                  <ScrollReveal scrollY={scrollY}>
                  <View style={styles.aiCard}>
                    <View style={styles.aiTag}><Ionicons name="sparkles" size={12} color={colors.primary} /><Text style={styles.aiTagTxt}>AI analysis</Text></View>
                    <Narrative text={data.narrative} styles={styles} colors={colors} />
                  </View>
                  </ScrollReveal>
                )}

                {/* structured numbers */}
                {s.scope === 'individual' ? (
                  <ScrollReveal scrollY={scrollY}><IndividualBlocks s={s} styles={styles} /></ScrollReveal>
                ) : (
                  <ScrollReveal scrollY={scrollY}><TeamBlocks s={s} styles={styles} onMember={(m: any) => run(m.user_id, m.name, 'individual', period)} /></ScrollReveal>
                )}
                <Text style={styles.rangeNote}>Data {data.range.from} → {data.range.to}</Text>
              </>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function Metric({ label, value, styles }: any) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricNum}>{value}</Text>
      <Text style={styles.metricLbl}>{label}</Text>
    </View>
  );
}

function IndividualBlocks({ s, styles }: any) {
  const f = s.field || {}; const b = s.bells || {};
  const t = f.totals || {};
  return (
    <>
      <Text style={styles.section}>Field KPIs</Text>
      <View style={styles.metricRow}>
        <Metric label="Doors" value={fmt(t.doors_knocked)} styles={styles} />
        <Metric label="Spoken" value={fmt(t.spoken_to)} styles={styles} />
        <Metric label="Presented" value={fmt(t.pitches_commenced)} styles={styles} />
        <Metric label="Closed" value={fmt(t.pitches_closed)} styles={styles} />
        <Metric label="Sign-ups" value={fmt(t.sales)} styles={styles} />
      </View>
      <Text style={styles.sub}>To land 1 sign-up: {fmt1(f.ratios_to_one_sale?.doors_knocked)} doors · {fmt1(f.ratios_to_one_sale?.spoken_to)} spoken · {fmt1(f.ratios_to_one_sale?.pitches_commenced)} presented</Text>

      <Text style={styles.section}>Attendance (Bells)</Text>
      <View style={styles.metricRow}>
        <Metric label="Days worked" value={fmt(b.total_days_worked)} styles={styles} />
        <Metric label="Days/wk" value={fmt1(b.avg_days_per_week)} styles={styles} />
        <Metric label="Sign-ups" value={fmt(b.total_sales)} styles={styles} />
        <Metric label="Sign-ups/wk" value={fmt1(b.avg_sales_per_week)} styles={styles} />
        <Metric label="Piece avg" value={fmt1(b.piece_avg)} styles={styles} />
      </View>

    </>
  );
}

function TeamBlocks({ s, styles, onMember }: any) {
  const t = s.team_field?.totals || {};
  return (
    <>
      <Text style={styles.section}>Team Field totals · {s.member_count} in tree</Text>
      <View style={styles.metricRow}>
        <Metric label="Doors" value={fmt(t.doors_knocked)} styles={styles} />
        <Metric label="Spoken" value={fmt(t.spoken_to)} styles={styles} />
        <Metric label="Presented" value={fmt(t.pitches_commenced)} styles={styles} />
        <Metric label="Closed" value={fmt(t.pitches_closed)} styles={styles} />
        <Metric label="Sign-ups" value={fmt(t.sales)} styles={styles} />
      </View>
      <Text style={styles.section}>Members</Text>
      {(s.members || []).map((m: any) => {
        const mt = m.field?.totals || {};
        return (
          <TouchableOpacity key={m.user_id} style={styles.memberRow} onPress={() => onMember(m)}>
            <View style={{ flex: 1 }}>
              <Text style={styles.memberName}>{m.name}</Text>
              <Text style={styles.memberSub}>{fmt(mt.sales)} sign-ups · {fmt(mt.doors_knocked)} doors · {fmt(m.bells?.total_days_worked)} days</Text>
            </View>
            <Ionicons name="chevron-forward" size={15} color="#999" />
          </TouchableOpacity>
        );
      })}
    </>
  );
}

const createStyles = (c: any) => StyleSheet.create({
  promptBox: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: c.surface, borderWidth: 1, borderColor: c.primary, borderRadius: 14, paddingLeft: 12, paddingRight: 6, paddingVertical: 6 },
  promptInput: { flex: 1, fontFamily: fonts.body, fontSize: 14, color: c.text, padding: 0, paddingVertical: 6 },
  promptGo: { width: 34, height: 34, borderRadius: 10, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  orLine: { fontFamily: fonts.body, fontSize: 11, color: c.textMuted, textAlign: 'center', marginVertical: 14, textTransform: 'uppercase', letterSpacing: 0.5 },
  periodLabel: { fontFamily: fonts.bodySemibold, fontSize: 13, color: c.primary, marginBottom: 10, marginTop: -4 },

  scopeRow: { flexDirection: 'row', backgroundColor: c.surfaceAlt, borderRadius: 12, padding: 4, gap: 4, marginBottom: 14 },
  scopeBtn: { flex: 1, paddingVertical: 9, borderRadius: 9, alignItems: 'center' },
  scopeOn: { backgroundColor: c.primary },
  scopeTxt: { fontFamily: fonts.bodySemibold, fontSize: 13, color: c.textSecondary },
  scopeTxtOn: { color: c.onPrimary },

  search: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  searchInput: { flex: 1, fontFamily: fonts.body, fontSize: 14, color: c.text, padding: 0 },
  pickRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 12, padding: 14, marginTop: 8 },
  pickName: { fontFamily: fonts.bodySemibold, fontSize: 14, color: c.text },
  pickRole: { fontFamily: fonts.body, fontSize: 11, color: c.textMuted, marginTop: 2, textTransform: 'capitalize' },

  subject: { fontFamily: fonts.display, fontSize: 22, color: c.text, marginBottom: 10 },
  periodRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 16, flexWrap: 'wrap' },
  periodChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
  periodOn: { backgroundColor: c.primary, borderColor: c.primary },
  periodTxt: { fontFamily: fonts.bodySemibold, fontSize: 12, color: c.textSecondary },
  periodTxtOn: { color: c.onPrimary },
  changeBtn: { marginLeft: 'auto', paddingHorizontal: 8, paddingVertical: 6 },
  changeTxt: { fontFamily: fonts.bodySemibold, fontSize: 12, color: c.primary },

  loadingBox: { alignItems: 'center', gap: 10, marginTop: 40 },
  loadingTxt: { fontFamily: fonts.body, fontSize: 13, color: c.textMuted },
  err: { fontFamily: fonts.body, fontSize: 13, color: c.textSecondary, textAlign: 'center', marginTop: 40 },

  aiCard: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 16, padding: 16, marginBottom: 8 },
  aiTag: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 10 },
  aiTagTxt: { fontFamily: fonts.bodyBold, fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase', color: c.primary },
  nHeader: { fontFamily: fonts.bodyBold, fontSize: 12, letterSpacing: 0.5, color: c.text, marginTop: 12, marginBottom: 4 },
  nPara: { fontFamily: fonts.body, fontSize: 13.5, lineHeight: 20, color: c.textSecondary, marginBottom: 2 },
  nBulletRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 3 },
  nBullet: { flex: 1, fontFamily: fonts.body, fontSize: 13.5, lineHeight: 20, color: c.textSecondary },

  section: { fontFamily: fonts.display, fontSize: 14, color: c.text, marginTop: 20, marginBottom: 10 },
  sub: { fontFamily: fonts.body, fontSize: 12, color: c.textMuted, marginTop: 8 },
  metricRow: { flexDirection: 'row', backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 14, paddingVertical: 12 },
  metric: { flex: 1, alignItems: 'center' },
  metricNum: { fontFamily: fonts.display, fontSize: 17, color: c.text },
  metricLbl: { fontFamily: fonts.body, fontSize: 9.5, color: c.textMuted, marginTop: 3, textAlign: 'center' },

  memberRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 12, padding: 12, marginBottom: 8 },
  memberName: { fontFamily: fonts.bodySemibold, fontSize: 14, color: c.text },
  memberSub: { fontFamily: fonts.body, fontSize: 11, color: c.textMuted, marginTop: 2 },
  rangeNote: { fontFamily: fonts.body, fontSize: 11, color: c.textMuted, textAlign: 'center', marginTop: 20 },
});
