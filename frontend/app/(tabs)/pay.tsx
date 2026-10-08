/**
 * Earnings Calculator — what a BA's week is worth, and when quality payments
 * land. Laid out the way the office's previous hub had it.
 *
 * Tabs:
 *   This week — "Your earnings this week" (live total), "Build your week"
 *     (£12 / £15 / £20 sign-up steppers), the call completion rate (under the
 *     threshold takes a deduction off every sign-up that week), the extra
 *     incentives, and the breakdown.
 *   Quality — the Quality Payments Calculator: a quality rate against the
 *     gate, monthly sign-ups over 12 months, when each payment lands.
 *   Rates — every rate and what it means. Admins edit them here.
 *
 * The formulas live in src/pay/vertexPay.ts (mirrored server-side in
 * backend/core/vertex_pay.py); every £ figure and % threshold is the office's
 * own (GET /commission-fees). What a person types is remembered on their
 * device. The week starts from their Bells row until they change it.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput, Platform, Pressable, Switch, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Slider from '@react-native-community/slider';
import { useTabBarClearance } from '../../src/customization/CustomTabBar';
import { useColors, fonts } from '../../src/theme/ThemeContext';
import { brand } from '../../src/theme/brand';
import { apiService } from '../../src/api/client';
import { useAuth } from '../../src/auth/AuthContext';
import { useActiveOffice } from '../../src/office/ActiveOfficeContext';
import { showAlert } from '../../src/utils/showAlert';
import { APP_LOCALE, APP_TZ, formatMoney } from '../../src/utils/appTime';
import { DepthCard } from '../../src/components/ui/DepthCard';
import { SlidingSegments } from '../../src/components/ui/SlidingSegments';
import {
  DEFAULT_FEES, FEE_BOUNDS, VertexFees, MonthKey, normalizeFees, weekPay, weekIncentive, monthIncentive,
  qualityProjection, addMonths, formatMonth, monthKey, toCount, toPct,
} from '../../src/pay/vertexPay';

// ==================== TYPES ====================
type SummaryMonth = { month: MonthKey; standard: number; target: number; sign_ups: number; weeks: number };
type MySummary = {
  week_ending: string;
  has_entry: boolean;
  this_week: { standard: number; target: number; sign_ups: number; days_worked: number; earnings: number };
  months: SummaryMonth[];
  fees: Partial<VertexFees>;
};
type Counts = { c12: number; c15: number; c20: number };

/** What the person types here, remembered per device (never sent anywhere). */
type Saved = {
  week?: Record<string, Counts>;       // by week_ending
  rate?: number;                       // call completion rate, %
  avgAge?: string;                     // average donor age
  quality?: { rate?: number; start?: MonthKey; signups?: Record<string, number> };
};
const STORE_KEY = 'vertex.earnings.v2';
const DEFAULT_QUALITY_RATE = 73;
type TabKey = 'week' | 'quality' | 'rates';

// The calculator's panels are dark in both themes, like the hub's.
const EC = {
  ink: brand.deep,
  surface: brand.forest,
  raised: '#163a2d',
  line: 'rgba(183,223,88,0.16)',
  lime: brand.lime,
  green: '#8fc13a',
  text: '#eef4e6',
  muted: '#a6baa8',
  red: '#f1928c',
  teal: '#4fd1c5',
};

