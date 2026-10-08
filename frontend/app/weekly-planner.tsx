import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, RefreshControl, Share, Platform, Modal, Pressable,
  KeyboardAvoidingView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { lightColors } from '../src/theme/ThemeContext';
import { Kicker } from '../src/components/ui/PillTabs';
import { useColors, fonts } from '../src/theme/ThemeContext';
import { BrandLoader } from '../src/components/ui/BrandLoader';
import { Aurora } from '../src/components/ui/Aurora';
import { Breathe } from '../src/components/ui/Breathe';
import PressableScale from '../src/components/ui/PressableScale';
import PlannerLoaReview from '../src/components/planner/PlannerLoaReview';
import PrimetimeDayBlock from '../src/components/planner/PrimetimeDayBlock';
import { planningTarget } from '../src/utils/officeDay';
import { useAuth } from '../src/auth/AuthContext';
import { apiService } from '../src/api/client';
import { showAlert } from '../src/utils/showAlert';
import { toast } from '../src/utils/toast';
import { invalidateGoalQueries } from '../src/utils/goalSync';
import { centerNotice } from '../src/utils/centerNotice';
import { useScrollGuard } from '../src/utils/scrollGuard';
import { usePullToRefresh } from '../src/components/ui/PullRefresh';
import { useTabBarClearance } from '../src/customization/CustomTabBar';
import { useKeyboardInset } from '../src/hooks/useKeyboardInset';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { APP_LOCALE } from '../src/utils/appTime';

// ──────────────────────────────────────────────────────────────────────────
// Leaders' Weekly Planner — the printed weekly-planner book + the WhatsApp
// weekly-plan report, in one place:
//   • Week tab  — wins, last week's numbers (auto from Bells), this week's
//     goals, crew, theme, meetings, 8-steps review, learnings, focus…
//   • Mon–Sat   — the paper book's day spreads (Networking / Sector /
//     Primetime / Crew Plan + Leaders Meeting / Morning Meeting boxes)
//   • Notes     — the extra-notes page
// Autosaves as you type. "Share" builds the WhatsApp-style text (empty
// sections are skipped so every leader keeps their own format).
// ──────────────────────────────────────────────────────────────────────────

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const EIGHT_STEPS = [
  'Attitude',
  'Time Management',
  'Preparation',
  '100% Effort',
  'Safeguarding Attitude',
  'Working Territory Effectively',
  'Know Your Why',
  'Taking Control',
];

// Step-by-step "Plan the week" wizard — one bite at a time so every part
// of the plan actually gets filled (goals, crew schedules & absences,
// meetings, self-review, focus).
const WIZARD_STEPS: { title: string; hint: string }[] = [
  { title: 'Review last week', hint: 'The numbers are pulled in for you — add your wins and what you learned.' },
  { title: "This week's goals", hint: 'Team & personal sign-up targets, P/A and scoring — they sync straight to Bells.' },
  { title: 'Crew schedules & goals', hint: 'Give every crew member a goal and mark any absences. Absences go to the office owner for approval.' },
  { title: 'Meetings & recruitment', hint: 'Plan the meetings, calls, education and recruitment goals for the week.' },
  { title: 'Self review', hint: '8 Steps, your own development, and who you are developing.' },
  { title: 'Focus & finish', hint: "Set this week's focuses and the bigger picture — then share the plan." },
];

// "Plan today" — what leaders plan in advance each day
const PLAN_FIELDS: { key: string; label: string; icon: any }[] = [
  { key: 'primetime', label: 'Primetime', icon: 'flash-outline' },
  { key: 'sector', label: 'Sector', icon: 'map-outline' },
  { key: 'networking', label: 'Networking', icon: 'people-outline' },
  { key: 'crew_plan', label: 'Crew Meetings', icon: 'rocket-outline' },
];
// "Notes" — what they write down as the day happens
const NOTE_FIELDS: { key: string; label: string; icon: any }[] = [
  { key: 'leaders_meeting', label: 'Coaches Meeting', icon: 'star-outline' },
  { key: 'morning_news', label: 'Morning Meeting · News', icon: 'newspaper-outline' },
  { key: 'morning_topic', label: 'Morning Meeting · Topic', icon: 'bulb-outline' },
  { key: 'morning_cs', label: 'Morning Meeting · Customer Service', icon: 'heart-outline' },
  { key: 'morning_bells', label: 'Morning Meeting · Bells', icon: 'notifications-outline' },
];

type DevRow = { id: string; who: string; what: string };
type Review = {
  focus_mid: string;
  focus_long: string;
  wins: string[];
  owners_profit: string;
  team_quality: { silver: string; gold: string; zero: string; fails: string };
  personal: { loas: string; scoring_focus: string; silver: string; gold: string; zero: string; fails: string };
  next_goals: { sales: string; leaders: string; piece_avg: string; scoring: string };
  theme: string;
  concentration: string;
  headcount: string;
  recruitment: { booked_in: string; attended: string; newstarts: string; focus: string };
  eight_steps: { scores: Record<string, number>; focus: string };
  learnings: string[];
  personal_development: { cod: string; goal: string };
  team_management: { meetings: string; team_call: string; one_on_one: string; education: string; social: string };
  developing: DevRow[];
  focus_next_week: string[];
  motto: string;
};
type Planner = {
  id: string; user_id: string; office_id: string; week_ending: string;
  review: Review; days: Record<string, Record<string, string>>; notes: string;
};

function makeId(): string { return Math.random().toString(36).slice(2, 11); }
// The week being PLANNED now comes from planningTarget() in utils/officeDay —
// same rule as before (on Sunday it rolls to next week, since Sunday is
// wrap-up/planning day) plus the 6pm rollover, and read in app time
// rather than whatever timezone the phone happens to be set to.
function addDaysISO(iso: string, n: number): string {
  const [y, m, dd] = iso.split('-').map(Number);
  const d = new Date(y, m - 1, dd);
  d.setDate(d.getDate() + n);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const ddd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${ddd}`;
}
function shortDate(iso: string): string {
  if (!iso) return '';
  const [y, m, dd] = iso.split('-').map(Number);
  if (!y || !m || !dd) return iso;
  return new Date(y, m - 1, dd).toLocaleDateString(APP_LOCALE, { month: 'short', day: 'numeric' });
}
function fullDate(iso: string): string {
  if (!iso) return '';
  const [y, m, dd] = iso.split('-').map(Number);
  if (!y || !m || !dd) return iso;
  return new Date(y, m - 1, dd).toLocaleDateString(APP_LOCALE, { weekday: 'short', month: 'short', day: 'numeric' });
}
// The week we're actually IN (its Sunday, today included)
function currentSundayInclusive(): string {
  const d = new Date();
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
// "THIS WEEK" / "NEXT WEEK" / "2 WEEKS AGO" — so nobody plans the wrong week
function weekRelative(week: string): { label: string; tone: 'now' | 'future' | 'past' } {
  const cur = currentSundayInclusive();
  const [y1, m1, d1] = cur.split('-').map(Number);
  const [y2, m2, d2] = week.split('-').map(Number);
  const diff = Math.round((new Date(y2, m2 - 1, d2).getTime() - new Date(y1, m1 - 1, d1).getTime()) / (7 * 24 * 3600 * 1000));
  if (diff === 0) return { label: 'This week', tone: 'now' };
  if (diff === 1) return { label: 'Next week', tone: 'future' };
  if (diff === -1) return { label: 'Last week', tone: 'past' };
  return diff > 0 ? { label: `In ${diff} weeks`, tone: 'future' } : { label: `${-diff} weeks ago`, tone: 'past' };
}
// Monday of the week whose Sunday is `week` = week - 6 + dayIdx
const dayDate = (week: string, dayIdx: number) => addDaysISO(week, dayIdx - 6);

const fmt = (v: number | null | undefined, suffix = '') =>
  v === null || v === undefined ? '—' : `${v}${suffix}`;

// "M-S", "M-F", or "M·W·F" from Mon..Sat statuses
function daysLabel(statuses?: string[]): string {
  const L = ['M', 'Tu', 'W', 'Th', 'F', 'Sa'];
  const on = (statuses || []).map((s, i) => (s === 'ab' ? -1 : i)).filter((i) => i >= 0);
  if (!on.length) return '';
  if (on.length > 1 && on.length === on[on.length - 1] - on[0] + 1) return `${L[on[0]]}-${L[on[on.length - 1]]}`;
  return on.map((i) => L[i]).join('·');
}

// ── WhatsApp-style export — skips empty sections ──────────────────────────
function buildShareText(p: Planner, stats: any, name: string, teamName: string): string {
  const r = p.review;
  const S: string[] = [];
  const sep = '⸻';
  const bullets = (items: string[]) => items.map((x) => `• ${x}`).join('\n');

  S.push(`🏃 ${(teamName || name || 'Weekly Plan').toUpperCase()}`);
  S.push(`📅 Week ending ${shortDate(p.week_ending)}`);

  if (r.wins.length) S.push(sep, '🚀 WINS', bullets(r.wins));

  const t = stats?.team;
  const pe = stats?.personal;
  const qk = stats?.quality;
  if (t) {
    const lines = [
      `🎯 Goal: ${fmt(t.goal)}`,
      `✅ Hit: ${fmt(t.total)}`,
      `📈 P/A: ${fmt(t.piece_avg)}`,
      `📉 Scoring: ${fmt(t.scoring_pct, '%')}`,
    ];
    if (r.owners_profit) lines.push(`💰 Owner's Profit: ${r.owners_profit}`);
    if (qk && (qk.gold_pct != null || qk.mem_pct != null)) {
      let qline = `🥇 Gold: ${fmt(qk.gold_pct, '%')} · ⭕️ Memberships: ${fmt(qk.mem_pct, '%')}`;
      if (qk.fails_pct != null) qline += ` · Fails: ${qk.fails_pct}%`;
      lines.push(qline);
    }
    if (qk?.second_delivery?.pct != null || qk?.fourth_delivery?.pct != null) {
      lines.push(`📦 2nd delivery: ${fmt(qk?.second_delivery?.pct, '%')} · 4th delivery: ${fmt(qk?.fourth_delivery?.pct, '%')}`);
    }
    S.push(sep, '📊 PERFORMANCE BREAKDOWN', lines.join('\n'));
  }

  if (pe && (pe.total || pe.days_worked)) {
    const dailyAvg = pe.days_worked ? Math.round((pe.total / pe.days_worked) * 10) / 10 : null;
    const lines = [
      `Goal: ${fmt(pe.goal)} · Hit: ${fmt(pe.total)}`,
      `Daily average: ${fmt(dailyAvg)}`,
      `Scoring: ${fmt(pe.scoring_pct, '%')}`,
    ];
    if (r.personal.loas) lines.push(`LOAs per sign-up: ${r.personal.loas}`);
    S.push(sep, "📊 PERSONAL KPI'S", lines.join('\n'));
  }

  const g = r.next_goals;
  const gl = stats?.goals;
  if (gl?.team != null || gl?.personal != null || g.piece_avg || g.scoring) {
    const lines: string[] = [];
    if (gl?.team != null) lines.push(`• Team sign-ups: ${gl.team}`);
    if (gl?.personal != null) lines.push(`• Personal sign-ups: ${gl.personal}`);
    if (g.piece_avg) lines.push(`• P/A: ${g.piece_avg}`);
    if (g.scoring) lines.push(`• Scoring: ${g.scoring}`);
    S.push(sep, "🎯 THIS WEEK'S GOALS", lines.join('\n'));
  }

  // Crew section shows the PLANNING week: schedules + goals being set now.
  const crew = (stats?.crew || []) as any[];
  const hc = stats?.headcount;
  if (crew.length || r.headcount || hc?.total) {
    const lines: string[] = crew.map((m) => {
      const lbl = daysLabel(m.day_statuses);
      return `• ${m.name}${lbl ? ` (${lbl})` : ''}${m.goal != null ? ` — Goal: ${m.goal}` : ''}`;
    });
    if (hc?.total) lines.push(`Headcount: ${hc.total} — COD1: ${hc.cod1} · COD2: ${hc.cod2} · COD3: ${hc.cod3} · COD3+: ${hc.cod3p}`);
    if (r.headcount) lines.push(r.headcount);
    S.push(sep, '👥 CREW', lines.join('\n'));
    const hr = (t?.highrollers || []) as any[];
    if (hr.length) {
      const medals = ['🥇', '🥈', '🥉'];
      S.push('🏆 Highrollers (last week)', hr.map((h, i) => `${medals[i] || '•'} ${h.name} — ${h.total}`).join('\n'));
    }
  }

  if (r.theme || r.concentration) {
    const lines: string[] = [];
    if (r.theme) lines.push(`💡 Theme: ${r.theme}`);
    if (r.concentration) lines.push(`🧠 Concentration: ${r.concentration}`);
    S.push(sep, lines.join('\n'));
  }

  const tm = r.team_management;
  if (tm.meetings || tm.team_call || tm.one_on_one || tm.education || tm.social) {
    const lines: string[] = [];
    if (tm.meetings) lines.push(`📅 Meetings: ${tm.meetings}`);
    if (tm.team_call) lines.push(`📞 Team call: ${tm.team_call}`);
    if (tm.one_on_one) lines.push(`🤝 1-on-1: ${tm.one_on_one}`);
    if (tm.education) lines.push(`📚 Team education: ${tm.education}`);
    if (tm.social) lines.push(`🍽️ Social: ${tm.social}`);
    S.push(sep, '🤝 TEAM COACHING', lines.join('\n'));
  }

  if (r.developing.length) {
    S.push(sep, '🌱 WHO AM I DEVELOPING', r.developing.map((d) => `• ${d.who}${d.what ? ` — ${d.what}` : ''}`).join('\n'));
  }

  const rec = r.recruitment;
  if (rec.booked_in || rec.attended || rec.newstarts || rec.focus) {
    const lines: string[] = [];
    if (rec.booked_in) lines.push(`• Booked-in goal: ${rec.booked_in}`);
    if (rec.attended) lines.push(`• Attending goal: ${rec.attended}`);
    if (rec.newstarts) lines.push(`• New starts goal: ${rec.newstarts}`);
    if (rec.focus) lines.push(`🎯 Focus goal: ${rec.focus}`);
    S.push(sep, '🧑‍💼 RECRUITMENT GOALS', lines.join('\n'));
  }

  const scores = r.eight_steps.scores || {};
  if (EIGHT_STEPS.some((s) => (scores[s] || 0) > 0)) {
    const lines = EIGHT_STEPS.filter((s) => (scores[s] || 0) > 0)
      .map((s) => `${s} ${'⭐️'.repeat(scores[s] || 0)}`);
    if (r.eight_steps.focus) lines.push(`➡️ Focus: ${r.eight_steps.focus}`);
    S.push(sep, '🧩 8 STEPS REVIEW (Personal)', lines.join('\n'));
  }

  if (r.learnings.length) S.push(sep, '🧠 WHAT DID I LEARN?', bullets(r.learnings));

  const pd = r.personal_development;
  if (pd.cod || pd.goal) {
    const lines: string[] = [];
    if (pd.cod) lines.push(`• COD: ${pd.cod}`);
    if (pd.goal) lines.push(`• Goal: ${pd.goal}`);
    S.push(sep, '💪 PERSONAL DEVELOPMENT', lines.join('\n'));
  }

  if (r.focus_next_week.length || r.focus_mid || r.focus_long) {
    const lines: string[] = r.focus_next_week.map((x) => `• ${x}`);
    if (r.focus_mid) lines.push(`Mid-term: ${r.focus_mid}`);
    if (r.focus_long) lines.push(`Long-term: ${r.focus_long}`);
    S.push(sep, '🎯 GOALS', lines.join('\n'));
  }

  return S.join('\n');
}