// ==================== HELPERS ====================
function currentMonthKey(): MonthKey {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: APP_TZ, year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  const y = parseInt(parts.find((p) => p.type === 'year')?.value || '2026', 10);
  const m = parseInt(parts.find((p) => p.type === 'month')?.value || '1', 10);
  return monthKey({ year: y, month: m });
}
const shortMonth = (k: MonthKey) => formatMonth(k, 'short', APP_LOCALE);
const pounds = (n: number) => formatMoney(Math.round(n));
const pluralise = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Counts smoothly towards a number (jumps straight there with reduced motion). */
function useCountUp(target: number): number {
  const reduce = Platform.OS === 'web' && typeof window !== 'undefined'
    && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [shown, setShown] = useState(reduce ? target : 0);
  const cur = useRef(shown);
  const goal = useRef(target);
  goal.current = target;
  useEffect(() => {
    if (reduce) { cur.current = target; setShown(target); return; }
    let frame = 0;
    let last = Date.now();
    const tick = () => {
      const now = Date.now();
      const k = 1 - Math.exp(-Math.min(64, now - last) / 110);
      last = now;
      const next = cur.current + (goal.current - cur.current) * k;
      const done = Math.abs(goal.current - next) < 0.5;
      cur.current = done ? goal.current : next;
      setShown(cur.current);
      if (!done) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, reduce]);
  return shown;
}

// ==================== SCREEN ====================
export default function EarningsScreen() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const tabBarClearance = useTabBarClearance();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [tab, setTab] = useState<TabKey>('week');

  const summaryQ = useQuery({
    queryKey: ['bells-my-summary', 12],
    queryFn: () => apiService.getMyBellsSummary(12).then((r) => r.data as MySummary),
    staleTime: 1000 * 30,
  });
  const settingsQ = useQuery({
    queryKey: ['app-settings', user?.office_id],
    queryFn: () => apiService.getSettings(user?.office_id).then((r) => r.data),
    staleTime: 1000 * 60,
  });
  const summary = summaryQ.data;
  const fees = useMemo(() => normalizeFees(summary?.fees), [summary?.fees]);

  const [saved, setSaved] = useState<Saved>({});
  const loaded = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORE_KEY);
        if (raw) setSaved(JSON.parse(raw) || {});
      } catch {}
      loaded.current = true;
    })();
  }, []);
  const update = useCallback((patch: Partial<Saved>) => {
    setSaved((prev) => {
      const next = { ...prev, ...patch };
      if (loaded.current) AsyncStorage.setItem(STORE_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const { officeId: activeOfficeId } = useActiveOffice();
  const ratesOffice = activeOfficeId || user?.office_id;
  const hidden = !isAdmin && settingsQ.data?.pay_tab_visible === false;
  const tabs = [{ key: 'week', label: 'This week' }, { key: 'quality', label: 'Quality' }, { key: 'rates', label: 'Rates' }];

  if (summaryQ.isLoading || settingsQ.isLoading) {
    return (
      <View style={[styles.container, styles.centred]}>
        <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading the Earnings Calculator" />
      </View>
    );
  }
  if (hidden) {
    return (
      <View style={[styles.container, { padding: 16, paddingTop: 24 }]}>
        <DepthCard style={styles.card} index={0}>
          <Text style={styles.cardTitle}>The Earnings Calculator is switched off for your office</Text>
          <Text style={styles.body}>Your office admin has turned it off for now. Ask them about your earnings.</Text>
        </DepthCard>
      </View>
    );
  }

  const nowMonth = summary?.months?.length ? summary.months[summary.months.length - 1].month : currentMonthKey();
  const monthSignUps = summary?.months?.find((m) => m.month === nowMonth)?.sign_ups ?? 0;

  return (
    <View style={styles.container}>
      <View style={styles.tabRow}>
        <SlidingSegments items={tabs} value={tab} onChange={(k) => setTab(k as TabKey)} testID="pay-tabs" />
      </View>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: tabBarClearance + 20 }]} keyboardShouldPersistTaps="handled">
        <View style={styles.column}>
          {summaryQ.isError && (
            <DepthCard style={styles.card}>
              <Text style={styles.body}>Couldn't load your Bells numbers just now. You can still build your week by hand.</Text>
            </DepthCard>
          )}
          {tab === 'week' && (
            <WeekCalculator
              fees={fees}
              weekEnding={summary?.week_ending || ''}
              bells={{ c12: summary?.this_week.standard ?? 0, c15: summary?.this_week.target ?? 0, c20: 0 }}
              hasBells={!!summary?.has_entry}
              monthSignUps={monthSignUps}
              saved={saved}
              update={update}
            />
          )}
          {tab === 'quality' && <QualityCalculator fees={fees} nowMonth={nowMonth} saved={saved} update={update} />}
          {tab === 'rates' && (isAdmin ? <RatesEditor officeId={ratesOffice} /> : <RatesGuide fees={fees} />)}
        </View>
      </ScrollView>
    </View>
  );
}

// ==================== THIS WEEK ====================
function WeekCalculator({ fees, weekEnding, bells, hasBells, monthSignUps, saved, update }: {
  fees: VertexFees; weekEnding: string; bells: Counts; hasBells: boolean; monthSignUps: number;
  saved: Saved; update: (p: Partial<Saved>) => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const edited = saved.week?.[weekEnding];
  const calc: Counts = edited ?? bells;
  const rate = saved.rate ?? fees.leadership_threshold_pct;
  const [rateText, setRateText] = useState<string | null>(null);
  const ageText = saved.avgAge ?? '';

  const signs = calc.c12 + calc.c15 + calc.c20;
  const pay = weekPay({
    standard: calc.c12, targetPlus: calc.c15 + calc.c20, premium: calc.c20,
    thirdDDs: 0, leadership: true, callCompletionPct: rate,
  }, fees);
  const base = pay.signUpFees;
  const deduction = pay.leadershipDeduction;
  const incentive = weekIncentive(signs, parseFloat(ageText), rate, fees);
  const month = monthIncentive(monthSignUps, parseFloat(ageText), rate, fees);
  const total = base - deduction + incentive.amount;
  const shownTotal = useCountUp(total);
  const below = rate < fees.leadership_threshold_pct;

  const setCount = (key: keyof Counts, value: number) =>
    update({ week: { ...(saved.week || {}), [weekEnding]: { ...calc, [key]: Math.max(0, Math.min(999, value)) } } });
  const setRate = (v: number) => update({ rate: Math.round(Math.min(100, Math.max(0, v)) * 10) / 10 });

  const tiers: { key: keyof Counts; title: string; description: string; fee: number }[] = [
    { key: 'c12', title: '£12', description: 'Standard sign-up', fee: fees.fee_standard },
    { key: 'c15', title: '£15', description: 'Target sign-up', fee: fees.fee_target },
    { key: 'c20', title: '£20', description: 'Premium sign-up', fee: fees.fee_premium },
  ];
  const kept = Math.max(0, base - deduction);
  const barTotal = Math.max(1, base + incentive.amount);

  return (
    <View testID="earnings-calculator">
      <Text style={[styles.lede, { marginBottom: 12 }]}>See what your week is worth as you go.</Text>

      {/* Your earnings this week */}
      <View style={styles.hero}>
        <View pointerEvents="none" style={styles.heroRing} />
        <Text style={[styles.kicker, { color: EC.lime }]}>Weekly estimate / live</Text>
        <Text style={styles.heroTitle}>Your earnings this week</Text>
        <Text style={styles.heroTotal} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5}
          accessibilityLabel={`Estimated earnings ${pounds(total)}`} testID="value-weekly-earnings">
          {pounds(shownTotal)}
        </Text>
        <View style={styles.heroBottom}>
          <Text style={styles.heroMeta}><Text style={styles.heroMetaStrong}>{signs}</Text> {signs === 1 ? 'sign-up' : 'sign-ups'}</Text>
          <Text style={styles.heroMeta}>Updated as you plan</Text>
        </View>
      </View>

      {/* 01 / Build your week */}
      <View style={styles.panel}>
        <View style={styles.panelHead}>
          <View style={{ flexShrink: 1 }}>
            <Text style={styles.kicker}>01 / Sign-ups</Text>
            <Text style={styles.panelTitle}>Build your week</Text>
          </View>
          <Text style={styles.panelAside}>BA fee per sign-up</Text>
        </View>
        {tiers.map(({ key, title, description, fee }, i) => (
          <View key={key} style={[styles.signupRow, i % 2 === 1 && styles.signupRowAlt]} testID={`row-signup-${key}`}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.signupTitle}>{title}</Text>
              <Text style={styles.signupSub}>{description} · {pounds(fee)} BA fee</Text>
            </View>
            <Stepper label={`${title} sign-ups`} value={calc[key]} onChange={(v) => setCount(key, v)} testKey={key} />
          </View>
        ))}
        {hasBells && (
          <View style={styles.bellsRow}>
            <Ionicons name="notifications-outline" size={13} color={EC.muted} />
            <Text style={styles.bellsText}>
              {edited
                ? `Bells has you on ${bells.c12} at £12 and ${bells.c15} at £15+ this week.`
                : 'Started from your Bells row for this week. Change any number to plan ahead.'}
            </Text>
            {edited ? (
              <Pressable onPress={() => { const w = { ...(saved.week || {}) }; delete w[weekEnding]; update({ week: w }); }} hitSlop={8}>
                <Text style={styles.bellsLink}>Use Bells</Text>
              </Pressable>
            ) : null}
          </View>
        )}
      </View>

      {/* 02 / Call completion rate */}
      <View style={[styles.panel, below && { borderColor: 'rgba(241,146,140,0.5)' }]}>
        <View style={styles.rateHead}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.kicker}>02 / Call completion rate</Text>
            <Text style={styles.panelTitle}>Call completion rate (posted Wednesday)</Text>
          </View>
          <View style={styles.rateEntry}>
            <TextInput
              style={styles.rateInput}
              value={rateText ?? String(rate)}
              onChangeText={(t) => {
                const clean = t.replace(/[^0-9.]/g, '').slice(0, 5);
                setRateText(clean);
                const n = parseFloat(clean);
                if (Number.isFinite(n)) setRate(n);
              }}
              onBlur={() => setRateText(null)}
              keyboardType="decimal-pad"
              selectTextOnFocus
              accessibilityLabel="Call completion rate, percent"
              testID="input-call-completion-rate-number"
            />
            <Text style={styles.rateUnit}>%</Text>
          </View>
        </View>
        <View style={styles.sliderWrap}>
          <Slider
            style={styles.slider}
            minimumValue={0}
            maximumValue={100}
            step={1}
            value={rate}
            onValueChange={(v) => { setRateText(null); setRate(v); }}
            minimumTrackTintColor={below ? EC.red : EC.lime}
            maximumTrackTintColor="rgba(238,244,230,0.18)"
            thumbTintColor={below ? EC.red : EC.lime}
            accessibilityLabel="Call completion rate slider"
            testID="input-call-completion-rate"
          />
          <Scale gate={fees.leadership_threshold_pct} label={`${fees.leadership_threshold_pct}% threshold`} />
          <Text style={[styles.rateNote, !below && styles.rateNoteClear]} testID="status-leadership-deduction">
            {below
              ? `Below ${fees.leadership_threshold_pct}%: ${pounds(fees.leadership_deduction)} is deducted per sign-up this week.`
              : `At or above ${fees.leadership_threshold_pct}%: no deduction this week.`}
          </Text>
        </View>
      </View>

      {/* 03 / Extra incentives */}
      <View style={styles.panel}>
        <View style={styles.panelHead}>
          <View style={{ flexShrink: 1 }}>
            <Text style={styles.kicker}>03 / Extra incentives</Text>
            <Text style={styles.panelTitle}>Extra incentives</Text>
          </View>
          <Text style={styles.panelAside}>Volume with quality</Text>
        </View>
        <View style={styles.signupRow}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.fieldTitle}>Average donor age</Text>
            <Text style={styles.signupSub}>Your week's average, from your quality report</Text>
          </View>
          <View style={styles.rateEntry}>
            <TextInput
              style={styles.rateInput}
              value={ageText}
              onChangeText={(t) => update({ avgAge: t.replace(/[^0-9.]/g, '').slice(0, 4) })}
              keyboardType="decimal-pad"
              placeholder="0"
              placeholderTextColor={EC.muted}
              selectTextOnFocus
              accessibilityLabel="Average donor age"
              testID="input-average-age"
            />
          </View>
        </View>
        <View style={styles.gates}>
          <Gate met={incentive.signUpsMet} text={`${fees.incentive_week_signups}+ sign-ups in the week`} />
          <Gate met={incentive.ageMet} text={`Average age ${fees.incentive_min_age}+`} />
          <Gate met={incentive.callsMet} text={`Call completion ${fees.incentive_call_pct}%+`} />
        </View>
        <Text style={[styles.rateNote, { marginHorizontal: 20 }, incentive.tier > 0 ? styles.rateNoteClear : styles.rateNoteIdle]} testID="status-week-incentive">
          {incentive.tier === 2
            ? `All three met with ${fees.incentive_week_top_signups}+ sign-ups: +${pounds(incentive.amount)} this week.`
            : incentive.tier === 1
              ? `All three met: +${pounds(incentive.amount)} this week. Reach ${fees.incentive_week_top_signups} sign-ups for ${pounds(fees.incentive_week_top_amount)}.`
              : `Meet all three for +${pounds(fees.incentive_week_amount)}, or +${pounds(fees.incentive_week_top_amount)} with ${fees.incentive_week_top_signups}+ sign-ups.`}
        </Text>
        <View style={styles.monthLine}>
          <Ionicons name={month.tier ? 'checkmark-circle' : 'calendar-outline'} size={15} color={month.tier ? EC.lime : EC.muted} />
          <Text style={styles.monthLineText}>
            In the month: {fees.incentive_month_signups}+ sign-ups with the same two quality gates adds {pounds(fees.incentive_month_amount)}.
            {' '}Bells has you on {monthSignUps} this month.
          </Text>
        </View>
      </View>

      {/* The breakdown */}
      <View style={styles.panel}>
        <View style={styles.panelHead}>
          <View style={{ flexShrink: 1 }}>
            <Text style={styles.kicker}>Your numbers / explained</Text>
            <Text style={styles.panelTitle}>The breakdown</Text>
          </View>
          <Text style={styles.panelAside}>Weekly estimate</Text>
        </View>
        <View style={styles.breakdown}>
          <Line label="Sign-up fees" value={pounds(base)} testID="value-signup-fees" />
          {deduction > 0 && <Line label="Quality deduction" value={`−${pounds(deduction)}`} tone="red" testID="value-leadership-deduction" />}
          {incentive.amount > 0 && <Line label="Extra incentive" value={`+${pounds(incentive.amount)}`} tone="teal" testID="value-week-incentive" />}
          <Line label="Estimated total" value={pounds(total)} total testID="value-breakdown-total" />
        </View>
        <View style={styles.composition}>
          <View style={styles.compositionLabel}>
            <Text style={styles.compositionText}>Where your earnings come from</Text>
            <Text style={styles.compositionText}>Estimated {pounds(total)}</Text>
          </View>
          <View style={styles.track} accessibilityRole="image"
            accessibilityLabel={`Sign-up fees ${pounds(base)}${deduction ? `, quality deduction minus ${pounds(deduction)}` : ''}${incentive.amount ? `, extra incentive ${pounds(incentive.amount)}` : ''}`}>
            <View style={{ flex: kept / barTotal, backgroundColor: EC.lime }} />
            {deduction > 0 && <View style={{ flex: deduction / barTotal, backgroundColor: EC.red }} />}
            {incentive.amount > 0 && <View style={{ flex: incentive.amount / barTotal, backgroundColor: EC.teal }} />}
            {base + incentive.amount === 0 && <View style={{ flex: 1 }} />}
          </View>
          <View style={styles.key}>
            <KeyDot colour={EC.lime} text="Sign-ups" />
            {deduction > 0 && <KeyDot colour={EC.red} text="Deducted" />}
            {incentive.amount > 0 && <KeyDot colour={EC.teal} text="Extra incentive" />}
          </View>
        </View>
      </View>

      <Text style={styles.foot}>These figures are based on the numbers you enter. Check them against Field IQ.</Text>
    </View>
  );
}

// ==================== QUALITY ====================
function QualityCalculator({ fees, nowMonth, saved, update }: {
  fees: VertexFees; nowMonth: MonthKey; saved: Saved; update: (p: Partial<Saved>) => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const q = saved.quality || {};
  const save = (patch: Partial<NonNullable<Saved['quality']>>) => update({ quality: { ...q, ...patch } });
  const rate = Math.round(q.rate ?? DEFAULT_QUALITY_RATE);
  const start = q.start || nowMonth;
  const signups = q.signups || {};
  const gate = fees.quality_gate_pct;
  const lag = fees.quality_lag_months;
  const passes = rate >= gate;

  const months = Array.from({ length: 12 }, (_, i) => addMonths(start, i));
  const projection = qualityProjection(start, months.map((m) => signups[m] ?? 0), rate, fees);
  const rows = projection.rows;
  const totalSignups = rows.reduce((a, r) => a + r.signUps, 0);
  const totalQualifying = rows.reduce((a, r) => a + r.qualifying, 0);
  const shownPay = useCountUp(projection.total);
  const maxPay = Math.max(1, ...rows.map((r) => r.payment));
  const example = `${formatMonth(addMonths('2026-09', 0), 'long', APP_LOCALE).split(' ')[0]} sign-ups are paid in ${formatMonth(addMonths('2026-09', lag), 'long', APP_LOCALE).split(' ')[0]}`;

  return (
    <View testID="quality-calculator">
      <View style={styles.header}>
        <Text style={styles.eyebrow}>My tools</Text>
        <Text style={styles.h1}>Quality Payments Calculator</Text>
        <Text style={styles.lede}>
          Enter your monthly sign-ups and set your quality rate to see your quality payments over 12 months. Quality payments are paid {pluralise(lag, 'month')} after the sign-up month.
        </Text>
      </View>

      {/* How it works */}
      <View style={styles.how}>
        <View style={styles.howHead}>
          <Ionicons name="information-circle-outline" size={16} color={colors.text} />
          <Text style={styles.howTitle}>How quality payments work</Text>
        </View>
        <Text style={styles.howText}>
          If a supporter you sign up keeps donating for 3 months (3 direct debits), you earn {pounds(fees.quality_payment)} for them. It's paid {pluralise(lag, 'month')} after the month you signed them up: for example, {example}. To qualify, your quality rate for that month must be {gate}% or higher.
        </Text>
      </View>

      {/* Quality rate */}
      <View style={[styles.panel, !passes && { borderColor: 'rgba(241,146,140,0.5)' }]}>
        <View style={styles.rateHead}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.panelTitle}>Quality rate</Text>
            <View style={[styles.chip, passes ? styles.chipPass : styles.chipFail]}>
              <Text style={[styles.chipText, { color: passes ? brand.deep : '#ffd9d6' }]}>
                {passes ? `Above the ${gate}% gate: payments unlocked` : `Below the ${gate}% gate: no payments`}
              </Text>
            </View>
          </View>
          <Text style={[styles.bigRate, !passes && { color: EC.red }]}>{rate}<Text style={styles.bigRateUnit}>%</Text></Text>
        </View>
        <View style={styles.sliderWrap}>
          <Slider
            style={styles.slider}
            minimumValue={0}
            maximumValue={100}
            step={1}
            value={rate}
            onValueChange={(v) => save({ rate: Math.round(v) })}
            minimumTrackTintColor={passes ? EC.lime : EC.red}
            maximumTrackTintColor="rgba(238,244,230,0.18)"
            thumbTintColor={passes ? EC.lime : EC.red}
            accessibilityLabel="Quality rate, percent"
            testID="input-quality-rate"
          />
          <Scale gate={gate} label={`${gate}% gate`} />
          {!passes && (
            <View style={styles.warn}>
              <Ionicons name="alert-circle-outline" size={16} color={EC.red} />
              <Text style={styles.warnText}>Below the {gate}% gate. No quality payments will be made until your rate reaches {gate}% or above.</Text>
            </View>
          )}
        </View>
      </View>

      {/* Summary */}
      <View style={styles.summary}>
        <View style={styles.summaryTile}>
          <Text style={styles.summaryLabel}>Sign-ups</Text>
          <Text style={styles.summaryValue}>{totalSignups}</Text>
          <Text style={styles.summarySub}>over 12 months</Text>
        </View>
        <View style={styles.summaryTile}>
          <Text style={styles.summaryLabel}>Qualifying supporters</Text>
          <Text style={styles.summaryValue}>{totalQualifying}</Text>
          <Text style={styles.summarySub}>reach their 3rd DD at {rate}%</Text>
        </View>
        <View style={[styles.summaryTile, styles.summaryBig]}>
          <Text style={[styles.summaryLabel, { color: EC.muted }]}>Total quality payments</Text>
          <Text style={[styles.summaryValue, { color: EC.lime }]} testID="value-quality-total">{pounds(shownPay)}</Text>
          <Text style={[styles.summarySub, { color: EC.muted }]}>
            {passes ? `${pounds(fees.quality_payment)} × ${totalQualifying}` : `Get above ${gate}% to unlock`}
          </Text>
        </View>
      </View>

      {/* When you get paid */}
      <DepthCard style={styles.card}>
        <Text style={styles.cardTitle}>When you get paid</Text>
        <View style={styles.bars} accessibilityRole="image"
          accessibilityLabel={`Payments by month paid: ${rows.map((r) => `${shortMonth(r.paidMonth)} ${pounds(r.payment)}`).join(', ')}`}>
          {rows.map((r) => (
            <View key={r.signUpMonth} style={styles.bar}>
              <Text style={styles.barValue} numberOfLines={1}>{r.payment ? pounds(r.payment) : ''}</Text>
              <View style={styles.barTrack}>
                <View style={[styles.barFill, { height: `${(r.payment / maxPay) * 100}%` as any }]} />
              </View>
              <Text style={styles.barLabel} numberOfLines={1}>{shortMonth(r.paidMonth).replace(' 20', " '")}</Text>
            </View>
          ))}
        </View>
      </DepthCard>

      {/* 12-month projection */}
      <DepthCard style={styles.card}>
        <View style={styles.tableHead}>
          <Text style={[styles.cardTitle, { marginBottom: 0, flex: 1 }]}>12-month projection</Text>
          <Text style={styles.startLabel}>Starting</Text>
          <Pressable onPress={() => save({ start: addMonths(start, -1) })} style={styles.navBtn} accessibilityLabel="Start a month earlier" hitSlop={6}>
            <Ionicons name="chevron-back" size={16} color={colors.text} />
          </Pressable>
          <Text style={styles.startMonth}>{shortMonth(start)}</Text>
          <Pressable onPress={() => save({ start: addMonths(start, 1) })} style={styles.navBtn} accessibilityLabel="Start a month later" hitSlop={6}>
            <Ionicons name="chevron-forward" size={16} color={colors.text} />
          </Pressable>
        </View>
        <View style={styles.tr}>
          <Text style={[styles.th, styles.cMonth]}>Month</Text>
          <Text style={[styles.th, styles.cIn]}>Sign-ups</Text>
          <Text style={[styles.th, styles.cQual]}>{rate}% 3rd donation</Text>
          <Text style={[styles.th, styles.cPaid]}>Paid in</Text>
          <Text style={[styles.th, styles.cPay]}>Quality payment</Text>
        </View>
        {rows.map((r) => (
          <View key={r.signUpMonth} style={styles.tr}>
            <Text style={[styles.tdStrong, styles.cMonth]}>{shortMonth(r.signUpMonth)}</Text>
            <View style={styles.cIn}>
              <TextInput
                style={styles.cellInput}
                value={r.signUps ? String(r.signUps) : ''}
                placeholder="0"
                placeholderTextColor={colors.textMuted}
                onChangeText={(t) => save({ signups: { ...signups, [r.signUpMonth]: toCount(t.replace(/[^0-9]/g, '')) } })}
                keyboardType="number-pad"
                selectTextOnFocus
                accessibilityLabel={`${formatMonth(r.signUpMonth, 'long', APP_LOCALE)} sign-ups`}
              />
            </View>
            <Text style={[styles.td, styles.cQual]}>{r.signUps ? r.qualifying : '—'}</Text>
            <Text style={[styles.td, styles.cPaid]}>{shortMonth(r.paidMonth)}</Text>
            <Text style={[r.signUps && passes ? styles.tdStrong : styles.td, styles.cPay]}>
              {r.signUps ? (passes ? pounds(r.payment) : '£0 · below gate') : '—'}
            </Text>
          </View>
        ))}
        <View style={[styles.tr, styles.trTotal]}>
          <Text style={[styles.tdStrong, styles.cMonth]}>Total</Text>
          <Text style={[styles.tdStrong, styles.cIn, { textAlign: 'center' }]}>{totalSignups || '—'}</Text>
          <Text style={[styles.tdStrong, styles.cQual]}>{totalSignups ? totalQualifying : '—'}</Text>
          <Text style={[styles.td, styles.cPaid]} />
          <Text style={[styles.tdStrong, styles.cPay]}>{pounds(projection.total)}</Text>
        </View>
      </DepthCard>

      <Text style={styles.foot}>
        Projections assume the same quality rate every month. Actual payments depend on 3rd direct debits confirmed by the charity, and the {gate}% gate must be met in each individual month.
      </Text>
      <Text style={styles.foot}>These figures are based on the numbers you enter. Check them against Field IQ.</Text>
    </View>
  );
}