// Themed styles for the sub-components below — without this they'd fall
// back to the static light-mode stylesheet and glow in dark mode.
function useStyles() {
  const c = useColors();
  return useMemo(() => createStyles(c), [c]);
}

// ──────────────────────────────────────────────────────────────────────────
export default function WeeklyPlannerScreen() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  // Taps during scroll/momentum must stop the scroll, not focus a note field.
  const { scrollProps, contentProps } = useScrollGuard();
  const tabBarClearance = useTabBarClearance();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{ user_id?: string; day?: string; week?: string }>();
  const targetUserId = typeof params.user_id === 'string' && params.user_id ? params.user_id : undefined;

  // The day the office is planning right now, read in app time and rolled
  // forward after 6pm — from then on the working day is done and what everyone
  // wants to set up is tomorrow. Saturday evening lands on Monday, which is why
  // this carries its own week rather than just a weekday index.
  const planTarget = planningTarget();

  // ?week=YYYY-MM-DD (e.g. from Team Planners' week scroller) opens that week.
  const [week, setWeek] = useState<string>(() => {
    const w = typeof params.week === 'string' ? params.week : '';
    return /^\d{4}-\d{2}-\d{2}$/.test(w) ? w : planTarget.weekEnding;
  });
  // ?day=0..5 (e.g. from the Home hero) opens straight onto that day's page;
  // otherwise open on the day being planned, so after 6pm you land on
  // tomorrow ready to fill it in.
  const [tab, setTab] = useState<'week' | number | 'notes'>(() => {
    const d = parseInt(String(params.day ?? ''), 10);
    if (Number.isFinite(d) && d >= 0 && d <= 5) return d;
    if (targetUserId) return 'week';
    return planTarget.dayIndex;
  });
  // Step-by-step "Plan the week" wizard — null = classic list view,
  // 0..5 = the active step. Same data & autosave, just guided.
  const [wizard, setWizard] = useState<number | null>(null);

  const q = useQuery({
    queryKey: ['weekly-planner', week, targetUserId || 'me'],
    queryFn: () => apiService.getWeeklyPlanner(week, targetUserId).then((r) => r.data),
  });

  // Role of the person whose plan this is (not necessarily the viewer — a
  // leader can open a trainee's plan read-only). Trainees get the daily
  // plan only, no Week/review/crew tab. Before the doc loads, fall back to
  // the viewer's own role for the common "my own plan" case so there's no
  // flash of the wrong layout.
  const viewingRole = q.data?.target?.role ?? (!targetUserId ? user?.role : undefined);
  const showWeekTab = viewingRole !== 'trainee';
  // Trainees have no crew yet — drop the "Crew Meetings" plan-today box.
  const planFields = viewingRole === 'trainee' ? PLAN_FIELDS.filter((f) => f.key !== 'crew_plan') : PLAN_FIELDS;

  const statsQ = useQuery({
    queryKey: ['weekly-planner-stats', week, targetUserId || 'me'],
    queryFn: () => apiService.weeklyPlannerStats(week, targetUserId).then((r) => r.data),
    staleTime: 1000 * 60,
    enabled: showWeekTab,
  });

  // Safety net: if we guessed 'week' before the doc loaded but the target
  // turns out to be a trainee (e.g. a leader opening a trainee's plan via
  // ?user_id=), correct onto a real tab instead of showing an empty Week page.
  useEffect(() => {
    if (!showWeekTab && tab === 'week') {
      const wd = (new Date().getDay() + 6) % 7;
      setTab(wd <= 5 ? wd : 'notes');
    }
  }, [showWeekTab]);

  const canEdit = !!q.data?.can_edit;
  const targetName = q.data?.target?.name || user?.name || '';
  const teamName = q.data?.target?.team_name || '';

  const [draft, setDraft] = useState<Planner | null>(null);
  const [savingState, setSavingState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const debounceRef = useRef<any>(null);
  const loadedKeyRef = useRef<string>('');

  useEffect(() => {
    if (!q.data) return;
    const key = `${q.data.week_ending}|${targetUserId || 'me'}`;
    setDraft((cur) => {
      // While EDITING, only (re)seed the draft when the week/person actually
      // changes. Autosave responses must never clobber what's being typed —
      // the server strips empty bullet rows, so re-seeding used to make a
      // just-added "+ Add" row vanish right as you started typing in it.
      if (q.data.can_edit && loadedKeyRef.current === key && cur) return cur;
      loadedKeyRef.current = key;
      return q.data.planner || null;
    });
  }, [q.data, targetUserId]);

  const saveMut = useMutation({
    mutationFn: (p: Planner) =>
      apiService.upsertWeeklyPlanner(p.week_ending, { review: p.review, days: p.days, notes: p.notes }).then((r) => r.data),
    onMutate: () => setSavingState('saving'),
    onSuccess: (data: Planner) => {
      setSavingState('saved');
      queryClient.setQueryData(['weekly-planner', week, targetUserId || 'me'], (prev: any) =>
        prev ? { ...prev, exists: true, planner: data } : prev);
      setDraft((d) => (d && (!d.id || d.id !== data.id) ? { ...d, id: data.id } : d));
      setTimeout(() => setSavingState((s) => (s === 'saved' ? 'idle' : s)), 1500);
    },
    onError: () => setSavingState('error'),
  });

  const scheduleSave = useCallback((next: Planner) => {
    if (!canEdit) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => saveMut.mutate(next), 1200);
  }, [canEdit, saveMut]);

  const update = (mutator: (cur: Planner) => Planner) => {
    setDraft((cur) => {
      if (!cur) return cur;
      const next = mutator(cur);
      scheduleSave(next);
      return next;
    });
  };
  const setReview = (patch: Partial<Review>) => update((c) => ({ ...c, review: { ...c.review, ...patch } }));
  const setDayField = (day: number, key: string, v: string) =>
    update((c) => ({ ...c, days: { ...c.days, [String(day)]: { ...(c.days[String(day)] || {}), [key]: v } } }));

  // Near-full-screen note editor — which box is open (null = closed).
  const [editorField, setEditorField] = useState<null | { where: 'day' | 'notes'; tab?: number; key?: string; title: string }>(null);
  const editorValue = !editorField ? ''
    : editorField.where === 'notes' ? (draft?.notes || '')
    : (draft?.days[String(editorField.tab)]?.[editorField.key!] || '');
  const setEditorValue = (v: string) => {
    if (!editorField) return;
    if (editorField.where === 'notes') update((c) => ({ ...c, notes: v }));
    else setDayField(editorField.tab!, editorField.key!, v);
  };
  const kbInset = useKeyboardInset();
  const safeInsets = useSafeAreaInsets();

  const onShare = async () => {
    if (!draft) return;
    const text = buildShareText(draft, statsQ.data, targetName, teamName);
    if (Platform.OS === 'web') {
      try {
        await (navigator as any).clipboard.writeText(text);
        toast.success('Copied — paste it into WhatsApp');
      } catch {
        showAlert('Weekly plan', text);
      }
    } else {
      try { await Share.share({ message: text }); } catch {}
    }
  };

  // ── Photo → text import (Gemini OCR; image itself is never stored) ─────
  const [scanningField, setScanningField] = useState<string | null>(null);
  const runNotesScan = async (uri: string, day: number, field: string) => {
    setScanningField(field);
    try {
      const r = await apiService.scanWeeklyNotes({ uri, name: 'notes.jpg', type: 'image/jpeg' });
      const text = (r.data?.text || '').trim();
      if (!text) {
        showAlert('Nothing found', 'The photo didn\'t contain readable text. Try a closer, better-lit shot.');
        return;
      }
      update((c) => {
        const cur = c.days[String(day)]?.[field] || '';
        return {
          ...c,
          days: { ...c.days, [String(day)]: { ...(c.days[String(day)] || {}), [field]: cur ? `${cur}\n${text}` : text } },
        };
      });
      toast.success('Notes imported');
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e?.message || 'Scan failed';
      showAlert('Scan failed', String(msg));
    } finally {
      setScanningField(null);
    }
  };
  const onScanInto = (day: number, field: string) => {
    if (!canEdit) return;
    showAlert(
      'Import notes from photo',
      'Snap your handwritten notes — the text is transcribed into this box. The photo itself is not stored.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Take Photo', onPress: async () => {
          const perm = await ImagePicker.requestCameraPermissionsAsync();
          if (!perm.granted) { showAlert('Permission needed', 'Please allow camera access to take a photo.'); return; }
          const res = await ImagePicker.launchCameraAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.85 });
          if (!res.canceled && res.assets?.[0]?.uri) await runNotesScan(res.assets[0].uri, day, field);
        } },
        { text: 'Choose from Library', onPress: async () => {
          const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
          if (!perm.granted) { showAlert('Permission needed', 'Please allow photo access to pick an image.'); return; }
          const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.85 });
          if (!res.canceled && res.assets?.[0]?.uri) await runNotesScan(res.assets[0].uri, day, field);
        } },
      ],
    );
  };

  // ── Crew plan editor — tap a name to set schedule + weekly goal ────────
  // day_statuses = what's on Bells (approved). pending_request = absence
  // days the leader has requested that the office owner hasn't decided yet.
  const [crewEdit, setCrewEdit] = useState<{
    user_id: string; name: string; goal: any; day_statuses: string[];
    pending_request?: { id: string; day_indices: number[]; reason: string } | null;
    last_decision?: { status: string; day_indices: number[]; decision_note?: string; decided_by_name?: string } | null;
  } | null>(null);
  const [crewGoal, setCrewGoal] = useState('');
  const [crewDays, setCrewDays] = useState<string[]>([]);
  const [crewReason, setCrewReason] = useState('');
  useEffect(() => {
    if (crewEdit) {
      setCrewGoal(crewEdit.goal != null ? String(crewEdit.goal) : '');
      // Displayed selection = approved Ab (on Bells) + still-pending Ab days.
      const base = [...(crewEdit.day_statuses || ['off', 'off', 'off', 'off', 'off', 'off'])];
      for (const i of crewEdit.pending_request?.day_indices || []) {
        if (i >= 0 && i <= 5) base[i] = 'ab';
      }
      setCrewDays(base);
      setCrewReason(crewEdit.pending_request?.reason || '');
    }
  }, [crewEdit]);
  const isAdmin = user?.role === 'admin';
  // The goals card describes the PLAN OWNER's goal, so its wording follows
  // their role — an admin opening a team leader's plan must see "Team sales",
  // not "Office sales" (only an admin's own crew goal drives the office goal).
  const planForAdmin = viewingRole === 'admin';
  // After Monday 10:30 AM (app time) of the planning week, leaders can no longer
  // change goals or clear approved absences (server-enforced) — but they
  // can STILL request new absences; those need the owner's approval anyway.
  const crewLocked = !!statsQ.data?.crew_locked && !isAdmin;
  const canCrewEdit = canEdit;
  // Which selected Ab days are new requests (not yet on Bells)?
  const approvedAb = (i: number) => crewEdit?.day_statuses?.[i] === 'ab';
  const pendingSelection = crewDays.some((s, i) => s === 'ab' && !approvedAb(i));
  // A reason is mandatory whenever a NEW absence is being requested — the
  // owner approves or denies off the back of it. Admins write AB directly and
  // don't need one.
  const crewReasonOk = isAdmin || !pendingSelection || crewReason.trim().length >= 3;
  const crewMut = useMutation({
    mutationFn: () => apiService.setCrewMemberPlan(crewEdit!.user_id, {
      week_ending: week,
      weekly_goal: crewGoal.trim() === '' ? null : crewGoal.trim(),
      day_statuses: crewDays,
      absence_reason: crewReason.trim(),
    }).then((r) => r.data),
    onSuccess: (data: any) => {
      invalidateGoalQueries(queryClient);
      if (data?.pending_request && !isAdmin) {
        centerNotice.success('Absence requested', 'The office owner has been notified and will approve or deny it.');
      } else {
        toast.success('Saved');
      }
      setCrewEdit(null);
    },
    onError: (e: any) => showAlert('Could not save', e?.response?.data?.detail || 'Try again'),
  });

  // ── This week's sales goals — synced with the leader's own Bells row ───
  const [goalPersonal, setGoalPersonal] = useState('');
  const [goalTeam, setGoalTeam] = useState('');
  const goalsSeedRef = useRef('');
  const goalsTimer = useRef<any>(null);
  useEffect(() => {
    const g: any = statsQ.data;
    if (!g) return;
    const key = `${g.week_ending}|${targetUserId || 'me'}`;
    if (goalsSeedRef.current === key) return;
    goalsSeedRef.current = key;
    setGoalPersonal(g.goals?.personal != null ? String(g.goals.personal) : '');
    setGoalTeam(g.goals?.team != null ? String(g.goals.team) : '');
  }, [statsQ.data, targetUserId]);
  // Only the fields actually edited since the last flush get sent. Posting
  // both every time meant a personal-goal keystroke rewrote team_weekly_goal
  // with whatever was seeded when the screen opened — silently reverting a
  // crew goal changed since from Bells, the crew table, or by an admin.
  const pendingGoals = useRef<{ personal_goal?: string; team_goal?: string }>({});
  const goalsMut = useMutation({
    mutationFn: (patch: { personal_goal?: string; team_goal?: string }) =>
      apiService.setMyPlannerGoals({ week_ending: week, ...patch }).then((r) => r.data),
    onSuccess: (saved) => {
      // The server is authoritative. Adopt what it stored so a goal changed
      // elsewhere shows up here — but never yank the boxes out from under
      // someone still typing.
      if (saved && !Object.keys(pendingGoals.current).length) {
        setGoalPersonal(saved.personal_goal != null ? String(saved.personal_goal) : '');
        setGoalTeam(saved.team_goal != null ? String(saved.team_goal) : '');
      }
      invalidateGoalQueries(queryClient);
    },
  });
  const onGoalChange = (which: 'personal' | 'team', v: string) => {
    if (!canEdit) return;
    if (which === 'personal') setGoalPersonal(v); else setGoalTeam(v);
    // Accumulate rather than overwrite: editing both boxes inside the debounce
    // window must still save both.
    pendingGoals.current[which === 'personal' ? 'personal_goal' : 'team_goal'] = v;
    if (goalsTimer.current) clearTimeout(goalsTimer.current);
    goalsTimer.current = setTimeout(() => {
      const patch = pendingGoals.current;
      pendingGoals.current = {};
      if (Object.keys(patch).length) goalsMut.mutate(patch);
    }, 900);
  };

  // ── Notes search (iCloud-Notes style, across every week) ───────────────
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const searchQ = useQuery({
    queryKey: ['weekly-planner-search', searchTerm.trim(), targetUserId || 'me'],
    queryFn: () => apiService.searchWeeklyPlanners(searchTerm.trim(), targetUserId).then((r) => r.data),
    enabled: searchOpen && searchTerm.trim().length >= 2,
    staleTime: 1000 * 30,
  });
  // Web pull-to-refresh (react-native-web's RefreshControl is a no-op).
  const { pullIndicator } = usePullToRefresh(() => { q.refetch(); statsQ.refetch(); });

  const openSearchResult = (res: any) => {
    setWeek(res.week_ending);
    setTab(res.where === 'day' ? res.day : res.where === 'notes' ? 'notes' : 'week');
    setSearchOpen(false);
    setSearchTerm('');
  };

  if (q.isLoading || (!draft && q.data?.exists !== false)) {
    return (
      <View style={styles.center}>
        <BrandLoader size={48} />
      </View>
    );
  }

  // Upline viewing a week the leader hasn't created yet
  if (!draft) {
    return (
      <View style={{ flex: 1 }}>
        <WeekHeader week={week} setWeek={setWeek} savingState={'idle'} onShare={null} />
        <View style={[styles.center, { paddingHorizontal: 32 }]}>
          <Ionicons name="calendar-clear-outline" size={36} color={colors.textMuted} />
          <Text style={styles.emptyTitle}>No planner for this week</Text>
          <Text style={styles.emptyText}>{targetName || 'This coach'} hasn't started a plan for the week ending {shortDate(week)} yet.</Text>
        </View>
      </View>
    );
  }

  const r = draft.review;

  // Wizard plumbing: which sections show (all of them in classic list view,
  // one step's worth in wizard mode) + per-step completion for the nudges.
  const wizStep = (i: number) => wizard === null || wizard === i;
  const crewList = (statsQ.data?.crew || []) as any[];
  const stepDone: boolean[] = [
    r.wins.length > 0,
    goalTeam.trim() !== '' && goalPersonal.trim() !== '',
    crewList.length > 0 && crewList.every((m) => m.goal != null),
    r.team_management.meetings.trim() !== '',
    Object.values(r.eight_steps.scores || {}).some((v) => (v || 0) > 0),
    r.focus_next_week.length > 0,
  ];
  const wizDoneCount = stepDone.filter(Boolean).length;

  return (
    <View style={{ flex: 1 }}>
      {pullIndicator}
      <ScrollView
        contentContainerStyle={{ padding: 12, paddingBottom: 120 + tabBarClearance }}
        refreshControl={<RefreshControl refreshing={q.isFetching} onRefresh={() => { q.refetch(); statsQ.refetch(); }} tintColor={colors.primary} />}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        automaticallyAdjustKeyboardInsets
        {...scrollProps}
      >
        {/* Guard wrapper: while scrolling, taps land here (stopping the scroll)
            instead of focusing whatever input happens to be under the finger. */}
        <View {...contentProps} style={styles.shell}>
        <WeekHeader
          week={week} setWeek={setWeek} savingState={savingState} onShare={onShare}
          onToggleSearch={() => { setSearchOpen((s) => !s); setSearchTerm(''); }} searchOpen={searchOpen}
          title={showWeekTab ? 'Weekly Planner' : 'Daily Planner'}
        />

        {!canEdit && (
          <View style={styles.roBanner}>
            <Ionicons name="eye-outline" size={14} color="#0c4a6e" />
            <Text style={styles.roBannerText}>Viewing {targetName}'s planner — read-only</Text>
          </View>
        )}

        {/* Search across every week's notes */}
        {searchOpen && (
          <View style={styles.searchBar}>
            <Ionicons name="search" size={15} color={colors.textMuted} />
            <TextInput
              value={searchTerm}
              onChangeText={setSearchTerm}
              style={styles.searchInput}
              placeholder="Search every week's notes…"
              placeholderTextColor={colors.textMuted}
              autoFocus
            />
            {!!searchTerm && (
              <TouchableOpacity onPress={() => setSearchTerm('')} hitSlop={8}>
                <Ionicons name="close-circle" size={16} color={colors.textMuted} />
              </TouchableOpacity>
            )}
          </View>
        )}
        {searchOpen && searchTerm.trim().length >= 2 && (
          <View style={{ marginBottom: 12 }}>
            {searchQ.isLoading ? (
              <ActivityIndicator color={colors.primary} style={{ marginVertical: 20 }} />
            ) : (searchQ.data?.results || []).length === 0 ? (
              <Text style={[styles.mutedText, { textAlign: 'center', paddingVertical: 20 }]}>
                No notes matching “{searchTerm.trim()}”
              </Text>
            ) : (
              (searchQ.data.results as any[]).map((res, i) => (
                <TouchableOpacity key={i} style={styles.searchResult} onPress={() => openSearchResult(res)}>
                  <Text style={styles.searchResultTitle} numberOfLines={1}>
                    {res.label} · WE {shortDate(res.week_ending)}
                  </Text>
                  <Text style={styles.searchResultSnippet} numberOfLines={2}>{res.snippet}</Text>
                </TouchableOpacity>
              ))
            )}
          </View>
        )}

        {/* Tab chips: Week | Mon..Sat | Notes — Week only for leaders/admins.
            Hidden while the step-by-step wizard is driving. */}
        {wizard === null && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabRow}>
          {showWeekTab && (
            <PressableScale style={[styles.tabChip, tab === 'week' && styles.tabChipActive]} onPress={() => setTab('week')}>
              <Text style={[styles.tabChipText, tab === 'week' && styles.tabChipTextActive]}>Week</Text>
            </PressableScale>
          )}
          {DAY_LABELS.map((d, i) => (
            <PressableScale key={d} style={[styles.tabChip, tab === i && styles.tabChipActive]} onPress={() => setTab(i)}>
              <Text style={[styles.tabChipText, tab === i && styles.tabChipTextActive]}>{d}</Text>
            </PressableScale>
          ))}
          <PressableScale style={[styles.tabChip, tab === 'notes' && styles.tabChipActive]} onPress={() => setTab('notes')}>
            <Text style={[styles.tabChipText, tab === 'notes' && styles.tabChipTextActive]}>Notes</Text>
          </PressableScale>
        </ScrollView>
        )}

        {(tab === 'week' || wizard !== null) && (
          <>
            {wizard === null && canEdit && weekRelative(week).tone !== 'past' && (
              <Breathe>
              <PressableScale
                style={styles.wizCta}
                onPress={() => { const first = stepDone.findIndex((d) => !d); setWizard(first === -1 ? 0 : first); }}
                testID="wizard-cta"
              >
                <Aurora />
                <View style={styles.wizCtaIcon}><Ionicons name="sparkles" size={18} color={colors.onPrimary} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.wizCtaTitle}>
                    {wizDoneCount === 0 ? 'Plan your week — step by step'
                      : wizDoneCount >= 6 ? 'Week fully planned 💪'
                      : `Continue planning — ${wizDoneCount}/6 steps done`}
                  </Text>
                  <Text style={styles.wizCtaSub}>
                    {wizDoneCount >= 6 ? 'Revisit any step or share the plan' : 'Goals · crew schedules & absences · meetings · focus'}
                  </Text>
                </View>
                <View style={styles.wizCtaProgress}><Text style={styles.wizCtaProgressText}>{wizDoneCount}/6</Text></View>
              </PressableScale>
              </Breathe>
            )}
            {wizard !== null && (
              <>
                <View style={styles.wizHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.wizStepNum}>STEP {wizard + 1} OF 6</Text>
                    <Text style={styles.wizTitle}>{WIZARD_STEPS[wizard].title}</Text>
                    <Text style={styles.wizHint}>{WIZARD_STEPS[wizard].hint}</Text>
                  </View>
                  <TouchableOpacity onPress={() => setWizard(null)} style={styles.wizClose} hitSlop={8}>
                    <Ionicons name="close" size={20} color={colors.textMuted} />
                  </TouchableOpacity>
                </View>
                <View style={styles.wizProgressRow}>
                  {WIZARD_STEPS.map((_, i) => (
                    <TouchableOpacity key={i} style={{ flex: 1, paddingVertical: 6 }} onPress={() => setWizard(i)} hitSlop={4}>
                      <View style={[styles.wizSeg, stepDone[i] && styles.wizSegDone, wizard === i && styles.wizSegActive]} />
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            )}
            {wizStep(0) && (
              <>
            {/* 🚀 Wins */}
            <Card icon="rocket-outline" title="Wins">
              <Bullets items={r.wins} editable={canEdit} placeholder="A win from last week — big or small"
                onChange={(v) => setReview({ wins: v })} />
            </Card>

            
            {/* 📊 Review — the week just gone (planner for WE 19th reviews WE 12th) */}
            <Card
              icon="speedometer-outline"
              title={`Review — week ending ${shortDate(statsQ.data?.review_week_ending || addDaysISO(week, -7))}`}
            >
              {statsQ.isLoading ? (
                <ActivityIndicator color={colors.primary} />
              ) : statsQ.data ? (
                <>
                  <Text style={styles.subHead}>Crew</Text>
                  <View style={styles.statChips}>
                    <StatChip label="Goal" value={fmt(statsQ.data.team?.goal)} />
                    <StatChip label="Hit" value={fmt(statsQ.data.team?.total)} />
                    <StatChip label="P/A" value={fmt(statsQ.data.team?.piece_avg)} />
                    <StatChip label="Scoring" value={fmt(statsQ.data.team?.scoring_pct, '%')} />
                    <StatChip label="BA days" value={fmt(statsQ.data.team?.ba_days)} />
                  </View>
                  <Text style={styles.subHead}>Personal</Text>
                  <View style={styles.statChips}>
                    <StatChip label="Goal" value={fmt(statsQ.data.personal?.goal)} />
                    <StatChip label="Hit" value={fmt(statsQ.data.personal?.total)} />
                    <StatChip label="P/A" value={fmt(statsQ.data.personal?.piece_avg)} />
                    <StatChip label="Scoring" value={fmt(statsQ.data.personal?.scoring_pct, '%')} />
                  </View>
                </>
              ) : (
                <Text style={styles.mutedText}>No bells data for this week yet.</Text>
              )}
              {/* Quality KPIs — auto-derived: Quality report when synced,
                  bells (over-30 = gold, memberships column) until then.
                  Delivery retention uses closed weeks (2 / 4 weeks back). */}
              {!!statsQ.data?.quality?.source && (
                <>
                  <Text style={styles.subHead}>
                    Quality — crew{statsQ.data.quality.source === 'bells' ? ' · from Bells (Quality report pending)' : ''}
                  </Text>
                  <View style={styles.statChips}>
                    <StatChip label="🥇 Gold" value={fmt(statsQ.data.quality.gold_pct, '%')} />
                    <StatChip label="⭕️ Members" value={fmt(statsQ.data.quality.mem_pct, '%')} />
                    {statsQ.data.quality.fails_pct != null && (
                      <StatChip label="Fails" value={fmt(statsQ.data.quality.fails_pct, '%')} />
                    )}
                  </View>
                </>
              )}
              {(statsQ.data?.quality?.second_delivery || statsQ.data?.quality?.fourth_delivery) && (
                <View style={styles.statChips}>
                  {statsQ.data.quality.second_delivery && (
                    <StatChip
                      label={`2nd deliv · WE ${shortDate(statsQ.data.quality.second_delivery.week_ending)}`}
                      value={fmt(statsQ.data.quality.second_delivery.pct, '%')}
                    />
                  )}
                  {statsQ.data.quality.fourth_delivery && (
                    <StatChip
                      label={`4th deliv · WE ${shortDate(statsQ.data.quality.fourth_delivery.week_ending)}`}
                      value={fmt(statsQ.data.quality.fourth_delivery.pct, '%')}
                    />
                  )}
                </View>
              )}
              <View style={styles.fieldRow}>
                <SmallField label="Owner's profit" value={r.owners_profit} editable={canEdit}
                  onChange={(v) => setReview({ owners_profit: v })} placeholder="£" />
                <SmallField label="LOAs / sign-up" value={r.personal.loas} editable={canEdit}
                  onChange={(v) => setReview({ personal: { ...r.personal, loas: v } })} placeholder="" />
              </View>
              {/* Auto-filled from OwnerIQ: team + this leader's own LOA for the
                  review week — the week just gone (plan week − 7), not the
                  upcoming week being planned (Team / Me tabs). */}
              <PlannerLoaReview
                weekEnding={statsQ.data?.review_week_ending || addDaysISO(q.data?.week_ending || week, -7)}
                ownerUserId={targetUserId || user?.id}
              />
            </Card>

            
            {/* 🧠 Learnings */}
            <Card icon="school-outline" title="What Did I Learn?">
              <Bullets items={r.learnings} editable={canEdit} placeholder="A lesson you're taking from the week"
                onChange={(v) => setReview({ learnings: v })} />
            </Card>

            
              </>
            )}
            {wizStep(1) && (
              <>
            {/* 🎯 This week's goals — sales goals live on the Bells row */}
            <Card icon="flag-outline" title="This Week's Goals">
              <View style={styles.fieldRow}>
                {/* An admin's crew is the whole office, so this one number is
                    both their crew goal and the office goal — the server
                    mirrors it onto the office doc. Label it for what it drives. */}
                <SmallField label={planForAdmin ? 'Office sign-ups' : 'Team sign-ups'} value={goalTeam} editable={canEdit}
                  onChange={(v) => onGoalChange('team', v)}
                  placeholder={planForAdmin ? 'Office sign-up target' : 'Team sign-up target'} flex={1} />
                <SmallField label="Personal sign-ups" value={goalPersonal} editable={canEdit}
                  onChange={(v) => onGoalChange('personal', v)} placeholder="Your sign-up target" flex={1} />
              </View>
              <View style={styles.fieldRow}>
                <SmallField label="P/A" value={r.next_goals.piece_avg} editable={canEdit} flex={1}
                  onChange={(v) => setReview({ next_goals: { ...r.next_goals, piece_avg: v } })} placeholder="Target piece average" />
                <SmallField label="Scoring" value={r.next_goals.scoring} editable={canEdit} flex={1}
                  onChange={(v) => setReview({ next_goals: { ...r.next_goals, scoring: v } })} placeholder="Target scoring %" />
              </View>
              <Text style={styles.crewHint}>
                {planForAdmin
                  ? 'Sign-up goals sync with your Bells row — office sign-ups also sets the office goal'
                  : 'Team sign-ups is your crew’s goal for this week ending — synced with your Bells row'}
              </Text>
              <View style={styles.fieldRow}>
                <SmallField label="💡 Theme" value={r.theme} editable={canEdit} flex={1}
                  onChange={(v) => setReview({ theme: v })} placeholder="The week's theme" />
                <SmallField label="🧠 Concentration" value={r.concentration} editable={canEdit} flex={1}
                  onChange={(v) => setReview({ concentration: v })} placeholder="What the team concentrates on" />
              </View>
            </Card>

            
              </>
            )}
            {wizStep(2) && (
              <>
            {/* 👥 Crew — tap a person to set their schedule + weekly goal
                (written to their bells row for the week being planned).
                LOCKED for leaders after Monday 10:30 AM of that week —
                absences must be pre-declared, not back-dated. The server
                enforces this too; admins stay exempt. */}
            <Card icon="people-outline" title="Crew">
              {canCrewEdit && (statsQ.data?.crew || []).length > 0 && (
                <Text style={styles.crewHint}>Tap a name to set their weekly goal & request absences</Text>
              )}
              {crewLocked && (
                <View style={styles.lockBanner}>
                  <Ionicons name="lock-closed" size={13} color="#92400e" />
                  <Text style={styles.lockBannerText}>
                    Goals locked (Mon 10:30 AM). You can still request absences — they go to the office owner for approval.
                  </Text>
                </View>
              )}
              {(statsQ.data?.crew || []).map((m: any) => {
                const pendDays: number[] = m.pending_request?.day_indices || [];
                return (
                <TouchableOpacity
                  key={m.user_id}
                  style={styles.memberRow}
                  disabled={!canCrewEdit}
                  onPress={() => setCrewEdit({ user_id: m.user_id, name: m.name, goal: m.goal, day_statuses: m.day_statuses, pending_request: m.pending_request, last_decision: m.last_decision })}
                  activeOpacity={0.7}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.memberName} numberOfLines={1}>{m.name}</Text>
                    <Text style={styles.memberMeta}>
                      {m.last ? `Last wk ${fmt(m.last.total)} / goal ${fmt(m.last.goal)}` : 'Last wk —'}
                    </Text>
                    {pendDays.length > 0 && (
                      <Text style={styles.memberPending}>⏳ Absence requested — awaiting owner approval</Text>
                    )}
                    {pendDays.length === 0 && m.last_decision?.status === 'denied' && (
                      <Text style={styles.memberDenied}>Absence request denied</Text>
                    )}
                  </View>
                  <View style={styles.dayDots}>
                    {['M', 'T', 'W', 'T', 'F', 'S'].map((l, i) => {
                      // Predictive view: any non-Ab day reads as planned In.
                      // Approved Ab = red A · requested (pending) = amber A?
                      const ab = m.day_statuses?.[i] === 'ab';
                      const pend = !ab && pendDays.includes(i);
                      return (
                        <View key={i} style={[styles.dayDot, !ab && !pend && styles.dayDotOn, ab && styles.dayDotAb, pend && styles.dayDotPending]}>
                          <Text style={[styles.dayDotText, { color: ab ? '#dc2626' : pend ? '#b45309' : colors.onPrimary }]}>{ab ? 'A' : pend ? 'A?' : l}</Text>
                        </View>
                      );
                    })}
                  </View>
                  <View style={styles.goalPill}>
                    <Text style={styles.goalPillText}>{m.goal != null ? m.goal : '—'}</Text>
                  </View>
                </TouchableOpacity>
              ); })}
              {(statsQ.data?.team?.highrollers || []).length > 0 && (
                <View style={styles.highrollers}>
                  <Text style={styles.subHead}>🏆 Highrollers — last week</Text>
                  {(statsQ.data.team.highrollers as any[]).map((h, i) => (
                    <Text key={i} style={styles.highrollerText}>{['🥇', '🥈', '🥉'][i] || '•'} {h.name} — {h.total}</Text>
                  ))}
                </View>
              )}
              {/* Headcount / COD breakdown — auto-derived from the roster:
                  COD1 = trainee in first 8 days, COD2 = all 8 assessments
                  done, COD3 = leader, COD3+ = leader with a leader below. */}
              {!!statsQ.data?.headcount && (
                <>
                  <Text style={styles.subHead}>Headcount: {statsQ.data.headcount.total}</Text>
                  <View style={styles.statChips}>
                    <StatChip label="COD 1" value={String(statsQ.data.headcount.cod1)} />
                    <StatChip label="COD 2" value={String(statsQ.data.headcount.cod2)} />
                    <StatChip label="COD 3" value={String(statsQ.data.headcount.cod3)} />
                    <StatChip label="COD 3+" value={String(statsQ.data.headcount.cod3p)} />
                  </View>
                </>
              )}
              <BigField label="Crew notes" value={r.headcount} editable={canEdit}
                onChange={(v) => setReview({ headcount: v })} placeholder="Anything else about your crew this week" />
            </Card>

            
              </>
            )}
            {wizStep(3) && (
              <>
            {/* 🤝 Team coaching */}
            <Card icon="calendar-outline" title="Team Coaching">
              <BigField label="📅 Key meetings" value={r.team_management.meetings} editable={canEdit}
                onChange={(v) => setReview({ team_management: { ...r.team_management, meetings: v } })}
                placeholder={'Which meetings, on which days'} />
              <View style={styles.fieldRow}>
                <SmallField label="📞 Team call" value={r.team_management.team_call} editable={canEdit} flex={1}
                  onChange={(v) => setReview({ team_management: { ...r.team_management, team_call: v } })} placeholder="" />
                <SmallField label="🤝 1-on-1" value={r.team_management.one_on_one} editable={canEdit} flex={1}
                  onChange={(v) => setReview({ team_management: { ...r.team_management, one_on_one: v } })} placeholder="" />
              </View>
              <View style={styles.fieldRow}>
                <SmallField label="📚 Education" value={r.team_management.education} editable={canEdit} flex={1}
                  onChange={(v) => setReview({ team_management: { ...r.team_management, education: v } })} placeholder="" />
              </View>
              <BigField label="🍽️ Social nights" value={r.team_management.social} editable={canEdit}
                onChange={(v) => setReview({ team_management: { ...r.team_management, social: v } })}
                placeholder={'Social nights planned this week'} />
            </Card>

            
            {/* 🧑‍💼 Recruitment goals */}
            <Card icon="megaphone-outline" title="Recruitment Goals">
              <View style={styles.fieldRow}>
                <SmallField label="Booked-in goal" value={r.recruitment.booked_in} editable={canEdit}
                  onChange={(v) => setReview({ recruitment: { ...r.recruitment, booked_in: v } })} placeholder="How many" />
                <SmallField label="Attending goal" value={r.recruitment.attended} editable={canEdit}
                  onChange={(v) => setReview({ recruitment: { ...r.recruitment, attended: v } })} placeholder="How many" />
                <SmallField label="New starts goal" value={r.recruitment.newstarts} editable={canEdit}
                  onChange={(v) => setReview({ recruitment: { ...r.recruitment, newstarts: v } })} placeholder="How many" />
              </View>
              <View style={styles.fieldRow}>
                <SmallField label="🎯 Focus goal" value={r.recruitment.focus} editable={canEdit} flex={1}
                  onChange={(v) => setReview({ recruitment: { ...r.recruitment, focus: v } })} placeholder="Your recruitment focus for the week" />
              </View>
            </Card>

            
              </>
            )}
            {wizStep(4) && (
              <>
            {/* 🧩 8 Steps */}
            <Card icon="extension-puzzle-outline" title="8 Steps Review (Personal)">
              {EIGHT_STEPS.map((s) => (
                <View key={s} style={styles.stepRow}>
                  <Text style={styles.stepLabel} numberOfLines={1}>{s}</Text>
                  <Stars
                    value={r.eight_steps.scores[s] || 0}
                    editable={canEdit}
                    onChange={(v) => setReview({ eight_steps: { ...r.eight_steps, scores: { ...r.eight_steps.scores, [s]: v } } })}
                  />
                </View>
              ))}
              <View style={[styles.fieldRow, { marginTop: 8 }]}>
                <SmallField label="➡️ Focus" value={r.eight_steps.focus} editable={canEdit} flex={1}
                  onChange={(v) => setReview({ eight_steps: { ...r.eight_steps, focus: v } })} placeholder="Which steps you'll work on, e.g. Working territory + preparation" />
              </View>
            </Card>

            
            {/* 💪 Personal development */}
            <Card icon="barbell-outline" title="Personal Development">
              <View style={styles.fieldRow}>
                <SmallField label="COD" value={r.personal_development.cod} editable={canEdit}
                  onChange={(v) => setReview({ personal_development: { ...r.personal_development, cod: v } })} placeholder="Your current COD" />
                <SmallField label="Goal" value={r.personal_development.goal} editable={canEdit} flex={1}
                  onChange={(v) => setReview({ personal_development: { ...r.personal_development, goal: v } })} placeholder="Your COD goal for the week" />
              </View>
            </Card>

            
            {/* 🌱 Developing */}
            <Card icon="leaf-outline" title="Who Am I Developing">
              {r.developing.map((row) => (
                <View key={row.id} style={styles.devRow}>
                  <TextInput
                    value={row.who}
                    onChangeText={(v) => setReview({ developing: r.developing.map((x) => x.id === row.id ? { ...x, who: v } : x) })}
                    style={[styles.input, { width: 110 }]}
                    placeholder="Who" placeholderTextColor={colors.textMuted} editable={canEdit}
                  />
                  <TextInput
                    value={row.what}
                    onChangeText={(v) => setReview({ developing: r.developing.map((x) => x.id === row.id ? { ...x, what: v } : x) })}
                    style={[styles.input, { flex: 1 }]}
                    placeholder="What you're developing them on" placeholderTextColor={colors.textMuted} editable={canEdit}
                  />
                  {canEdit && (
                    <TouchableOpacity onPress={() => setReview({ developing: r.developing.filter((x) => x.id !== row.id) })} hitSlop={8}>
                      <Ionicons name="close" size={16} color={colors.textMuted} />
                    </TouchableOpacity>
                  )}
                </View>
              ))}
              {canEdit && (
                <TouchableOpacity style={styles.addLink} onPress={() => setReview({ developing: [...r.developing, { id: makeId(), who: '', what: '' }] })}>
                  <Ionicons name="add" size={14} color={colors.primary} />
                  <Text style={styles.addLinkText}>Add person</Text>
                </TouchableOpacity>
              )}
            </Card>

            
              </>
            )}
            {wizStep(5) && (
              <>
            {/* 🎯 Goals — this week's focuses + the bigger picture */}
            <Card icon="golf-outline" title="Goals">
              <Text style={styles.smallFieldLabel}>This week</Text>
              <Bullets items={r.focus_next_week} editable={canEdit} placeholder="A focus for this week"
                onChange={(v) => setReview({ focus_next_week: v })} />
              <BigField label="Mid-term focus" value={r.focus_mid} editable={canEdit}
                onChange={(v) => setReview({ focus_mid: v })} placeholder="Where you want the team in the next month or two" />
              <BigField label="Long-term focus" value={r.focus_long} editable={canEdit}
                onChange={(v) => setReview({ focus_long: v })} placeholder="The bigger picture you're building towards" />
            </Card>

            
            {/* Share */}
            <PressableScale style={styles.shareBtn} onPress={onShare}>
              <Ionicons name="logo-whatsapp" size={17} color="#fff" />
              <Text style={styles.shareBtnText}>Share as WhatsApp text</Text>
            </PressableScale>
          
              </>
            )}
            {wizard !== null && (
              <View style={styles.wizNavRow}>
                {wizard > 0 ? (
                  <TouchableOpacity style={styles.wizBack} onPress={() => setWizard(wizard - 1)}>
                    <Ionicons name="arrow-back" size={15} color={colors.textMuted} />
                    <Text style={styles.wizBackText}>Back</Text>
                  </TouchableOpacity>
                ) : <View style={{ flex: 1 }} />}
                <PressableScale
                  style={styles.wizNext}
                  onPress={() => {
                    if (wizard < 5) setWizard(wizard + 1);
                    else { setWizard(null); toast.success(wizDoneCount >= 6 ? 'Week fully planned 💪' : 'Plan saved — finish the open steps any time'); }
                  }}
                >
                  <Text style={styles.wizNextText}>
                    {wizard < 5 ? (stepDone[wizard] ? 'Next step' : 'Skip for now') : 'Finish'}
                  </Text>
                  <Ionicons name={wizard < 5 ? 'arrow-forward' : 'checkmark'} size={16} color={colors.onPrimary} />
                </PressableScale>
              </View>
            )}
          </>
        )}

        {typeof tab === 'number' && (
          <>
            <View style={styles.dayHeader}>
              <Text style={styles.dayTitle}>{DAY_FULL[tab]}</Text>
              <Text style={styles.daySub}>{shortDate(dayDate(week, tab))}</Text>
            </View>

            <Kicker style={styles.kicker}>Plan today</Kicker>
            <View style={styles.cardGrid}>
            {planFields.map((f) => (
              <Card
                grow
                key={f.key} icon={f.icon} title={f.label}
                right={canEdit ? (
                  <TouchableOpacity onPress={() => onScanInto(tab, f.key)} hitSlop={8} disabled={scanningField === f.key}>
                    {scanningField === f.key
                      ? <ActivityIndicator size="small" color={colors.primary} />
                      : <Ionicons name="camera-outline" size={17} color={colors.primary} />}
                  </TouchableOpacity>
                ) : undefined}
              >
                <NoteBox
                  value={draft.days[String(tab)]?.[f.key] || ''}
                  placeholder={`Plan ${f.label.toLowerCase()}…`}
                  onOpen={() => setEditorField({ where: 'day', tab, key: f.key, title: f.label })}
                />
                {/* The box above stays what it always was: the leader's own
                    note to self. Underneath it, the structured version for the
                    same day — the crew who are actually in, each with
                    learning/teaching/watching, a topic and who with, plus what
                    the rest of the office is running. Leaders only; trainees
                    don't schedule anyone. */}
                {f.key === 'primetime' && showWeekTab && (
                  <PrimetimeDayBlock week={week} dayIndex={tab} canEdit={canEdit} />
                )}
              </Card>
            ))}
            </View>

            <Kicker style={styles.kicker}>Notes</Kicker>
            <View style={styles.cardGrid}>
            {NOTE_FIELDS.map((f) => (
              <Card
                grow
                key={f.key} icon={f.icon} title={f.label}
                right={canEdit ? (
                  <TouchableOpacity onPress={() => onScanInto(tab, f.key)} hitSlop={8} disabled={scanningField === f.key}>
                    {scanningField === f.key
                      ? <ActivityIndicator size="small" color={colors.primary} />
                      : <Ionicons name="camera-outline" size={17} color={colors.primary} />}
                  </TouchableOpacity>
                ) : undefined}
              >
                {f.key === 'morning_bells' && isAdmin && !targetUserId && (
                  <BellsReadoutBlock week={week} dayIndex={tab} />
                )}
                <NoteBox
                  value={draft.days[String(tab)]?.[f.key] || ''}
                  placeholder="Notes…"
                  onOpen={() => setEditorField({ where: 'day', tab, key: f.key, title: f.label })}
                />
              </Card>
            ))}
            </View>
          </>
        )}

        {tab === 'notes' && (
          <Card icon="document-text-outline" title="Extra Notes">
            <NoteBox
              value={draft.notes}
              placeholder="Anything else from the week…"
              minHeight={260}
              previewLines={14}
              onOpen={() => setEditorField({ where: 'notes', title: 'Extra Notes' })}
            />
          </Card>
        )}
        </View>
      </ScrollView>

      {/* Near-full-screen note editor. Full-screen modal (not a sheet) so long
          notes get real reading room; the input keeps its own bottom padding
          equal to the keyboard overlap (iOS + mobile web — Android resizes
          the window itself, the hook returns 0 there). */}
      <Modal visible={!!editorField} animationType="slide" onRequestClose={() => setEditorField(null)}>
        <View style={[styles.editorRoot, { paddingTop: safeInsets.top }]}>
          <View style={styles.editorHeader}>
            <View style={{ flex: 1 }}>
              <Text style={styles.editorTitle} numberOfLines={1}>{editorField?.title}</Text>
              <Text style={styles.editorSub} numberOfLines={1}>
                {editorField?.where === 'notes' ? `Week ending ${shortDate(week)}` : `${DAY_FULL[editorField?.tab ?? 0]} · week ending ${shortDate(week)}`}
              </Text>
            </View>
            <TouchableOpacity style={styles.editorDone} onPress={() => setEditorField(null)} hitSlop={8}>
              <Ionicons name="checkmark" size={18} color={colors.onPrimary} />
              <Text style={styles.editorDoneText}>Done</Text>
            </TouchableOpacity>
          </View>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
            <TextInput
              value={editorValue}
              onChangeText={setEditorValue}
              style={[styles.editorInput, Platform.OS === 'web' && kbInset > 0 ? { paddingBottom: kbInset + 16 } : null]}
              placeholder={canEdit ? 'Write your notes…' : 'No notes yet.'}
              placeholderTextColor={colors.textMuted}
              multiline
              autoFocus={canEdit}
              editable={canEdit}
              textAlignVertical="top"
            />
          </KeyboardAvoidingView>
        </View>
      </Modal>

      {/* Crew schedule + goal sheet */}
      <Modal visible={!!crewEdit} transparent animationType="slide" onRequestClose={() => setCrewEdit(null)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setCrewEdit(null)}>
          {/* Lift the sheet above the keyboard so Save/Cancel stay reachable
              while typing the goal (the number pad has no Done key on iOS). */}
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ width: '100%' }}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>{crewEdit?.name}</Text>
            <Text style={styles.sheetSub}>
              Week ending {shortDate(week)}{isAdmin
                ? ' — absences & goal go straight onto their Bells row.'
                : ' — the goal goes on their Bells row; absences are sent to the office owner for approval.'}
            </Text>

            {/* Predictive week plan: the toggle speaks In / Ab — no 'off',
                this is the week AHEAD. Underneath, 'In' deliberately writes
                NOTHING to Bells (the cell stays blank until sales are
                entered, so it can never count as a 0-scoring In-day); only
                Ab lands on the Bells sheet. For leaders, a NEW Ab becomes a
                pending request (amber) until the owner approves it. */}
            <Text style={styles.smallFieldLabel}>Week plan — tap to toggle In / Ab</Text>
            <View style={styles.sheetDaysRow}>
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((l, i) => {
                const ab = crewDays[i] === 'ab';
                const isApproved = approvedAb(i);
                const isPendingAb = ab && !isApproved && !isAdmin;
                // After the lock, an approved Ab can only be cleared by the
                // office admin — tapping it does nothing for a leader.
                const frozen = crewLocked && isApproved;
                return (
                  <TouchableOpacity
                    key={l}
                    disabled={frozen}
                    style={[
                      styles.sheetDayChip,
                      !ab && styles.sheetDayChipOn,
                      ab && !isPendingAb && styles.sheetDayChipAb,
                      isPendingAb && styles.sheetDayChipPending,
                      frozen && { opacity: 0.55 },
                    ]}
                    onPress={() => setCrewDays((cur) => cur.map((cs, si) =>
                      si === i ? (cs === 'ab' ? 'off' : 'ab') : cs))}
                  >
                    <Text style={[styles.sheetDayChipText, { color: ab ? (isPendingAb ? '#b45309' : '#dc2626') : '#fff' }]}>{l}</Text>
                    <Text style={[styles.sheetDayChipState, { color: ab ? (isPendingAb ? '#b45309' : '#dc2626') : 'rgba(255,255,255,0.9)' }]}>
                      {isPendingAb ? 'AB?' : ab ? 'AB' : 'IN'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text style={styles.sheetLockNote}>
              {isAdmin
                ? '"In" is the plan — on Bells the day stays blank until sign-ups are entered, so it never counts as a 0. Only Ab is written to the sheet.'
                : '"In" is the plan — the Bells day stays blank until sign-ups are entered. New absences (amber) go to the office owner for approval before they land on Bells.\n🔒 Goals lock Monday 10:30 AM — absences can be requested any time.'}
            </Text>

            {/* Reason — required context for the owner's approve/deny call */}
            {!isAdmin && pendingSelection && (
              <>
                <Text style={[styles.smallFieldLabel, { marginTop: 14 }]}>Reason for absence — required, the owner sees this</Text>
                <TextInput
                  value={crewReason}
                  onChangeText={setCrewReason}
                  style={[styles.input, { minHeight: 44 }]}
                  placeholder="e.g. Doctor's appointment Wednesday morning"
                  placeholderTextColor={colors.textMuted}
                  multiline scrollEnabled={false}
                />
                {!crewReasonOk && (
                  <Text style={styles.reasonHint}>Add a reason before saving — the owner needs it to decide.</Text>
                )}
              </>
            )}
            {!isAdmin && !!crewEdit?.pending_request && !pendingSelection && (
              <View style={styles.pendingBanner}>
                <Ionicons name="hourglass-outline" size={13} color="#b45309" />
                <Text style={styles.pendingBannerText}>Saving now will withdraw the pending absence request.</Text>
              </View>
            )}
            {!isAdmin && crewEdit?.last_decision?.status === 'denied' && !crewEdit?.pending_request && (
              <View style={styles.deniedBanner}>
                <Ionicons name="close-circle-outline" size={13} color="#dc2626" />
                <Text style={styles.deniedBannerText}>
                  Last absence request was denied{crewEdit.last_decision.decision_note ? ` — “${crewEdit.last_decision.decision_note}”` : ''}.
                </Text>
              </View>
            )}

            <Text style={[styles.smallFieldLabel, { marginTop: 14 }]}>Weekly goal{crewLocked ? ' · 🔒 locked' : ''}</Text>
            <TextInput
              value={crewGoal}
              onChangeText={setCrewGoal}
              style={[styles.input, { fontSize: 16 }, crewLocked && { opacity: 0.6 }]}
              placeholder="e.g. 10"
              placeholderTextColor={colors.textMuted}
              keyboardType="numeric"
              editable={!crewLocked}
            />

            <View style={styles.sheetBtnRow}>
              <TouchableOpacity style={styles.sheetBtnGhost} onPress={() => setCrewEdit(null)}>
                <Text style={styles.sheetBtnGhostText}>Cancel</Text>
              </TouchableOpacity>
              <PressableScale
                style={[styles.sheetBtnPrimary, (crewMut.isPending || !crewReasonOk) && { opacity: 0.5 }]}
                onPress={() => crewMut.mutate()}
                disabled={crewMut.isPending || !crewReasonOk}
              >
                <Text style={styles.sheetBtnPrimaryText}>{crewMut.isPending ? 'Saving…' : 'Save'}</Text>
              </PressableScale>
            </View>
          </Pressable>
          </KeyboardAvoidingView>
        </Pressable>
      </Modal>
    </View>
  );
}

// ── Small building blocks ─────────────────────────────────────────────────
function WeekHeader({ week, setWeek, savingState, onShare, onToggleSearch, searchOpen, title }: {
  week: string; setWeek: (w: string) => void;
  savingState: 'idle' | 'saving' | 'saved' | 'error';
  onShare: (() => void) | null;
  onToggleSearch?: (() => void) | null;
  searchOpen?: boolean;
  title?: string;
}) {
  const colors = useColors();
  const styles = useStyles();
  const rel = weekRelative(week);
  return (
    <View style={styles.headerRow}>
      <View style={{ flex: 1 }}>
        {/* The page's name is in the masthead (Weekly Planner / Daily Planner),
            so this row is only the week. On Sundays the planner opens NEXT
            week; the relative chip makes it impossible to plan the wrong one. */}
        <View style={styles.weekSwitcher} accessibilityLabel={title || 'Weekly Planner'}>
          <TouchableOpacity onPress={() => setWeek(addDaysISO(week, -7))} style={styles.weekArrow} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} accessibilityLabel="Week before">
            <Ionicons name="chevron-back" size={16} color={colors.text} />
          </TouchableOpacity>
          <View style={styles.weekCenter}>
            <Ionicons name="calendar-outline" size={15} color={colors.primary} />
            <Text style={styles.weekCenterText}>WE {fullDate(week)}</Text>
            <View style={[
              styles.weekRelChip,
              rel.tone === 'future' && styles.weekRelChipFuture,
              rel.tone === 'past' && styles.weekRelChipPast,
            ]}>
              <Text style={[
                styles.weekRelChipText,
                rel.tone === 'future' && { color: '#92400e' },
                rel.tone === 'past' && { color: '#6b7280' },
              ]}>{rel.label}</Text>
            </View>
          </View>
          <TouchableOpacity onPress={() => setWeek(addDaysISO(week, 7))} style={styles.weekArrow} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} accessibilityLabel="Week after">
            <Ionicons name="chevron-forward" size={16} color={colors.text} />
          </TouchableOpacity>
        </View>
      </View>
      {savingState !== 'idle' && (
        <View style={styles.saveDot}>
          {savingState === 'saving' && <ActivityIndicator color={colors.textMuted} size="small" />}
          {savingState === 'saved' && <Ionicons name="checkmark-circle" size={16} color="#22c55e" />}
          {savingState === 'error' && <Ionicons name="alert-circle" size={16} color="#dc2626" />}
        </View>
      )}
      {onToggleSearch && (
        <TouchableOpacity onPress={onToggleSearch} style={[styles.shareIconBtn, searchOpen && { backgroundColor: colors.primary }]} hitSlop={8}>
          <Ionicons name="search" size={18} color={searchOpen ? colors.onPrimary : colors.primary} />
        </TouchableOpacity>
      )}
      {onShare && (
        <TouchableOpacity onPress={onShare} style={styles.shareIconBtn} hitSlop={8}>
          <Ionicons name="share-outline" size={18} color={colors.primary} />
        </TouchableOpacity>
      )}
    </View>
  );
}