// ==================== RATES ====================
type RateField = { key: keyof VertexFees; label: string; unit: '£' | '%' | 'months' | 'count' | 'years'; help: string };
const RATE_GROUPS: Array<{ title: string; hint: string; fields: RateField[]; adminOnly?: boolean }> = [
  {
    title: 'Sign-up fees',
    hint: 'What a BA earns for each sign-up, by the donor\'s monthly gift. Bells prices its £15+ column at the Target fee.',
    fields: [
      { key: 'fee_standard', label: '£12 Standard', unit: '£', help: 'BA fee for each £12 a month sign-up.' },
      { key: 'fee_target', label: '£15 Target', unit: '£', help: 'BA fee for each £15 a month sign-up.' },
      { key: 'fee_premium', label: '£20 Premium', unit: '£', help: 'BA fee for each £20 a month sign-up.' },
    ],
  },
  {
    title: 'Call completion',
    hint: 'The call completion rate is posted each Wednesday. Below the threshold, the deduction comes off every sign-up that week.',
    fields: [
      { key: 'leadership_threshold_pct', label: 'Call completion threshold', unit: '%', help: 'A week under this rate takes the deduction.' },
      { key: 'leadership_deduction', label: 'Deduction per sign-up', unit: '£', help: 'Taken off each sign-up in a week under the threshold.' },
    ],
  },
  {
    title: 'Extra incentives',
    hint: 'Added on top for volume with quality. Every one needs both quality gates: the average donor age and the call completion rate.',
    fields: [
      { key: 'incentive_min_age', label: 'Average donor age', unit: 'years', help: 'Quality gate: the average age must be this or higher.' },
      { key: 'incentive_call_pct', label: 'Call completion rate', unit: '%', help: 'Quality gate: call completion must be this or higher.' },
      { key: 'incentive_week_signups', label: 'Weekly sign-ups', unit: 'count', help: 'This many sign-ups or more in a week, with both gates met…' },
      { key: 'incentive_week_amount', label: 'Weekly incentive', unit: '£', help: '…earns this on top of that week\'s fees.' },
      { key: 'incentive_week_top_signups', label: 'Weekly sign-ups, top level', unit: 'count', help: 'This many or more in a week, with both gates met…' },
      { key: 'incentive_week_top_amount', label: 'Weekly incentive, top level', unit: '£', help: '…earns this instead of the weekly incentive.' },
      { key: 'incentive_month_signups', label: 'Monthly sign-ups', unit: 'count', help: 'This many sign-ups or more in a month, with both gates met…' },
      { key: 'incentive_month_amount', label: 'Monthly incentive', unit: '£', help: '…earns this on top for the month.' },
    ],
  },
  {
    title: 'Quality payments',
    hint: 'Paid for supporters who reach their 3rd direct debit, in months that meet the quality gate.',
    fields: [
      { key: 'quality_gate_pct', label: 'Monthly quality gate', unit: '%', help: 'The month\'s quality rate must be this or higher to be paid.' },
      { key: 'quality_payment', label: 'Per qualifying supporter', unit: '£', help: 'Paid for each supporter who reaches their 3rd direct debit.' },
      { key: 'quality_lag_months', label: 'Paid after (months)', unit: 'months', help: 'How many months after the sign-up month the payment lands.' },
    ],
  },
  {
    title: 'Office (MC) fees',
    hint: 'What the office is paid for each sign-up. Only Admins see this, here and in the MC fees column on Bells.',
    adminOnly: true,
    fields: [
      { key: 'fee_mc', label: 'MC fee per sign-up', unit: '£', help: 'What the office is paid for every sign-up, whatever the gift.' },
    ],
  },
];
const ALL_FIELDS = RATE_GROUPS.flatMap((g) => g.fields);
const showValue = (f: RateField, v: number) =>
  f.unit === '£' ? formatMoney(v) : f.unit === '%' ? `${v}%` : f.unit === 'months' ? pluralise(v, 'month') : f.unit === 'years' ? `${v}+` : `${v}+`;

/** Everyone else: the office's rates and what each one means (read-only). */
function RatesGuide({ fees }: { fees: VertexFees }) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <DepthCard style={styles.card} index={0}>
      <Text style={styles.cardTitle}>Your office's rates</Text>
      {RATE_GROUPS.filter((g) => !g.adminOnly).map((g) => (
        <View key={g.title} style={styles.rateGroup}>
          <Text style={styles.cardLabel}>{g.title}</Text>
          <Text style={[styles.fieldHint, { marginBottom: 4 }]}>{g.hint}</Text>
          {g.fields.map((f) => (
            <View key={f.key} style={styles.fieldRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldLabel}>{f.label}</Text>
                <Text style={styles.fieldHint}>{f.help}</Text>
              </View>
              <Text style={styles.guideValue}>{showValue(f, fees[f.key])}</Text>
            </View>
          ))}
        </View>
      ))}
      <Text style={styles.note}>Only the Owner changes these. The calculator uses them straight away.</Text>
    </DepthCard>
  );
}

function RatesEditor({ officeId }: { officeId?: string }) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const queryClient = useQueryClient();

  const feesQ = useQuery({
    queryKey: ['commission-fees', officeId],
    queryFn: () => apiService.getCommissionFees(officeId).then((r) => r.data),
    enabled: !!officeId,
  });
  const settingsQ = useQuery({
    queryKey: ['app-settings', officeId],
    queryFn: () => apiService.getSettings(officeId).then((r) => r.data),
    enabled: !!officeId,
  });
  const fees = useMemo(() => normalizeFees(feesQ.data), [feesQ.data]);
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const values: Record<string, string> = draft ?? Object.fromEntries(Object.entries(fees).map(([k, v]) => [k, String(v)]));

  const invalid = ALL_FIELDS.filter((f) => {
    const n = Number(values[f.key]);
    const [lo, hi] = FEE_BOUNDS[f.key];
    return values[f.key] === '' || !Number.isFinite(n) || n < lo || n > hi;
  });

  const saveMut = useMutation({
    mutationFn: (body: Partial<VertexFees>) => apiService.updateCommissionFees(body, officeId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['commission-fees'] });
      queryClient.invalidateQueries({ queryKey: ['bells-my-summary'] });
      queryClient.invalidateQueries({ queryKey: ['bells'] });
      setDraft(null);
      showAlert('Saved', 'Rates updated for this office.');
    },
    onError: (e: any) => showAlert('Not saved', e?.response?.data?.detail || 'Could not update the rates.'),
  });
  const visibilityMut = useMutation({
    mutationFn: (visible: boolean) => apiService.updateSettings({ pay_tab_visible: visible }, officeId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['app-settings'] }),
    onError: () => showAlert('Not saved', 'Could not change the setting.'),
  });

  if (feesQ.isLoading) {
    return <ActivityIndicator style={{ marginTop: 32 }} color={colors.primary} accessibilityLabel="Loading the rates" />;
  }

  const visible = settingsQ.data?.pay_tab_visible !== false;
  const save = () => {
    if (invalid.length) {
      showAlert('Check the rates', `${invalid.map((f) => f.label).join(', ')}: enter a number in range.`);
      return;
    }
    saveMut.mutate(Object.fromEntries(ALL_FIELDS.map((f) => [f.key, Number(values[f.key])])) as Partial<VertexFees>);
  };

  return (
    <>
      <DepthCard style={styles.card} index={0}>
        <View style={styles.fieldRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.fieldLabel}>Earnings Calculator visible to the team</Text>
            <Text style={styles.fieldHint}>When off, only admins can see it{feesQ.data?.office_name ? ` in ${feesQ.data.office_name}` : ''}</Text>
          </View>
          <Switch
            value={visible}
            onValueChange={(v) => visibilityMut.mutate(v)}
            trackColor={{ false: colors.border, true: colors.primary }}
            thumbColor={colors.background}
            accessibilityLabel="Earnings Calculator visible to the team"
          />
        </View>
      </DepthCard>

      <DepthCard style={styles.card}>
        <Text style={styles.cardTitle}>Rates{feesQ.data?.office_name ? ` · ${feesQ.data.office_name}` : ''}</Text>
        {RATE_GROUPS.map((g) => (
          <View key={g.title} style={styles.rateGroup}>
            <Text style={styles.cardLabel}>{g.title}</Text>
            <Text style={[styles.fieldHint, { marginBottom: 4 }]}>{g.hint}</Text>
            {g.fields.map((f) => {
              const bad = invalid.some((x) => x.key === f.key);
              return (
                <View key={f.key} style={styles.fieldRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.fieldLabel}>{f.label}</Text>
                    <Text style={styles.fieldHint}>{f.help}</Text>
                  </View>
                  {/* Fixed prefix/suffix slots keep every input in one column. */}
                  <Text style={styles.prefix}>{f.unit === '£' ? '£' : ''}</Text>
                  <TextInput
                    style={[styles.smallInput, bad && { borderColor: colors.red }]}
                    value={values[f.key]}
                    onChangeText={(v) => setDraft({ ...values, [f.key]: v.replace(/[^0-9.]/g, '').slice(0, 7) })}
                    keyboardType="decimal-pad"
                    placeholderTextColor={colors.textMuted}
                    accessibilityLabel={`${g.title}: ${f.label}`}
                    testID={`rate-${f.key}`}
                  />
                  <Text style={styles.suffix}>{f.unit === '%' ? '%' : ''}</Text>
                </View>
              );
            })}
          </View>
        ))}

        <View style={styles.actions}>
          <Pressable
            style={[styles.primaryBtn, (!draft || saveMut.isPending) && styles.btnDisabled]}
            disabled={!draft || saveMut.isPending}
            onPress={save}
            accessibilityRole="button"
          >
            <Text style={styles.primaryBtnText}>{saveMut.isPending ? 'Saving…' : 'Save rates'}</Text>
          </Pressable>
          {draft && (
            <Pressable style={styles.secondaryBtn} onPress={() => setDraft(null)} accessibilityRole="button">
              <Text style={styles.secondaryBtnText}>Cancel</Text>
            </Pressable>
          )}
        </View>
        <Pressable
          style={styles.linkBtn}
          onPress={() => setDraft(Object.fromEntries(Object.entries(DEFAULT_FEES).map(([k, v]) => [k, String(v)])))}
        >
          <Ionicons name="refresh" size={14} color={colors.text} />
          <Text style={styles.linkBtnText}>Fill in the standard Vertex rates</Text>
        </Pressable>
        <Text style={styles.note}>
          Standard: £12 → £55, £15 and £20 → £60. Call completion under 70% takes £5 off per sign-up. Extra incentives: 12+ sign-ups in a week with an average age of 45+ and 85%+ call completion adds £50, 16+ adds £100, and 50+ in a month adds £100. Quality payments: 70% gate, £15 per supporter, paid 4 months later. Bells' fee estimates and everyone's Earnings Calculator use these straight away.
        </Text>
      </DepthCard>
    </>
  );
}