function Card({ icon, title, right, children, grow }: {
  icon: any; title: string; right?: React.ReactNode; children: React.ReactNode;
  /** In a cardGrid: share the row, two (or three) to a line where there is room. */
  grow?: boolean;
}) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={[styles.card, grow && styles.cardGrow]}>
      <View style={styles.cardHeader}>
        <Ionicons name={icon} size={15} color={colors.primary} />
        <Text style={[styles.cardTitle, { flex: 1 }]}>{title}</Text>
        {right}
      </View>
      {children}
    </View>
  );
}

function StatChip({ label, value }: { label: string; value: string }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.statChip}>
      <Text style={styles.statChipLabel}>{label}</Text>
      <Text style={styles.statChipValue}>{value}</Text>
    </View>
  );
}

// Tap-to-expand note box. The inline box is a PREVIEW — tapping it opens the
// near-full-screen editor, so nobody reads or writes long notes through a
// four-line slot. (Owner request, Aug 2026.)
function NoteBox({ value, placeholder, onOpen, minHeight, previewLines }: {
  value: string; placeholder: string; onOpen: () => void; minHeight?: number; previewLines?: number;
}) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <Pressable
      onPress={onOpen}
      style={({ pressed }) => [styles.dayBox, { minHeight: minHeight ?? 92 }, styles.noteBoxWrap, pressed && { opacity: 0.8 }]}
      accessibilityRole="button"
      accessibilityLabel={value ? 'Open notes editor' : placeholder}
    >
      {value
        ? <Text style={styles.noteBoxText} numberOfLines={previewLines ?? 6}>{value}</Text>
        : <Text style={[styles.noteBoxText, { color: colors.textMuted }]}>{placeholder}</Text>}
      <View style={styles.noteBoxExpand}>
        <Ionicons name="expand-outline" size={12} color={colors.textMuted} />
        <Text style={styles.noteBoxExpandText}>Tap to expand</Text>
      </View>
    </Pressable>
  );
}