// ==================== SUB-COMPONENTS ====================
function Stepper({ label, value, onChange, testKey }: { label: string; value: number; onChange: (v: number) => void; testKey: string }) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.stepper} accessibilityLabel={`${label} quantity`}>
      <Pressable onPress={() => onChange(value - 1)} disabled={value <= 0} style={[styles.stepBtn, value <= 0 && { opacity: 0.35 }]}
        accessibilityLabel={`Decrease ${label}`} testID={`button-decrease-${testKey}`}>
        <Ionicons name="remove" size={18} color={EC.text} />
      </Pressable>
      <Text style={styles.stepValue} accessibilityLabel={`${label} count`} testID={`value-count-${testKey}`}>{value}</Text>
      <Pressable onPress={() => onChange(value + 1)} style={styles.stepBtn}
        accessibilityLabel={`Increase ${label}`} testID={`button-increase-${testKey}`}>
        <Ionicons name="add" size={18} color={EC.text} />
      </Pressable>
    </View>
  );
}

/** 0% · the gate, sitting under its point on the slider · 100% */
function Scale({ gate, label }: { gate: number; label: string }) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.scale}>
      <Text style={styles.scaleText}>0%</Text>
      <View pointerEvents="none" style={[styles.scaleGate, { left: `${gate}%` as any }]}>
        <View style={styles.scaleTick} />
        <Text style={[styles.scaleText, { color: EC.lime }]} numberOfLines={1}>{label}</Text>
      </View>
      <Text style={styles.scaleText}>100%</Text>
    </View>
  );
}

function Gate({ met, text }: { met: boolean; text: string }) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={[styles.gate, met && styles.gateMet]}>
      <Ionicons name={met ? 'checkmark-circle' : 'ellipse-outline'} size={15} color={met ? EC.lime : EC.muted} />
      <Text style={[styles.gateText, met && { color: EC.text }]}>{text}</Text>
    </View>
  );
}

function Line({ label, value, tone, total, testID }: { label: string; value: string; tone?: 'red' | 'teal'; total?: boolean; testID?: string }) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const c = tone === 'red' ? EC.red : tone === 'teal' ? EC.teal : EC.text;
  return (
    <View style={[styles.line, total && styles.lineTotal]}>
      <Text style={[styles.lineLabel, total && styles.lineLabelTotal, tone && { color: c }]}>{label}</Text>
      <Text style={[styles.lineValue, total && styles.lineValueTotal, tone && { color: c }]} testID={testID}>{value}</Text>
    </View>
  );
}

function KeyDot({ colour, text }: { colour: string; text: string }) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.keyItem}>
      <View style={[styles.keyDot, { backgroundColor: colour }]} />
      <Text style={styles.compositionText}>{text}</Text>
    </View>
  );
}

// ==================== STYLES ====================
const createStyles = (colors: any) => StyleSheet.create({
  container: { flex: 1 },
  centred: { alignItems: 'center', justifyContent: 'center' },
  tabRow: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10, maxWidth: 852, width: '100%', alignSelf: 'center' },
  content: { padding: 16 },
  column: { width: '100%', maxWidth: 820, alignSelf: 'center' },

  // Page head (on the page field, so theme colours)
  header: { marginBottom: 16 },
  eyebrow: { fontFamily: fonts.mono, fontSize: 10.5, letterSpacing: 1.8, textTransform: 'uppercase', color: colors.textSecondary },
  h1: { fontFamily: fonts.display, fontSize: 30, lineHeight: 35, letterSpacing: -0.8, color: colors.text, marginTop: 6 },
  lede: { fontFamily: fonts.body, fontSize: 13.5, lineHeight: 20, color: colors.textSecondary, marginTop: 5 },
  foot: { fontFamily: fonts.body, fontSize: 12, lineHeight: 17, color: colors.textMuted, marginTop: 4, marginBottom: 6 },

  // Hero
  hero: { overflow: 'hidden', borderRadius: 24, padding: 26, backgroundColor: EC.ink, borderWidth: 1, borderColor: 'rgba(183,223,88,0.22)',
    boxShadow: '0 22px 45px -28px rgba(16,32,15,0.55)' } as any,
  heroRing: { position: 'absolute', width: 280, height: 280, right: -78, top: -92, borderRadius: 140, borderWidth: 1,
    borderColor: 'rgba(183,223,88,0.14)', boxShadow: '0 0 0 42px rgba(183,223,88,0.04), 0 0 0 88px rgba(183,223,88,0.025)' } as any,
  kicker: { fontFamily: fonts.mono, fontSize: 10.5, letterSpacing: 1.8, textTransform: 'uppercase', color: EC.green },
  heroTitle: { fontFamily: fonts.display, fontSize: 22, color: '#e5ecdf', marginTop: 14 },
  heroTotal: { fontFamily: fonts.display, fontSize: 76, lineHeight: 86, letterSpacing: -3.5, color: EC.lime, fontVariant: ['tabular-nums'] as any },
  heroBottom: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 24, rowGap: 6, marginTop: 16, paddingTop: 16,
    borderTopWidth: 1, borderTopColor: 'rgba(183,223,88,0.18)' },
  heroMeta: { fontFamily: fonts.body, fontSize: 12.5, color: '#b9c9b5' },
  heroMetaStrong: { fontFamily: fonts.bodyBold, color: EC.text },

  // Panels
  panel: { marginTop: 14, borderRadius: 19, overflow: 'hidden', backgroundColor: EC.surface, borderWidth: 1, borderColor: EC.line },
  panelHead: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, paddingHorizontal: 20, paddingTop: 20, paddingBottom: 15 },
  panelTitle: { fontFamily: fonts.display, fontSize: 20, lineHeight: 25, color: EC.text, marginTop: 5 },
  panelAside: { fontFamily: fonts.body, fontSize: 11.5, color: EC.muted },
  signupRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 84, paddingHorizontal: 20, paddingVertical: 14, borderTopWidth: 1, borderTopColor: EC.line },
  signupRowAlt: { backgroundColor: 'rgba(183,223,88,0.03)' },
  signupTitle: { fontFamily: fonts.display, fontSize: 26, color: EC.text },
  fieldTitle: { fontFamily: fonts.display, fontSize: 17, color: EC.text },
  signupSub: { fontFamily: fonts.body, fontSize: 11.5, lineHeight: 16, color: EC.muted, marginTop: 4 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 3, padding: 4, borderRadius: 14, backgroundColor: EC.ink, borderWidth: 1, borderColor: 'rgba(183,223,88,0.22)' },
  stepBtn: { width: 44, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: EC.raised },
  stepValue: { minWidth: 46, textAlign: 'center', fontFamily: fonts.display, fontSize: 22, color: EC.text, fontVariant: ['tabular-nums'] as any },
  bellsRow: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 20, paddingVertical: 12, borderTopWidth: 1, borderTopColor: EC.line },
  bellsText: { flex: 1, fontFamily: fonts.body, fontSize: 11.5, lineHeight: 16, color: EC.muted },
  bellsLink: { fontFamily: fonts.bodySemibold, fontSize: 12, color: EC.lime },

  rateHead: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingTop: 20 },
  rateEntry: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, borderRadius: 13, backgroundColor: EC.ink, borderWidth: 1, borderColor: 'rgba(183,223,88,0.22)' },
  rateInput: { width: 62, height: 46, textAlign: 'center', fontFamily: fonts.display, fontSize: 21, color: EC.text, outlineStyle: 'none' } as any,
  rateUnit: { fontFamily: fonts.bodySemibold, fontSize: 15, color: EC.muted },
  sliderWrap: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 18 },
  slider: { width: '100%', height: 40 },
  scale: { flexDirection: 'row', justifyContent: 'space-between', height: 30 },
  scaleText: { fontFamily: fonts.mono, fontSize: 10, color: EC.muted },
  scaleGate: { position: 'absolute', top: -6, width: 120, marginLeft: -60, alignItems: 'center' },
  scaleTick: { width: 2, height: 8, borderRadius: 1, backgroundColor: EC.lime, marginBottom: 2 },
  rateNote: { fontFamily: fonts.bodySemibold, fontSize: 12.5, lineHeight: 18, color: '#ffd9d6', backgroundColor: 'rgba(241,146,140,0.12)',
    borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, marginTop: 6, overflow: 'hidden' },
  rateNoteClear: { color: EC.lime, backgroundColor: 'rgba(183,223,88,0.10)' },
  rateNoteIdle: { color: EC.text, backgroundColor: 'rgba(238,244,230,0.07)' },

  gates: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 20, paddingTop: 14, paddingBottom: 6, borderTopWidth: 1, borderTopColor: EC.line },
  gate: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(238,244,230,0.16)' },
  gateMet: { borderColor: 'rgba(183,223,88,0.5)', backgroundColor: 'rgba(183,223,88,0.08)' },
  gateText: { fontFamily: fonts.bodySemibold, fontSize: 12, color: EC.muted },
  monthLine: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 18 },
  monthLineText: { flex: 1, fontFamily: fonts.body, fontSize: 12, lineHeight: 17, color: EC.muted },

  breakdown: { paddingHorizontal: 20, borderTopWidth: 1, borderTopColor: EC.line },
  line: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: EC.line },
  lineTotal: { borderBottomWidth: 0, paddingTop: 15 },
  lineLabel: { fontFamily: fonts.body, fontSize: 14, color: EC.muted },
  lineLabelTotal: { fontFamily: fonts.bodyBold, fontSize: 15, color: EC.text },
  lineValue: { fontFamily: fonts.bodySemibold, fontSize: 16, color: EC.text, fontVariant: ['tabular-nums'] as any },
  lineValueTotal: { fontFamily: fonts.display, fontSize: 26, color: EC.lime },
  composition: { paddingHorizontal: 20, paddingTop: 6, paddingBottom: 20 },
  compositionLabel: { flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  compositionText: { fontFamily: fonts.body, fontSize: 11.5, color: EC.muted },
  track: { flexDirection: 'row', height: 12, borderRadius: 6, overflow: 'hidden', backgroundColor: 'rgba(238,244,230,0.10)' },
  key: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginTop: 9 },
  keyItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  keyDot: { width: 9, height: 9, borderRadius: 5 },

  // Quality
  how: { borderRadius: 16, padding: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  howHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  howTitle: { fontFamily: fonts.bodyBold, fontSize: 14, color: colors.text },
  howText: { fontFamily: fonts.body, fontSize: 13, lineHeight: 19.5, color: colors.textSecondary },
  chip: { alignSelf: 'flex-start', marginTop: 8, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  chipPass: { backgroundColor: EC.lime },
  chipFail: { backgroundColor: 'rgba(241,146,140,0.22)' },
  chipText: { fontFamily: fonts.bodySemibold, fontSize: 11.5 },
  bigRate: { fontFamily: fonts.display, fontSize: 52, letterSpacing: -2, color: EC.lime, fontVariant: ['tabular-nums'] as any },
  bigRateUnit: { fontSize: 22, letterSpacing: 0 },
  warn: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 6, padding: 11, borderRadius: 10, backgroundColor: 'rgba(241,146,140,0.12)' },
  warnText: { flex: 1, fontFamily: fonts.bodySemibold, fontSize: 12.5, lineHeight: 18, color: '#ffd9d6' },
  summary: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 14, marginBottom: 14 },
  summaryTile: { flexGrow: 1, flexBasis: 150, padding: 15, borderRadius: 16, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border },
  summaryBig: { flexBasis: 220, backgroundColor: EC.ink, borderColor: 'rgba(183,223,88,0.22)' },
  summaryLabel: { fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1.2, textTransform: 'uppercase', color: colors.textMuted },
  summaryValue: { fontFamily: fonts.display, fontSize: 32, letterSpacing: -1, color: colors.text, marginTop: 4, fontVariant: ['tabular-nums'] as any },
  summarySub: { fontFamily: fonts.body, fontSize: 11.5, color: colors.textMuted, marginTop: 2 },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 4, height: 170 },
  bar: { flex: 1, minWidth: 0, alignItems: 'center', height: '100%' },
  barValue: { fontFamily: fonts.mono, fontSize: 9, color: colors.textSecondary, height: 14 },
  barTrack: { flex: 1, width: '100%', justifyContent: 'flex-end', borderRadius: 6, backgroundColor: colors.surfaceAlt, overflow: 'hidden' },
  barFill: { width: '100%', minHeight: 0, borderRadius: 6, backgroundColor: colors.primary },
  barLabel: { fontFamily: fonts.mono, fontSize: 8.5, color: colors.textMuted, marginTop: 5 },
  tableHead: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 8 },
  startLabel: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted },
  startMonth: { fontFamily: fonts.bodySemibold, fontSize: 13, color: colors.text, minWidth: 66, textAlign: 'center' },
  navBtn: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },
  tr: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, borderBottomWidth: 1, borderBottomColor: colors.border },
  trTotal: { borderBottomWidth: 0, borderTopWidth: 1, borderTopColor: colors.text },
  th: { fontFamily: fonts.mono, fontSize: 9.5, letterSpacing: 0.6, textTransform: 'uppercase', color: colors.textMuted },
  td: { fontFamily: fonts.body, fontSize: 12.5, color: colors.textSecondary, fontVariant: ['tabular-nums'] as any },
  tdStrong: { fontFamily: fonts.bodySemibold, fontSize: 13, color: colors.text, fontVariant: ['tabular-nums'] as any },
  cMonth: { width: 74 },
  cIn: { width: 56 },
  cQual: { flex: 1, textAlign: 'center' },
  cPaid: { width: 74 },
  cPay: { width: 84, textAlign: 'right' },
  cellInput: { height: 34, borderRadius: 9, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, textAlign: 'center',
    fontFamily: fonts.bodySemibold, fontSize: 14, color: colors.text },

  // Rates + shared cards
  card: { borderRadius: 20, padding: 16, marginBottom: 12 },
  cardLabel: { fontFamily: fonts.mono, fontSize: 11, letterSpacing: 1.4, textTransform: 'uppercase', color: colors.textMuted, marginBottom: 6 },
  cardTitle: { fontFamily: fonts.display, fontSize: 17, color: colors.text, marginBottom: 12 },
  body: { fontFamily: fonts.body, fontSize: 14, lineHeight: 20, color: colors.text },
  note: { fontFamily: fonts.body, fontSize: 12, lineHeight: 17, color: colors.textMuted, marginTop: 10 },
  fieldRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  fieldLabel: { fontFamily: fonts.bodySemibold, fontSize: 14, color: colors.text },
  fieldHint: { fontFamily: fonts.body, fontSize: 12, lineHeight: 16.5, color: colors.textMuted, marginTop: 2 },
  guideValue: { fontFamily: fonts.monoSemibold, fontSize: 15, color: colors.text, minWidth: 64, textAlign: 'right' },
  smallInput: { width: 76, height: 42, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
    textAlign: 'center', fontFamily: fonts.monoSemibold, fontSize: 16, color: colors.text },
  prefix: { fontFamily: fonts.monoSemibold, fontSize: 15, color: colors.textSecondary, width: 14, textAlign: 'right' },
  suffix: { fontFamily: fonts.monoSemibold, fontSize: 13, color: colors.textSecondary, minWidth: 22 },
  rateGroup: { marginTop: 10, marginBottom: 8, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border },
  actions: { flexDirection: 'row', gap: 10, marginTop: 18 },
  primaryBtn: { flex: 1, alignItems: 'center', paddingVertical: 13, borderRadius: 14, backgroundColor: colors.ink },
  primaryBtnText: { fontFamily: fonts.bodyBold, fontSize: 15, color: colors.inkText },
  btnDisabled: { opacity: 0.45 },
  secondaryBtn: { alignItems: 'center', justifyContent: 'center', paddingVertical: 13, paddingHorizontal: 18, borderRadius: 14, borderWidth: 1, borderColor: colors.border },
  secondaryBtnText: { fontFamily: fonts.bodySemibold, fontSize: 15, color: colors.text },
  linkBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', marginTop: 12, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 10, borderWidth: 1, borderColor: colors.border },
  linkBtnText: { fontFamily: fonts.bodySemibold, fontSize: 13, color: colors.text },
});