// The morning "Bells read-out" — admins only. Computed live by the backend
// from yesterday's bells (Sat+Sun on Mondays, top-5 midweek review on
// Thursdays), so edits to bells show up on the next load. Read-only: it sits
// above the admin's own Bells notes, never inside them.
function BellsReadoutBlock({ week, dayIndex }: { week: string; dayIndex: number }) {
  const colors = useColors();
  const styles = useStyles();
  const q = useQuery({
    queryKey: ['bells-readout', week, dayIndex],
    queryFn: () => apiService.bellsReadout(week, dayIndex).then((r) => r.data),
    staleTime: 60 * 1000,
  });
  if (q.isLoading || !q.data) return null;
  const d = q.data;
  const fmt = (iso: string) => {
    const dt = new Date(iso + 'T00:00:00');
    return isNaN(dt.getTime()) ? iso : dt.toLocaleDateString(APP_LOCALE, { weekday: 'short', month: 'short', day: 'numeric' });
  };
  const line = (r: { name: string; sales: number }) => `${r.sales} — ${r.name}`;
  const hasAny = (d.readout || []).length || (d.sunday || []).length || (d.top5 || []).length;
  return (
    <View style={styles.readoutBox}>
      <Text style={styles.readoutTitle}>🔔 Read-out · auto from Bells</Text>
      <Text style={styles.readoutSub}>{fmt(d.source_date)}</Text>
      {(d.readout || []).length
        ? (d.readout as any[]).map((r, i) => <Text key={i} style={styles.readoutLine}>{line(r)}</Text>)
        : <Text style={[styles.readoutLine, { color: colors.textMuted }]}>No qualifiers ({fmt(d.source_date)}: BAs 2+, coaches 3+).</Text>}
      {(d.sunday || []).length > 0 && (
        <>
          <Text style={styles.readoutSub}>Sunday sign-ups · {fmt(d.sunday_date)}</Text>
          {(d.sunday as any[]).map((r, i) => <Text key={i} style={styles.readoutLine}>{line(r)}</Text>)}
        </>
      )}
      {(d.top5 || []).length > 0 && (
        <>
          <Text style={styles.readoutSub}>📈 Halfway review — top 5 this week</Text>
          {(d.top5 as any[]).map((r, i) => <Text key={i} style={styles.readoutLine}>{`${i + 1}. ${r.name} — ${r.sales}`}</Text>)}
        </>
      )}
      {!hasAny && null}
    </View>
  );
}

function SmallField({ label, value, onChange, editable, placeholder, flex }: {
  label: string; value: string; onChange: (v: string) => void;
  editable: boolean; placeholder?: string; flex?: number;
}) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={[styles.smallField, flex ? { flex } : { minWidth: 86 }]}>
      <Text style={styles.smallFieldLabel}>{label}</Text>
      <TextInput value={value} onChangeText={onChange} style={styles.input}
        placeholder={placeholder} placeholderTextColor={colors.textMuted} editable={editable} />
    </View>
  );
}

function BigField({ label, value, onChange, editable, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; editable: boolean; placeholder?: string;
}) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={{ marginTop: 8 }}>
      <Text style={styles.smallFieldLabel}>{label}</Text>
      <TextInput value={value} onChangeText={onChange} style={[styles.input, styles.multiline]}
        placeholder={placeholder} placeholderTextColor={colors.textMuted} multiline scrollEnabled={false} editable={editable} />
    </View>
  );
}

function Bullets({ items, onChange, editable, placeholder }: {
  items: string[]; onChange: (v: string[]) => void; editable: boolean; placeholder?: string;
}) {
  const colors = useColors();
  const styles = useStyles();
  const setAt = (i: number, v: string) => onChange(items.map((x, xi) => (xi === i ? v : x)));
  return (
    <View>
      {items.map((x, i) => (
        <View key={i} style={styles.bulletRow}>
          <Text style={styles.bulletDot}>•</Text>
          <TextInput value={x} onChangeText={(v) => setAt(i, v)} style={[styles.input, { flex: 1 }]}
            placeholder={placeholder} placeholderTextColor={colors.textMuted} editable={editable} />
          {editable && (
            <TouchableOpacity onPress={() => onChange(items.filter((_, xi) => xi !== i))} hitSlop={8}>
              <Ionicons name="close" size={16} color={colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>
      ))}
      {editable && (
        <TouchableOpacity style={styles.addLink} onPress={() => onChange([...items, ''])}>
          <Ionicons name="add" size={14} color={colors.primary} />
          <Text style={styles.addLinkText}>Add</Text>
        </TouchableOpacity>
      )}
      {!editable && items.length === 0 && <Text style={styles.mutedText}>—</Text>}
    </View>
  );
}

function Stars({ value, onChange, editable }: { value: number; onChange: (v: number) => void; editable: boolean }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={{ flexDirection: 'row', gap: 2 }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <TouchableOpacity key={i} disabled={!editable} onPress={() => onChange(value === i ? i - 1 : i)} hitSlop={4}>
          <Ionicons name={i <= value ? 'star' : 'star-outline'} size={17} color={i <= value ? '#f59e0b' : colors.textMuted} />
        </TouchableOpacity>
      ))}
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, gap: 8 },
  emptyTitle: { fontFamily: fonts.display, fontSize: 16, fontWeight: '800', color: colors.text, marginTop: 6 },
  emptyText: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted, textAlign: 'center', lineHeight: 18 },

  shell: { width: '100%', maxWidth: 1240, alignSelf: 'center' },
  kicker: { marginTop: 8, marginBottom: 10 },
  cardGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 12 },
  cardGrow: { flexGrow: 1, flexBasis: 380, minWidth: 260, marginBottom: 0 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12, marginTop: 4 },
  title: { fontFamily: fonts.display, fontSize: 22, fontWeight: '800', color: colors.text, letterSpacing: -0.3 },
  weekSwitcher: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  weekArrow: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  weekCenter: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 34, paddingHorizontal: 12, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, borderRadius: 10 },
  weekCenterText: { fontFamily: fonts.bodySemibold, fontSize: 13.5, color: colors.text },
  weekRelChip: { backgroundColor: '#dcfce7', paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999 },
  weekRelChipFuture: { backgroundColor: '#fef3c7' },
  weekRelChipPast: { backgroundColor: colors.surfaceAlt },
  weekRelChipText: { fontSize: 9.5, fontWeight: '900', color: '#166534', letterSpacing: 0.4, textTransform: 'uppercase' },
  saveDot: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  shareIconBtn: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },

  roBanner: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#e0f2fe', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 10, borderWidth: 1, borderColor: '#7dd3fc' },
  roBannerText: { fontSize: 11, color: '#0c4a6e', fontWeight: '700', flex: 1 },

  tabRow: { flexDirection: 'row', gap: 4, padding: 3, marginBottom: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  tabChip: { minHeight: 32, paddingHorizontal: 14, borderRadius: 9, justifyContent: 'center' },
  tabChipActive: { backgroundColor: colors.primary },
  tabChipText: { fontFamily: fonts.bodySemibold, fontSize: 12.5, color: colors.textSecondary },
  tabChipTextActive: { color: colors.onPrimary },

  card: { backgroundColor: colors.background, borderRadius: 14, borderWidth: 1, borderColor: colors.border, padding: 12, marginBottom: 10 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 8 },
  cardTitle: { fontFamily: fonts.bodySemibold, fontSize: 13.5, color: colors.text },
  subHead: { fontSize: 10, fontWeight: '800', color: colors.textMuted, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 6, marginTop: 4 },
  mutedText: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted },

  statChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 },
  statChip: { alignItems: 'center', paddingVertical: 6, paddingHorizontal: 10, borderRadius: 10, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border, minWidth: 62 },
  statChipLabel: { fontSize: 9, fontWeight: '800', color: colors.textMuted, letterSpacing: 0.4, textTransform: 'uppercase' },
  statChipValue: { fontFamily: fonts.mono, fontSize: 15, fontWeight: '800', color: colors.text, marginTop: 1 },

  fieldRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  smallField: {},
  smallFieldLabel: { fontSize: 10, fontWeight: '800', color: colors.textMuted, letterSpacing: 0.4, textTransform: 'uppercase', marginBottom: 3 },
  input: { fontFamily: fonts.body, backgroundColor: colors.surfaceAlt, borderRadius: 8, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 10, paddingVertical: 7, fontSize: 13, color: colors.text },
  multiline: { minHeight: 64, textAlignVertical: 'top' },

  memberRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,0.04)' },
  memberName: { fontFamily: fonts.bodySemibold, fontSize: 13, fontWeight: '700', color: colors.text },
  memberMeta: { fontFamily: fonts.mono, fontSize: 10, fontWeight: '700', color: colors.textMuted, marginTop: 1 },
  crewHint: { fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, fontStyle: 'italic', marginBottom: 6 },
  dayDots: { flexDirection: 'row', gap: 2 },
  dayDot: { width: 17, height: 17, borderRadius: 5, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
  dayDotOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  dayDotAb: { backgroundColor: '#fee2e2', borderColor: '#fecaca' },
  dayDotText: { fontSize: 8, fontWeight: '800', color: colors.textMuted },
  lockBanner: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#fef3c7', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7, marginBottom: 8, borderWidth: 1, borderColor: '#fde68a' },
  lockBannerText: { flex: 1, fontSize: 11, fontWeight: '700', color: '#92400e', lineHeight: 15 },
  goalPill: { minWidth: 34, alignItems: 'center', paddingVertical: 3, paddingHorizontal: 7, borderRadius: 999, backgroundColor: 'rgba(58, 122, 86, 0.08)', borderWidth: 1, borderColor: `${colors.primary}25` },
  goalPillText: { fontFamily: fonts.mono, fontSize: 11, fontWeight: '800', color: colors.primary },

  // Crew schedule/goal sheet
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(11, 33, 28, 0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.background, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 18, paddingBottom: 28 },
  sheetHandle: { width: 36, height: 4, backgroundColor: colors.border, borderRadius: 2, alignSelf: 'center', marginBottom: 10 },
  sheetTitle: { fontFamily: fonts.display, fontSize: 17, fontWeight: '800', color: colors.text },
  sheetSub: { fontFamily: fonts.body, fontSize: 11.5, color: colors.textMuted, marginTop: 3, marginBottom: 14, lineHeight: 16 },
  sheetDaysRow: { flexDirection: 'row', gap: 6, marginTop: 2 },
  sheetDayChip: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 10, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  sheetDayChipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  sheetDayChipAb: { backgroundColor: '#fee2e2', borderColor: '#fecaca' },
  sheetDayChipText: { fontFamily: fonts.bodySemibold, fontSize: 11, fontWeight: '800', color: colors.textMuted },
  sheetDayChipState: { fontFamily: fonts.mono, fontSize: 8.5, fontWeight: '900', letterSpacing: 0.5, marginTop: 1 },
  sheetLockNote: { fontFamily: fonts.body, fontSize: 10.5, color: colors.textMuted, marginTop: 8, lineHeight: 15 },
  sheetBtnRow: { flexDirection: 'row', gap: 10, marginTop: 18 },
  sheetBtnGhost: { flex: 1, alignItems: 'center', paddingVertical: 13, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  sheetBtnGhostText: { fontFamily: fonts.bodySemibold, fontSize: 13, fontWeight: '700', color: colors.textMuted },
  sheetBtnPrimary: { flex: 1, alignItems: 'center', paddingVertical: 13, borderRadius: 12, backgroundColor: colors.primary },
  sheetBtnPrimaryText: { fontFamily: fonts.bodySemibold, fontSize: 13, fontWeight: '800', color: colors.onPrimary },
  highrollers: { marginTop: 8 },
  highrollerText: { fontFamily: fonts.body, fontSize: 13, color: colors.text, paddingVertical: 2 },

  devRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  addLink: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6 },
  addLinkText: { fontSize: 12, fontWeight: '700', color: colors.primary },

  bulletRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  bulletDot: { fontSize: 16, color: colors.primary, fontWeight: '800' },

  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5 },
  stepLabel: { flex: 1, fontFamily: fonts.body, fontSize: 12.5, fontWeight: '600', color: colors.text },

  sectionHead: { fontFamily: fonts.bodySemibold, fontSize: 11, fontWeight: '800', color: colors.textMuted, letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 8, marginTop: 4, paddingHorizontal: 2 },

  searchBar: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 9, marginBottom: 10 },
  searchInput: { flex: 1, fontFamily: fonts.body, fontSize: 13, color: colors.text, padding: 0 },
  searchResult: { backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 12, marginBottom: 8 },
  searchResultTitle: { fontFamily: fonts.bodySemibold, fontSize: 12, fontWeight: '800', color: colors.primary, marginBottom: 3 },
  searchResultSnippet: { fontFamily: fonts.body, fontSize: 12.5, color: colors.text, lineHeight: 18 },

  dayHeader: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginBottom: 6 },
  dayTitle: { fontFamily: fonts.display, fontSize: 20, color: colors.text, letterSpacing: -0.3 },
  daySub: { fontFamily: fonts.mono, fontSize: 12, fontWeight: '700', color: colors.textMuted },
  dayBox: { fontFamily: fonts.body, backgroundColor: colors.surface, borderRadius: 10, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 10, paddingVertical: 9, fontSize: 13, color: colors.text, minHeight: 92, textAlignVertical: 'top', lineHeight: 19 },
  noteBoxWrap: { justifyContent: 'space-between' },
  noteBoxText: { fontFamily: fonts.body, fontSize: 13, color: colors.text, lineHeight: 19 },
  noteBoxExpand: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-end', marginTop: 8 },
  noteBoxExpandText: { fontFamily: fonts.body, fontSize: 10, color: colors.textMuted },
  readoutBox: { backgroundColor: colors.primary + '0D', borderColor: colors.primary + '33', borderWidth: 1, borderRadius: 10, padding: 10, marginBottom: 8 },
  readoutTitle: { fontFamily: fonts.bodyBold, fontSize: 12, color: colors.primary },
  readoutSub: { fontFamily: fonts.bodyBold, fontSize: 10, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 6, marginBottom: 2 },
  readoutLine: { fontFamily: fonts.body, fontSize: 13, color: colors.text, lineHeight: 20 },
  editorRoot: { flex: 1, backgroundColor: colors.background },
  editorHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  editorTitle: { fontFamily: fonts.bodyBold, fontSize: 17, color: colors.text },
  editorSub: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted, marginTop: 1 },
  editorDone: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: colors.primary, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  editorDoneText: { fontFamily: fonts.bodyBold, fontSize: 13, color: colors.onPrimary },
  editorInput: { flex: 1, fontFamily: fonts.body, fontSize: 15, lineHeight: 23, color: colors.text, padding: 16, textAlignVertical: 'top' },

  shareBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: '#25D366', borderRadius: 12, paddingVertical: 14, marginTop: 2 },
  shareBtnText: { fontFamily: fonts.bodySemibold, color: '#fff', fontSize: 14, fontWeight: '800' },

  // ── Step-by-step wizard ─────────────────────────────────────────────────
  wizCta: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.primary, borderRadius: 16, padding: 14, marginBottom: 12, overflow: 'hidden', shadowColor: colors.primary, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 3 },
  wizCtaIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' },
  wizCtaTitle: { fontFamily: fonts.display, fontSize: 14.5, fontWeight: '800', color: colors.onPrimary, letterSpacing: -0.2 },
  wizCtaSub: { fontFamily: fonts.body, fontSize: 11, color: 'rgba(255,255,255,0.85)', marginTop: 2 },
  wizCtaProgress: { minWidth: 44, alignItems: 'center', paddingVertical: 6, paddingHorizontal: 8, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.18)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' },
  wizCtaProgressText: { fontFamily: fonts.mono, fontSize: 13, fontWeight: '800', color: colors.onPrimary },
  wizHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 4, paddingHorizontal: 2 },
  wizStepNum: { fontFamily: fonts.mono, fontSize: 10, fontWeight: '800', color: colors.primary, letterSpacing: 1 },
  wizTitle: { fontFamily: fonts.display, fontSize: 19, fontWeight: '800', color: colors.text, letterSpacing: -0.3, marginTop: 2 },
  wizHint: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted, marginTop: 3, lineHeight: 17 },
  wizClose: { padding: 6, borderRadius: 10, backgroundColor: colors.surfaceAlt },
  wizProgressRow: { flexDirection: 'row', gap: 4, marginBottom: 10, paddingHorizontal: 2 },
  wizSeg: { height: 4, borderRadius: 2, backgroundColor: colors.border },
  wizSegDone: { backgroundColor: '#22c55e' },
  wizSegActive: { backgroundColor: colors.primary, height: 6, borderRadius: 3, marginTop: -1 },
  wizNavRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4, marginBottom: 8 },
  wizBack: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 13, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  wizBackText: { fontFamily: fonts.bodySemibold, fontSize: 13, fontWeight: '700', color: colors.textMuted },
  wizNext: { flex: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 13, borderRadius: 12, backgroundColor: colors.primary },
  wizNextText: { fontFamily: fonts.bodySemibold, fontSize: 13, fontWeight: '800', color: colors.onPrimary },

  // ── Absence request states ─────────────────────────────────────────────
  dayDotPending: { backgroundColor: '#fef3c7', borderColor: '#fde68a' },
  memberPending: { fontFamily: fonts.body, fontSize: 10.5, fontWeight: '700', color: '#b45309', marginTop: 2 },
  memberDenied: { fontFamily: fonts.body, fontSize: 10.5, fontWeight: '700', color: '#dc2626', marginTop: 2 },
  sheetDayChipPending: { backgroundColor: '#fef3c7', borderColor: '#fcd34d' },
  pendingBanner: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#fef3c7', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7, marginTop: 12, borderWidth: 1, borderColor: '#fde68a' },
  pendingBannerText: { flex: 1, fontSize: 11, fontWeight: '700', color: '#92400e', lineHeight: 15 },
  reasonHint: { fontSize: 11, color: '#b45309', marginTop: 6, fontWeight: '600' },
  deniedBanner: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#fee2e2', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7, marginTop: 12, borderWidth: 1, borderColor: '#fecaca' },
  deniedBannerText: { flex: 1, fontSize: 11, fontWeight: '700', color: '#991b1b', lineHeight: 15 },
});

/* __theme_static_fallback__ */
// Fallback static styles (used by sub-components that don't call useColors).
// Always light-mode — won't react to theme changes.
const colors = lightColors;
const styles = createStyles(lightColors);
