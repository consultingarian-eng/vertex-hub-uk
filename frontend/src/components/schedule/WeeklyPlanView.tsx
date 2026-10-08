import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { showAlert } from '../../utils/showAlert';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, ActivityIndicator, RefreshControl, Modal, Pressable,  } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '../../theme/colors';
import { lightColors } from '../../theme/ThemeContext';
import { GRADIENT, useColors, useTheme, fonts } from '../../theme/ThemeContext';
import { BrandLoader } from '../ui/BrandLoader';
import { DepthCard } from '../ui/DepthCard';
import { GlowButton } from '../ui/GlowButton';
import { SlidingSegments } from '../ui/SlidingSegments';
import PressableScale from '../ui/PressableScale';
import { useAuth } from '../../auth/AuthContext';
import { useActiveOffice } from '../../office/ActiveOfficeContext';
import { apiService } from '../../api/client';
import WeeklyPlanGridView from './WeeklyPlanGridView';
import AgendaScanReviewSheet, { ScanInFlightOverlay, ApplyResult, ScanPayload } from './AgendaScanReviewSheet';
import * as ImagePicker from 'expo-image-picker';
import { APP_LOCALE } from '../../utils/appTime';

// ──────────────────────────────────────────────────────────────────────────
// Agenda tab — admins build/publish a weekly plan; leaders see it read-only.
//
// The admin editor is split by how often things change:
//   • Fill (default)  — weekly content entry. Day chips filter to one day's
//     slots; the All view shows each row collapsed to only the days it
//     actually happens on (from schedule_blocks via row.active_days).
//   • Structure       — rarely-touched layout config: row labels/times,
//     schedule matching, hide/show, add/remove, re-sync from Schedule.
//   • Preview         — exactly what leaders see once published.
// Auto-saves drafts every 1.2s after edits. Publish auto-fills topic +
// presenter on matching schedule blocks.
// ──────────────────────────────────────────────────────────────────────────

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ALL_DAYS = [0, 1, 2, 3, 4, 5];
const THEMES_FIELDS: { key: string; label: string; placeholder: string }[] = [
  { key: 'expectations_1',         label: 'Expectations · Person 1', placeholder: '' },
  { key: 'expectations_2',         label: 'Expectations · Person 2', placeholder: '' },
  { key: 'leaders',                label: 'Coaches Theme',           placeholder: '' },
  { key: 'topic_theme',            label: 'Topic Theme',             placeholder: '' },
  { key: 'customer_service_theme', label: 'Customer Service Theme',  placeholder: '' },
  { key: 'competition',            label: 'Competition This Week',   placeholder: '' },
  { key: 'concentration',          label: 'Concentration',           placeholder: '' },
  { key: 'news',                   label: 'News',                    placeholder: '' },
  { key: 'social',                 label: 'Social',                  placeholder: '' },
];

// Side-panel stats (numbers / short text)
const STATS_FIELDS: { key: string; label: string; placeholder: string; icon: any; color: string }[] = [
  { key: 'weekly_goal',       label: 'Weekly Goal',       placeholder: 'e.g. 95',  icon: 'flag',         color: '#ef4444' },
  { key: 'promotions',        label: 'Advancements',      placeholder: 'e.g. 1',   icon: 'rocket-outline', color: '#8caf38' },
  { key: 'personal_recruits', label: 'Personal Recruits', placeholder: 'e.g. 2',   icon: 'person-add-outline', color: '#22c55e' },
];

type Cell = { day: number; topic: string; presenter: string };
type Row = {
  id: string; label: string; time_label: string; schedule_match_title: string | null; cells: Cell[];
  /** Days this row's matched schedule block actually occurs on (from the
   * backend, recomputed each GET). null/undefined → treat as every day. */
  active_days?: number[] | null;
};
type Themes = Record<string, string>;
type Stats = Record<string, string>;
type Agenda = {
  id: string; office_id: string; week_ending: string;
  status: 'draft' | 'preview' | 'published';
  themes: Themes; stats: Stats; rows: Row[];
  created_by_id?: string; created_at?: string; updated_at?: string; published_at?: string | null;
};

// Small helpers ─────────────────────────────────────────────────────────
function makeId(): string { return Math.random().toString(36).slice(2, 11); }
function thisSunday(): string {
  // JS: Sun=0..Sat=6 → days to add to reach upcoming Sunday (today if Sunday)
  const d = new Date();
  const offset = (7 - d.getDay()) % 7;
  d.setDate(d.getDate() + offset);
  // IMPORTANT: use *local* y/m/d here, NOT toISOString().slice() — toISOString
  // converts to UTC which can shift the date by a day in westerly timezones
  // when run in the evening, producing e.g. "May 2" instead of "May 3".
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
function shortDate(iso: string): string {
  if (!iso) return '';
  // Parse as a local date (NOT UTC) so e.g. "2026-05-03" never displays as
  // "May 2" in westerly timezones.
  const [y, m, dd] = iso.split('-').map(Number);
  if (!y || !m || !dd) return iso;
  const d = new Date(y, m - 1, dd);
  return d.toLocaleDateString(APP_LOCALE, { month: 'short', day: 'numeric' });
}
// Add `n` days to an ISO date (yyyy-mm-dd) and return a new ISO. Works with
// local-calendar arithmetic so `addDaysISO('2026-05-03', 7)` → '2026-05-10'
// regardless of timezone.
function addDaysISO(iso: string, n: number): string {
  const [y, m, dd] = iso.split('-').map(Number);
  const d = new Date(y, m - 1, dd);
  d.setDate(d.getDate() + n);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const ddd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${ddd}`;
}
// Pretty label for the picker modal — "Sun May 10" + a relative chip
// ("This week" / "Next week" / "In 3 weeks" / "2 weeks ago").
function prettySunday(iso: string, todayIso: string): { label: string; relative: string } {
  const [y, m, dd] = iso.split('-').map(Number);
  const d = new Date(y, m - 1, dd);
  const label = d.toLocaleDateString(APP_LOCALE, { weekday: 'short', month: 'short', day: 'numeric' });
  const [ty, tm, td] = todayIso.split('-').map(Number);
  const today = new Date(ty, tm - 1, td);
  const diffWeeks = Math.round((d.getTime() - today.getTime()) / (7 * 24 * 3600 * 1000));
  let relative = '';
  if (diffWeeks === 0) relative = 'This week';
  else if (diffWeeks === 1) relative = 'Next week';
  else if (diffWeeks === -1) relative = 'Last week';
  else if (diffWeeks > 1) relative = `In ${diffWeeks} weeks`;
  else relative = `${Math.abs(diffWeeks)} weeks ago`;
  return { label, relative };
}
function emptyCells(): Cell[] {
  return ALL_DAYS.map((d) => ({ day: d, topic: '', presenter: '' }));
}
const slugify = (s: string) => (s || '').trim().toLowerCase();
const cellFilled = (c?: Cell) => !!c && !!((c.presenter || '').trim() || (c.topic || '').trim());
/** Days this row happens on per the office schedule (all days when unknown). */
function activeDaysOf(row: Row): number[] {
  return row.active_days && row.active_days.length ? row.active_days : ALL_DAYS;
}
/** Days the editor should render for a row: schedule-active days, plus any
 * day that already has content (a one-off), plus session-forced days. */
function visibleDaysOf(row: Row, forced?: number[]): number[] {
  const set = new Set<number>(activeDaysOf(row));
  for (const c of row.cells || []) if (cellFilled(c)) set.add(c.day);
  for (const d of forced || []) set.add(d);
  return ALL_DAYS.filter((d) => set.has(d));
}

// ──────────────────────────────────────────────────────────────────────────
export default function WeeklyPlanView() {
  const colors = useColors();
  const isDark = useTheme().effective === 'dark';
  const styles = useMemo(() => createStyles(colors, isDark), [colors, isDark]);

  const { user } = useAuth();
  // The Schedule tab's office toggle is the source of truth for which office
  // this plan belongs to. Reads AND writes both follow it: scoping only the
  // reads would render office B's plan while quietly saving into office A.
  // For everyone but a super admin `officeId` is just their own office.
  const { officeId } = useActiveOffice();
  const queryClient = useQueryClient();
  const isAdmin = user?.role === 'admin';

  const [week, setWeek] = useState<string>(thisSunday());
  // When admin wants to jump to a different Sunday (e.g. plan next week in
  // advance). We keep `week` as the source of truth for the agenda query.
  const [weekPickerOpen, setWeekPickerOpen] = useState(false);
  const todayAsSunday = useMemo(() => thisSunday(), []);
  // Admin editor mode — Fill is the weekly path, Structure the rare one,
  // Preview shows exactly what leaders will see.
  const [adminMode, setAdminMode] = useState<'fill' | 'structure' | 'preview'>('fill');
  // 'all' = compact per-row view; 0..5 = flat fill list for one day.
  const [dayFilter, setDayFilter] = useState<number | 'all'>('all');
  // Per-row collapse override in the All view. Default (undefined) = expanded
  // only while the row still has empty visible cells.
  const [expandedOverride, setExpandedOverride] = useState<Record<string, boolean>>({});
  // One-off days made visible this session (e.g. "Topic moved to Tuesday").
  const [forcedDays, setForcedDays] = useState<Record<string, number[]>>({});
  const [heroDismissed, setHeroDismissed] = useState(false);
  // Theme fields the admin opened this session beyond the office's usual set.
  const [extraThemeKeys, setExtraThemeKeys] = useState<string[]>([]);

  // `officeId` belongs in every key below, not just the URL: without it the
  // two offices share one cache entry and switching the toggle would show
  // the previous office's plan until the refetch lands.
  const q = useQuery({
    queryKey: ['agenda', week, officeId],
    queryFn: () => apiService.getAgenda(week, officeId).then((r) => r.data),
  });

  // Per-office row config (order + hidden) — the leaders' grid already
  // respects it; the Fill view now does too. Shared cache key with the grid.
  const rowConfigQ = useQuery({
    queryKey: ['agenda', 'row-config', officeId],
    queryFn: () => apiService.getAgendaRowConfig(officeId).then((r) => r.data),
    staleTime: 1000 * 30,
    enabled: isAdmin,
  });
  const hiddenSlugs = useMemo(
    () => new Set<string>(((rowConfigQ.data?.hidden_rows as string[]) || []).map(slugify)),
    [rowConfigQ.data],
  );
  const rowCfgMut = useMutation({
    mutationFn: (payload: { row_order: string[]; hidden_rows: string[] }) =>
      apiService.putAgendaRowConfig({ ...payload, office_id: officeId }).then((r) => r.data),
    onSuccess: (data) => queryClient.setQueryData(['agenda', 'row-config', officeId], data),
    onError: (e: any) => showAlert('Could not update', e?.response?.data?.detail || 'Try again'),
  });
  const toggleRowHidden = (label: string) => {
    const s = slugify(label);
    if (!s) return;
    const cur = rowConfigQ.data || { row_order: [], hidden_rows: [] };
    const hid = new Set<string>(((cur.hidden_rows as string[]) || []).map(slugify));
    if (hid.has(s)) hid.delete(s); else hid.add(s);
    rowCfgMut.mutate({ row_order: (cur.row_order as string[]) || [], hidden_rows: Array.from(hid) });
  };

  // Live bells office-sales count for the same week — drives the
  // "goal vs actual" annotation on the Weekly Goal stat in the admin editor
  // (the read-only WeeklyPlanGridView does its own fetch).
  const bellsQ = useQuery({
    queryKey: ['bells', week, officeId],
    queryFn: () => apiService.listBells(week, officeId).then((r) => r.data),
    staleTime: 1000 * 30,
  });
  const weekSales: number | null = bellsQ.data?.office_totals?.total_sales ?? null;

  // Local working copy — we mutate this in place during editing and let the
  // autosave mutation snapshot it on a debounce.
  const [draft, setDraft] = useState<Agenda | null>(null);
  const [savingState, setSavingState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const debounceRef = useRef<any>(null);

  // ── Initialize draft from server response (or seed rows if no agenda yet)
  useEffect(() => {
    if (!q.data) return;
    const a: Agenda | null = q.data.agenda;
    if (a) {
      setDraft({
        ...a,
        themes: a.themes || {},
        stats: a.stats || {},
      });
      return;
    }
    // No saved agenda yet — build a fresh draft using seed rows
    const seedRows: Row[] = (q.data.seed_rows || []).map((r: any) => ({
      id: r.id || makeId(),
      label: r.label || 'Topic',
      time_label: r.time_label || '',
      schedule_match_title: r.schedule_match_title || null,
      cells: r.cells && r.cells.length === 6 ? r.cells : emptyCells(),
      active_days: r.active_days ?? null,
    }));
    setDraft({
      id: '', office_id: officeId || user?.office_id || '', week_ending: q.data.week_ending,
      status: 'draft', themes: {}, stats: {}, rows: seedRows,
    } as any);
  }, [q.data, officeId, user?.office_id]);

  // Reset week-scoped session state when the admin jumps to another week.
  useEffect(() => {
    setForcedDays({});
    setExpandedOverride({});
    setHeroDismissed(false);
    setExtraThemeKeys([]);
  }, [week]);

  // ── Mutation: save (autosave or manual)
  const saveMut = useMutation({
    mutationFn: (payload: { week_ending: string; themes: Themes; stats: Stats; rows: Row[]; status?: 'draft' | 'preview' }) =>
      apiService.upsertAgenda({ ...payload, office_id: officeId }).then((r) => r.data),
    onMutate: () => setSavingState('saving'),
    onSuccess: (data: Agenda) => {
      setSavingState('saved');
      // Refresh query cache without re-overriding the current draft
      queryClient.setQueryData(['agenda', week, officeId], (prev: any) => prev ? { ...prev, agenda: data } : { agenda: data });
      // Update the draft id if a brand-new agenda was just created
      setDraft((d) => d && (!d.id || d.id !== data.id) ? { ...d, id: data.id, status: data.status } : d);
      // Fade the "Saved" pill
      setTimeout(() => setSavingState((s) => (s === 'saved' ? 'idle' : s)), 1500);
    },
    onError: () => setSavingState('error'),
  });

  // Debounced auto-save
  const scheduleSave = useCallback((next: Agenda) => {
    if (!isAdmin) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      saveMut.mutate({
        week_ending: next.week_ending,
        themes: next.themes,
        stats: next.stats || {},
        rows: next.rows,
      });
    }, 1200);
  }, [isAdmin, saveMut]);

  const update = (mutator: (cur: Agenda) => Agenda) => {
    setDraft((cur) => {
      if (!cur) return cur;
      const next = mutator(cur);
      scheduleSave(next);
      return next;
    });
  };

  // ── Mutations: publish + copy from last week
  const publishMut = useMutation({
    mutationFn: (id: string) => apiService.publishAgenda(id, true).then((r) => r.data),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['agenda'] });
      queryClient.invalidateQueries({ queryKey: ['schedule'] });
      showAlert('Published', `Agenda is live · ${data.schedule_blocks_filled} schedule block${data.schedule_blocks_filled === 1 ? '' : 's'} auto-filled.`);
    },
    onError: (e: any) => showAlert('Publish failed', e?.response?.data?.detail || 'Try again'),
  });
  const copyMut = useMutation({
    mutationFn: () => apiService.copyAgendaFromLastWeek(week, officeId).then((r) => r.data),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['agenda', week] });
      showAlert('Copied', `Last week's agenda was cloned (${data.rows?.length || 0} rows).`);
    },
    onError: (e: any) => showAlert('Copy failed', e?.response?.data?.detail || 'Last week may be empty'),
  });

  // Pulls schedule blocks whose titles match Plan row labels (exact or
  // alias) and drops them into the matching (day, row) cells. Empty cells
  // only by default — existing content is preserved.
  const fillMut = useMutation({
    mutationFn: (opts: { overwrite?: boolean; reset?: boolean } = {}) =>
      apiService.fillAgendaFromSchedule(week, !!opts.overwrite, !!opts.reset, officeId).then((r) => r.data),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['agenda', week] });
      const filled = data?.filled ?? 0;
      const skipped = data?.skipped ?? 0;
      if (filled === 0 && skipped === 0) {
        showAlert(
          'Synced from Schedule',
          'Rows are now in lock-step with your Schedule blocks. Add a new block (with a different title) on the Schedule tab to create a new row here.',
        );
      } else if (filled === 0 && skipped > 0) {
        showAlert(
          'All cells already filled',
          `${skipped} matching block(s) were skipped because cells already have content. Use "Overwrite" to replace.`,
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Overwrite', style: 'destructive', onPress: () => fillMut.mutate({ overwrite: true }) },
          ],
        );
      } else {
        showAlert('Filled from Schedule', `${filled} cell(s) filled${skipped ? `, ${skipped} skipped` : ''}.`);
      }
    },
    onError: (e: any) => showAlert('Fill failed', e?.response?.data?.detail || 'Try again'),
  });

  // "Reset rows from Schedule" — drops any plan rows whose label doesn't
  // match a current schedule_block title, then refills cells from the
  // blocks. Shown behind a confirmation since it deletes content.
  const onResetFromSchedule = () => {
    showAlert(
      'Reset rows from Schedule?',
      "This will replace your Plan's rows with one row per unique Schedule block title. Any cells whose row label doesn't match a current block are removed (their topic/presenter content goes too). This is the cleanest way to switch from the legacy template to schedule-driven rows.",
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Reset', style: 'destructive', onPress: () => fillMut.mutate({ reset: true, overwrite: false }) },
      ],
    );
  };

  // ── Title list for the matcher dropdown
  const titlesQ = useQuery({
    queryKey: ['agenda-schedule-titles', officeId],
    queryFn: () => apiService.listScheduleTitles(officeId).then((r) => r.data?.titles || []),
    staleTime: 60000,
  });

  // ── Scan from Photo state (hooks must be declared BEFORE any early
  // return — placed here so the hook order is stable across loading state).
  const [scanInFlight, setScanInFlight] = useState(false);
  const [scanResult, setScanResult] = useState<ScanPayload | null>(null);
  const [scanImageUri, setScanImageUri] = useState<string | null>(null);

  // ── Loading
  if (q.isLoading || !draft) {
    return (
      <View style={styles.center}>
        <BrandLoader size={48} />
      </View>
    );
  }

  // ── Header status pill
  const statusPill = (() => {
    const s = draft.status;
    if (s === 'published') return { bg: '#dcfce7', fg: '#166534', label: 'Published' };
    if (s === 'preview') return { bg: '#fef3c7', fg: '#92400e', label: 'Preview' };
    return { bg: '#EAF2DA', fg: '#21583F', label: 'Draft' };
  })();

  const onPublish = () => {
    if (!draft) {
      showAlert('Save first', 'Edit any field to create the agenda before publishing.');
      return;
    }
    showAlert(
      'Publish agenda?',
      "This will mark the agenda as live and auto-fill matching schedule blocks for the week with the topics + presenters you've entered. Empty cells are skipped — partial fills are fine.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Publish',
          onPress: async () => {
            // Flush any pending autosave before publishing so the server has
            // the very latest cells — fixes a race where typing immediately
            // followed by Publish would publish a stale snapshot.
            try {
              if (debounceRef.current) {
                clearTimeout(debounceRef.current);
                debounceRef.current = null;
              }
              const saved = await saveMut.mutateAsync({
                week_ending: draft.week_ending,
                themes: draft.themes,
                stats: draft.stats || {},
                rows: draft.rows,
              });
              publishMut.mutate(saved.id);
            } catch (e: any) {
              showAlert('Save before publish failed', e?.response?.data?.detail || 'Try again');
            }
          },
        },
      ],
    );
  };
  // ── Scan from Photo (Gemini Vision) — handlers ───────────────────────
  const runScan = async (uri: string) => {
    setScanImageUri(uri);
    setScanInFlight(true);
    try {
      const r = await apiService.scanAgendaImage({ uri, name: 'sheet.jpg', type: 'image/jpeg' }, officeId);
      setScanResult({
        themes: r.data.themes || {},
        stats: r.data.stats || {},
        rows: r.data.rows || [],
      });
    } catch (e: any) {
      const status = e?.response?.status;
      let msg = e?.response?.data?.detail || e?.message || 'Scan failed';
      // Friendlier copy for the most common failure mode: the image takes
      // longer than the deployed ingress timeout (~60s) to OCR.
      if (status === 504 || /timed? ?out|504/i.test(String(msg))) {
        msg = 'The scan took too long. Try retaking the photo closer, better-lit, or cropped tighter to the sheet — large blurry photos take longest.';
      }
      showAlert('Scan failed', String(msg));
      setScanImageUri(null);
    } finally {
      setScanInFlight(false);
    }
  };

  const onScanFromPhoto = () => {
    if (!isAdmin) return;
    showAlert(
      'Scan handwritten plan',
      'Use Gemini Vision to extract themes, stats, and the daily grid from a photo of your weekly planner sheet.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Take Photo', onPress: async () => {
          const perm = await ImagePicker.requestCameraPermissionsAsync();
          if (!perm.granted) { showAlert('Permission needed', 'Please allow camera access to take a photo.'); return; }
          const res = await ImagePicker.launchCameraAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.85 });
          if (!res.canceled && res.assets?.[0]?.uri) await runScan(res.assets[0].uri);
        } },
        { text: 'Choose from Library', onPress: async () => {
          const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
          if (!perm.granted) { showAlert('Permission needed', 'Please allow photo access to pick an image.'); return; }
          const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.85 });
          if (!res.canceled && res.assets?.[0]?.uri) await runScan(res.assets[0].uri);
        } },
      ],
    );
  };

  const applyScanSelection = (result: ApplyResult) => {
    update((c) => {
      const nextThemes = { ...(c.themes || {}), ...result.themes };
      const nextStats = { ...(c.stats || {}), ...result.stats };
      const nextRows = c.rows.map((row) => {
        const m = result.rowCells.find((rc) => rc.rowLabel.toLowerCase() === row.label.toLowerCase());
        if (!m) return row;
        const updated = row.cells.map((cell) => m.cellsToApply[cell.day] || cell);
        return { ...row, cells: updated };
      });
      return { ...c, themes: nextThemes, stats: nextStats, rows: nextRows };
    });
    // Persist the admin's "raw_label → target Plan row" decisions so the
    // next scan auto-picks the same target. Empty target removes a saved
    // mapping (admin chose Skip).
    if (result.mappings && Object.keys(result.mappings).length > 0) {
      apiService.saveScanMappings(result.mappings, officeId).catch(() => {
        // Non-fatal — apply still succeeded; just lose persistence.
      });
    }
    setScanResult(null);
    setScanImageUri(null);
  };

  const onAddRow = () => {
    update((c) => ({
      ...c,
      rows: [...c.rows, { id: makeId(), label: 'New Topic', time_label: '', schedule_match_title: null, cells: emptyCells(), active_days: null }],
    }));
  };
  const onRemoveRow = (rowId: string) => {
    update((c) => ({ ...c, rows: c.rows.filter((r) => r.id !== rowId) }));
  };
  const updateRow = (rowId: string, next: Row) => {
    update((c) => ({ ...c, rows: c.rows.map((r) => (r.id === rowId ? next : r)) }));
  };
  const forceDay = (rowId: string, day: number) => {
    setForcedDays((cur) => {
      const list = cur[rowId] || [];
      if (list.includes(day)) return cur;
      return { ...cur, [rowId]: [...list, day] };
    });
  };

  // Leaders / non-admins → see only the published, read-only grid view.
  // If nothing is published yet for the requested week, the backend
  // automatically falls back to the most recently published agenda for the
  // office (q.data.fallback_to_latest_published === true).
  if (!isAdmin) {
    const isPublished = draft.status === 'published';
    const fellBack = !!q.data?.fallback_to_latest_published;
    return (
      <View style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={{ padding: 12, paddingBottom: 24 }}
          refreshControl={<RefreshControl refreshing={q.isFetching} onRefresh={() => q.refetch()} tintColor={colors.primary} />}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              <View style={styles.kickerRow}>
                <LinearGradient
                  pointerEvents="none"
                  colors={GRADIENT}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.kickerBar}
                />
                <Text style={styles.kicker} numberOfLines={2}>{fellBack ? 'Latest Published Plan' : "This Week's Plan"}</Text>
              </View>
              <Text style={styles.subtitle}>Week ending {shortDate(draft.week_ending)}</Text>
            </View>
            {isPublished && (
              <View style={[styles.statusPill, { backgroundColor: '#dcfce7' }]}>
                <Text style={[styles.statusPillText, { color: '#166534' }]}>Published</Text>
              </View>
            )}
          </View>

          {fellBack && isPublished && (
            <View style={styles.fallbackBanner}>
              <Ionicons name="information-circle" size={16} color={isDark ? '#7DD3FC' : '#0369a1'} />
              <Text style={styles.fallbackText} numberOfLines={2}>
                Showing the most recent published plan. Your admin hasn't published this week's plan yet.
              </Text>
            </View>
          )}

          {!isPublished ? (
            <DepthCard sheen={false} style={styles.notPublishedCard}>
              <Ionicons name="time-outline" size={28} color={colors.textMuted} />
              <Text style={styles.notPublishedTitle}>Not yet published</Text>
              <Text style={styles.notPublishedText}>
                Your admin is still finalising the weekly plan. Check back soon — you'll
                see the full schedule of themes, topics, and presenters here.
              </Text>
            </DepthCard>
          ) : (
            <WeeklyPlanGridView themes={draft.themes} stats={draft.stats || {}} rows={draft.rows} weekEnding={draft.week_ending} isAdmin={isAdmin} />
          )}
        </ScrollView>
      </View>
    );
  }

  // ── Admin derived state ──────────────────────────────────────────────
  // Rows that participate in weekly Fill: labelled + not hidden by config.
  const fillRows = draft.rows.filter((r) => (r.label || '').trim() && !hiddenSlugs.has(slugify(r.label)));
  const hiddenRowCount = draft.rows.filter((r) => (r.label || '').trim() && hiddenSlugs.has(slugify(r.label))).length;

  const dayProgress = ALL_DAYS.map((d) => {
    let total = 0, filled = 0;
    for (const r of fillRows) {
      if (!visibleDaysOf(r, forcedDays[r.id]).includes(d)) continue;
      total++;
      if (cellFilled(r.cells.find((c) => c.day === d))) filled++;
    }
    return { total, filled };
  });
  const weekTotals = dayProgress.reduce((acc, p) => ({ total: acc.total + p.total, filled: acc.filled + p.filled }), { total: 0, filled: 0 });

  // Theme fields this office actually uses: content this week, non-empty in
  // the latest published plan, or explicitly opened this session.
  const themesInUse: string[] = q.data?.themes_in_use || [];
  const usedThemeKeys = new Set<string>(extraThemeKeys);
  for (const f of THEMES_FIELDS) {
    if ((draft.themes[f.key] || '').trim() || themesInUse.includes(f.key)) usedThemeKeys.add(f.key);
  }
  const shownThemeFields = THEMES_FIELDS.filter((f) => usedThemeKeys.has(f.key));
  const hiddenThemeFields = THEMES_FIELDS.filter((f) => !usedThemeKeys.has(f.key));

  // "Start this week" hero — only when nothing is saved for this week yet.
  const showHero = !draft.id && !heroDismissed;

  // Admins → Fill | Structure | Preview.
  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={{ padding: 12, paddingBottom: 24 }}
        refreshControl={<RefreshControl refreshing={q.isFetching} onRefresh={() => q.refetch()} tintColor={colors.primary} />}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header row */}
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <View style={styles.kickerRow}>
              <LinearGradient
                pointerEvents="none"
                colors={GRADIENT}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.kickerBar}
              />
              <Text style={styles.kicker} numberOfLines={2}>Weekly Agenda</Text>
            </View>
            {/* Week switcher — admins can jump forward to plan a future week
                in advance, or back to tweak a past one. Prev/next arrows for
                one-tap nav, middle tap opens a full Sunday picker. */}
            <View style={styles.weekSwitcher}>
              <TouchableOpacity
                onPress={() => setWeek(addDaysISO(week, -7))}
                style={styles.weekArrow}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                testID="weekly-plan-prev-week"
              >
                <Ionicons name="chevron-back" size={16} color={colors.textMuted} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setWeekPickerOpen(true)}
                style={styles.weekCenter}
                testID="weekly-plan-open-picker"
              >
                <Ionicons name="calendar-outline" size={13} color={colors.textMuted} />
                <Text style={styles.weekCenterText}>
                  Week ending {shortDate(week)}
                </Text>
                {week !== todayAsSunday && (
                  <View style={styles.weekRelChip}>
                    <Text style={styles.weekRelChipText}>
                      {prettySunday(week, todayAsSunday).relative}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setWeek(addDaysISO(week, 7))}
                style={styles.weekArrow}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                testID="weekly-plan-next-week"
              >
                <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
          </View>
          <View style={[styles.statusPill, { backgroundColor: statusPill.bg }]}>
            <Text style={[styles.statusPillText, { color: statusPill.fg }]}>{statusPill.label}</Text>
          </View>
          {savingState !== 'idle' && (
            <View style={styles.saveDot}>
              {savingState === 'saving' && <ActivityIndicator color={colors.textMuted} size="small" />}
              {savingState === 'saved' && <Ionicons name="checkmark-circle" size={16} color="#22c55e" />}
              {savingState === 'error' && <Ionicons name="alert-circle" size={16} color="#dc2626" />}
            </View>
          )}
        </View>

        {/* Fill | Structure | Preview toggle (admin only) — the system's liquid
            segmented rail (spec §3.13) in the paper tone, so it reads as a
            sub-control beneath the screen's own ink WEEK / DAY / PLAN rail. */}
        <SlidingSegments
          tone="paper"
          style={styles.modeToggle}
          value={adminMode}
          onChange={(k) => setAdminMode(k as 'fill' | 'structure' | 'preview')}
          items={[
            { key: 'fill', label: 'Fill', testID: 'weekly-plan-mode-fill' },
            { key: 'structure', label: 'Structure', testID: 'weekly-plan-mode-structure' },
            { key: 'preview', label: 'Preview', testID: 'weekly-plan-mode-preview' },
          ]}
        />

        {adminMode === 'preview' && (
          <>
            {draft.status !== 'published' && (
              <View style={styles.previewBanner}>
                <Ionicons name="information-circle" size={14} color={isDark ? '#7DD3FC' : '#0c4a6e'} />
                <Text style={styles.previewBannerText}>
                  This is what coaches will see once you Publish. Right now they see a "Not yet published" message.
                </Text>
              </View>
            )}
            <WeeklyPlanGridView themes={draft.themes} stats={draft.stats || {}} rows={draft.rows} weekEnding={draft.week_ending} isAdmin={isAdmin} />
          </>
        )}

        {adminMode === 'structure' && (
          <>
            <View style={styles.structInfo}>
              <Ionicons name="information-circle-outline" size={14} color={colors.textMuted} />
              <Text style={styles.structInfoText}>
                The plan's layout — rows, times, and schedule matching. This rarely changes week to week;
                weekly topics and presenters live in Fill.
              </Text>
            </View>

            <View style={styles.cardHeaderRow}>
              <View style={[styles.cardHeader, { flex: 1, marginBottom: 0 }]}>
                <Ionicons name="grid-outline" size={16} color={colors.primary} />
                <Text style={styles.cardTitle}>Rows</Text>
              </View>
              <TouchableOpacity
                style={[styles.btnLight, fillMut.isPending && { opacity: 0.5 }]}
                onPress={() => fillMut.mutate({})}
                disabled={fillMut.isPending}
              >
                <Ionicons name="calendar-outline" size={13} color={colors.primary} />
                <Text style={styles.btnLightText}>{fillMut.isPending ? 'Filling…' : 'Fill from Schedule'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.btnLight} onPress={onResetFromSchedule}>
                <Ionicons name="refresh" size={13} color="#dc2626" />
                <Text style={[styles.btnLightText, { color: '#dc2626' }]}>Reset rows</Text>
              </TouchableOpacity>
            </View>

            {draft.rows.map((row) => (
              <StructureRowCard
                key={row.id}
                row={row}
                titles={titlesQ.data || []}
                hidden={hiddenSlugs.has(slugify(row.label))}
                onToggleHidden={() => toggleRowHidden(row.label)}
                onUpdate={(next) => updateRow(row.id, next)}
                onRemove={() => onRemoveRow(row.id)}
              />
            ))}

            <PressableScale style={styles.addRowBtn} onPress={onAddRow}>
              <Ionicons name="add-circle-outline" size={18} color={colors.primary} />
              <Text style={styles.addRowBtnText}>Add row</Text>
            </PressableScale>

            <Text style={styles.structFootnote}>
              Hidden rows stay out of the Fill view and the coaches' plan, but keep their saved content.
              Drag-to-reorder lives in Preview → Manage Rows.
            </Text>
          </>
        )}

        {adminMode === 'fill' && (
          <>
            {/* Start-this-week hero — the 99% flow, one tap then edit deltas */}
            {showHero && (
              <DepthCard edge="gradient" sheen={false} style={styles.heroCard}>
                <Text style={styles.heroTitle}>Start this week's plan</Text>
                <Text style={styles.heroSub}>
                  Most weeks barely change — start from last week and just edit what's different.
                </Text>
                <GlowButton
                  sheen={false}
                  style={[styles.heroBtnPrimary, copyMut.isPending && { opacity: 0.6 }]}
                  onPress={() => copyMut.mutate()}
                  disabled={copyMut.isPending}
                >
                  <Ionicons name="copy-outline" size={16} color={colors.onPrimary} />
                  <Text style={styles.heroBtnPrimaryText}>{copyMut.isPending ? 'Copying…' : 'Copy last week'}</Text>
                </GlowButton>
                <View style={styles.heroBtnRow}>
                  <PressableScale
                    style={[styles.heroBtnLight, fillMut.isPending && { opacity: 0.6 }]}
                    onPress={() => fillMut.mutate({})}
                    disabled={fillMut.isPending}
                  >
                    <Ionicons name="calendar-outline" size={14} color={colors.primary} />
                    <Text style={styles.heroBtnLightText}>Fill from Schedule</Text>
                  </PressableScale>
                  <PressableScale style={styles.heroBtnLight} onPress={onScanFromPhoto}>
                    <Ionicons name="camera-outline" size={14} color={colors.primary} />
                    <Text style={styles.heroBtnLightText}>Scan photo</Text>
                  </PressableScale>
                </View>
                <TouchableOpacity onPress={() => setHeroDismissed(true)} style={styles.heroDismiss}>
                  <Text style={styles.heroDismissText}>Start blank instead</Text>
                </TouchableOpacity>
              </DepthCard>
            )}

            {/* Weekly Stats card */}
            <DepthCard sheen={false} style={styles.card}>
              <View style={styles.cardHeader}>
                <Ionicons name="speedometer-outline" size={16} color={colors.primary} />
                <Text style={styles.cardTitle}>Weekly Stats</Text>
              </View>
              <View style={styles.statsGrid}>
                {STATS_FIELDS.map((s) => {
                  const isGoal = s.key === 'weekly_goal';
                  const goalRaw = (draft.stats?.weekly_goal ?? '').toString().trim();
                  const goalMatch = goalRaw.match(/\d[\d,]*/);
                  const goalNum = goalMatch ? parseInt(goalMatch[0].replace(/,/g, ''), 10) : null;
                  const pct = (isGoal && goalNum && goalNum > 0 && weekSales != null)
                    ? Math.round((weekSales / goalNum) * 100)
                    : null;
                  const hit = pct != null && pct >= 100;
                  return (
                    <View key={s.key} style={[styles.statField, { borderLeftColor: s.color }]}>
                      <View style={styles.statRow}>
                        <Ionicons name={s.icon} size={11} color={s.color} />
                        <Text style={[styles.statLabel, { color: s.color }]}>{s.label.toUpperCase()}</Text>
                      </View>
                      <TextInput
                        value={draft.stats?.[s.key] || ''}
                        onChangeText={(v) => update((c) => ({ ...c, stats: { ...(c.stats || {}), [s.key]: v } }))}
                        style={styles.statInput}
                        placeholder={s.placeholder}
                        placeholderTextColor={colors.textMuted}
                        keyboardType="default"
                      />
                      {isGoal && weekSales != null && (
                        <View style={styles.goalActualRow}>
                          <Ionicons
                            name={hit ? 'checkmark-circle' : 'pulse'}
                            size={10}
                            color={hit ? '#16a34a' : colors.textMuted}
                          />
                          <Text style={[styles.goalActualText, hit && { color: '#16a34a', fontWeight: '800' }]}>
                            {hit ? `${weekSales} — GOAL HIT 🎯` : `${weekSales} so far${pct != null ? ` · ${pct}%` : ''}`}
                          </Text>
                        </View>
                      )}
                      {isGoal && weekSales == null && bellsQ.isLoading && (
                        <Text style={styles.goalActualLoading}>loading sign-ups…</Text>
                      )}
                    </View>
                  );
                })}
              </View>
            </DepthCard>

            {/* Themes editor — only the fields this office actually uses;
                the rest wait behind "+ field" chips instead of taking scroll. */}
            <DepthCard sheen={false} style={styles.card}>
              <View style={styles.cardHeader}>
                <Ionicons name="bookmark-outline" size={16} color={colors.primary} />
                <Text style={styles.cardTitle}>Themes</Text>
              </View>
              {shownThemeFields.length === 0 && (
                <Text style={styles.themesEmptyHint}>Tap a field below to add it to this week's plan.</Text>
              )}
              <View style={styles.themesGrid}>
                {shownThemeFields.map((f) => (
                  <View key={f.key} style={styles.themeField}>
                    <Text style={styles.themeLabel}>{f.label}</Text>
                    <TextInput
                      value={draft.themes[f.key] || ''}
                      onChangeText={(v) => update((c) => ({ ...c, themes: { ...c.themes, [f.key]: v } }))}
                      style={styles.themeInput}
                      placeholder={f.placeholder}
                      placeholderTextColor={colors.textMuted}
                      multiline
                    />
                  </View>
                ))}
              </View>
              {hiddenThemeFields.length > 0 && (
                <View style={styles.themeChipsRow}>
                  {hiddenThemeFields.map((f) => (
                    <PressableScale
                      key={f.key}
                      style={styles.themeChip}
                      onPress={() => setExtraThemeKeys((cur) => cur.includes(f.key) ? cur : [...cur, f.key])}
                    >
                      <Ionicons name="add" size={12} color={colors.primary} />
                      <Text style={styles.themeChipText}>{f.label}</Text>
                    </PressableScale>
                  ))}
                </View>
              )}
            </DepthCard>

            {/* Topics & Presenters header + toolbar */}
            <View style={styles.cardHeaderRow}>
              <View style={[styles.cardHeader, { flex: 1, marginBottom: 0 }]}>
                <Ionicons name="list-outline" size={16} color={colors.primary} />
                <Text style={styles.cardTitle}>Topics & Presenters</Text>
              </View>
              <TouchableOpacity style={styles.btnLight} onPress={onScanFromPhoto}>
                <Ionicons name="camera-outline" size={13} color={colors.primary} />
                <Text style={styles.btnLightText}>Scan</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.btnLight} onPress={() => copyMut.mutate()} disabled={copyMut.isPending}>
                <Ionicons name="copy-outline" size={13} color={colors.primary} />
                <Text style={styles.btnLightText}>Copy last week</Text>
              </TouchableOpacity>
            </View>

            {/* Day chips — filter + at-a-glance progress per day */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.dayChipsRow}>
              <PressableScale
                style={[styles.dayChip, dayFilter === 'all' && styles.dayChipSelected]}
                onPress={() => setDayFilter('all')}
              >
                <Text style={[styles.dayChipLabel, dayFilter === 'all' && styles.dayChipLabelSelected]}>All</Text>
                <Text style={[styles.dayChipCount, dayFilter === 'all' && styles.dayChipCountSelected]}>
                  {weekTotals.filled}/{weekTotals.total}
                </Text>
              </PressableScale>
              {ALL_DAYS.map((d) => {
                const p = dayProgress[d];
                const selected = dayFilter === d;
                const complete = p.total > 0 && p.filled >= p.total;
                return (
                  <PressableScale
                    key={d}
                    testID={`weekly-plan-day-${d}`}
                    style={[
                      styles.dayChip,
                      complete && !selected && styles.dayChipComplete,
                      selected && styles.dayChipSelected,
                    ]}
                    onPress={() => setDayFilter(selected ? 'all' : d)}
                  >
                    <Text style={[styles.dayChipLabel, complete && !selected && { color: DONE_FG(isDark) }, selected && styles.dayChipLabelSelected]}>
                      {DAY_LABELS[d]}
                    </Text>
                    <Text style={[styles.dayChipCount, complete && !selected && { color: DONE_FG_SOFT(isDark) }, selected && styles.dayChipCountSelected]}>
                      {p.total === 0 ? '—' : complete ? '✓' : `${p.filled}/${p.total}`}
                    </Text>
                  </PressableScale>
                );
              })}
            </ScrollView>

            {fillRows.length === 0 ? (
              <View style={styles.empty}>
                <Ionicons name="calendar-clear-outline" size={36} color={colors.textMuted} />
                <Text style={styles.emptyText}>No rows yet. Add rows in Structure, or Fill from Schedule.</Text>
              </View>
            ) : dayFilter === 'all' ? (
              // ── All-week view: compact rows showing only their real days
              fillRows.map((row) => {
                const visDays = visibleDaysOf(row, forcedDays[row.id]);
                const filledCount = visDays.filter((d) => cellFilled(row.cells.find((c) => c.day === d))).length;
                const complete = visDays.length > 0 && filledCount >= visDays.length;
                const expanded = expandedOverride[row.id] ?? !complete;
                return (
                  <FillRowCard
                    key={row.id}
                    row={row}
                    visDays={visDays}
                    filledCount={filledCount}
                    complete={complete}
                    expanded={expanded}
                    onToggle={() => setExpandedOverride((cur) => ({ ...cur, [row.id]: !expanded }))}
                    onUpdate={(next) => updateRow(row.id, next)}
                    onForceDay={(d) => forceDay(row.id, d)}
                  />
                );
              })
            ) : (
              // ── Single-day view: flat checklist of that day's slots
              <DayFillList
                day={dayFilter}
                rows={fillRows}
                forcedDays={forcedDays}
                onUpdate={updateRow}
                onForceDay={forceDay}
              />
            )}

            {hiddenRowCount > 0 && (
              <TouchableOpacity style={styles.hiddenNote} onPress={() => setAdminMode('structure')}>
                <Ionicons name="eye-off-outline" size={13} color={colors.textMuted} />
                <Text style={styles.hiddenNoteText}>
                  {hiddenRowCount} hidden row{hiddenRowCount === 1 ? '' : 's'} — manage in Structure
                </Text>
              </TouchableOpacity>
            )}

            {/* Publish actions */}
            <View style={styles.publishRow}>
              <GlowButton sheen={false} style={[styles.btnPrimary, publishMut.isPending && { opacity: 0.6 }]} onPress={onPublish} disabled={publishMut.isPending}>
                <Ionicons name="rocket" size={16} color={colors.onPrimary} />
                <Text style={styles.btnPrimaryText}>{publishMut.isPending ? 'Publishing…' : 'Publish'}</Text>
              </GlowButton>
            </View>
          </>
        )}
      </ScrollView>

      {/* Scan from Photo overlays — admin only */}
      <ScanInFlightOverlay visible={scanInFlight} />
      <AgendaScanReviewSheet
        visible={!!scanResult}
        scan={scanResult}
        draftThemes={draft.themes || {}}
        draftStats={draft.stats || {}}
        draftRows={draft.rows.map((r) => ({ id: r.id, label: r.label, cells: r.cells }))}
        imageUri={scanImageUri}
        onCancel={() => { setScanResult(null); setScanImageUri(null); }}
        onApply={applyScanSelection}
      />

      {/* Week-ending picker — lets admin jump to any Sunday (past or future) */}
      <WeekEndingPicker
        visible={weekPickerOpen}
        currentWeek={week}
        todayWeek={todayAsSunday}
        onSelect={(w) => { setWeek(w); setWeekPickerOpen(false); }}
        onClose={() => setWeekPickerOpen(false)}
      />
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Week-Ending Picker — bottom-sheet modal listing Sundays from 4 weeks back
// to 12 weeks ahead. Admin taps one to change the weekly plan's target week.
// ─────────────────────────────────────────────────────────────────────────
function WeekEndingPicker({
  visible, currentWeek, todayWeek, onSelect, onClose,
}: {
  visible: boolean;
  currentWeek: string;
  todayWeek: string;
  onSelect: (w: string) => void;
  onClose: () => void;
}) {
  const colors = useColors();
  const isDark = useTheme().effective === 'dark';
  const styles = useMemo(() => createStyles(colors, isDark), [colors, isDark]);
  const sundays = useMemo(() => {
    const list: string[] = [];
    for (let i = -4; i <= 12; i++) list.push(addDaysISO(todayWeek, i * 7));
    return list;
  }, [todayWeek]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.pickerOverlay} onPress={onClose}>
        <Pressable style={styles.pickerSheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.pickerHandle} />
          <View style={styles.pickerHeader}>
            <Text style={styles.pickerTitle}>Pick a week</Text>
            <TouchableOpacity onPress={onClose} style={styles.pickerClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={20} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          <Text style={styles.pickerSubtitle}>
            Pick the Sunday that ends the week you're planning. You can get a draft ready now and publish it later.
          </Text>
          <ScrollView style={{ maxHeight: 460 }} contentContainerStyle={{ paddingBottom: 10 }}>
            {sundays.map((s) => {
              const isSelected = s === currentWeek;
              const isToday = s === todayWeek;
              const meta = prettySunday(s, todayWeek);
              return (
                <TouchableOpacity
                  key={s}
                  onPress={() => onSelect(s)}
                  style={[styles.pickerRow, isSelected && styles.pickerRowSelected]}
                  testID={`weekly-plan-week-${s}`}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.pickerRowText, isSelected && styles.pickerRowTextSelected]}>
                      {meta.label}
                    </Text>
                    <Text style={[styles.pickerRowMeta, isSelected && { color: '#fff' }]}>
                      {meta.relative}{isToday ? ' · today\'s week' : ''}
                    </Text>
                  </View>
                  {isSelected && <Ionicons name="checkmark-circle" size={18} color="#fff" />}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Fill · All-week view — one compact card per row, collapsed to a summary
// line when complete, expanded to only the days it actually happens on.
// ─────────────────────────────────────────────────────────────────────────
function FillRowCard({
  row, visDays, filledCount, complete, expanded, onToggle, onUpdate, onForceDay,
}: {
  row: Row; visDays: number[]; filledCount: number; complete: boolean; expanded: boolean;
  onToggle: () => void; onUpdate: (r: Row) => void; onForceDay: (d: number) => void;
}) {
  const colors = useColors();
  const isDark = useTheme().effective === 'dark';
  const styles = useMemo(() => createStyles(colors, isDark), [colors, isDark]);
  const [addOpen, setAddOpen] = useState(false);
  const activeDays = activeDaysOf(row);
  const addableDays = ALL_DAYS.filter((d) => !visDays.includes(d));
  const setCell = (day: number, patch: Partial<Cell>) => {
    onUpdate({ ...row, cells: row.cells.map((c) => c.day === day ? { ...c, ...patch } : c) });
  };

  return (
    <DepthCard sheen={false} style={styles.rowCard}>
      <TouchableOpacity style={styles.fillRowHead} onPress={onToggle} activeOpacity={0.7}>
        <Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={14} color={colors.textMuted} />
        <Text style={styles.fillRowLabel} numberOfLines={1}>{row.label}</Text>
        {!!row.time_label && <Text style={styles.fillRowTime}>{row.time_label}</Text>}
        <View style={[styles.fillRowPill, complete && styles.fillRowPillDone]}>
          <Text style={[styles.fillRowPillText, complete && styles.fillRowPillTextDone]}>
            {complete ? '✓' : `${filledCount}/${visDays.length}`}
          </Text>
        </View>
      </TouchableOpacity>

      {expanded && (
        <>
          {visDays.map((d) => {
            const cell = row.cells.find((c) => c.day === d) || { day: d, topic: '', presenter: '' };
            const filled = cellFilled(cell);
            const oneOff = !activeDays.includes(d);
            return (
              <View key={d} style={[styles.cell, filled && styles.cellFilled]}>
                <View style={{ width: 42, paddingTop: 6 }}>
                  <Text style={[styles.cellDay, filled && { color: colors.primary }]}>{DAY_LABELS[d]}</Text>
                  {oneOff && (
                    <View style={styles.oneOffTag}>
                      <Text style={styles.oneOffTagText}>1-off</Text>
                    </View>
                  )}
                </View>
                <View style={{ flex: 1 }}>
                  {/* Presenter is the primary input — bold, larger */}
                  <TextInput
                    value={cell.presenter}
                    onChangeText={(v) => setCell(d, { presenter: v })}
                    style={styles.cellPresenterInput}
                    placeholder="Presenter"
                    placeholderTextColor={colors.textMuted}
                  />
                  {/* Topic is the optional secondary detail — smaller, lighter */}
                  <TextInput
                    value={cell.topic}
                    onChangeText={(v) => setCell(d, { topic: v })}
                    style={styles.cellTopicInput}
                    placeholder="Topic (optional)"
                    placeholderTextColor={colors.textMuted}
                  />
                </View>
              </View>
            );
          })}

          {/* Rare case: something lands on a day it normally doesn't */}
          {addableDays.length > 0 && (
            addOpen ? (
              <View style={styles.addDayRow}>
                {addableDays.map((d) => (
                  <TouchableOpacity key={d} style={styles.addDayChip} onPress={() => { onForceDay(d); setAddOpen(false); }}>
                    <Text style={styles.addDayChipText}>{DAY_LABELS[d]}</Text>
                  </TouchableOpacity>
                ))}
                <TouchableOpacity style={{ padding: 4 }} onPress={() => setAddOpen(false)}>
                  <Ionicons name="close" size={14} color={colors.textMuted} />
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity style={styles.addDayLink} onPress={() => setAddOpen(true)}>
                <Ionicons name="add" size={13} color={colors.textMuted} />
                <Text style={styles.addDayLinkText}>Add another day (one-off)</Text>
              </TouchableOpacity>
            )
          )}
        </>
      )}
    </DepthCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Fill · single-day view — a flat checklist of just this day's slots.
// ─────────────────────────────────────────────────────────────────────────
function DayFillList({
  day, rows, forcedDays, onUpdate, onForceDay,
}: {
  day: number; rows: Row[]; forcedDays: Record<string, number[]>;
  onUpdate: (rowId: string, r: Row) => void; onForceDay: (rowId: string, d: number) => void;
}) {
  const colors = useColors();
  const isDark = useTheme().effective === 'dark';
  const styles = useMemo(() => createStyles(colors, isDark), [colors, isDark]);
  const slots = rows.filter((r) => visibleDaysOf(r, forcedDays[r.id]).includes(day));
  const offDay = rows.filter((r) => !visibleDaysOf(r, forcedDays[r.id]).includes(day));
  const filledCount = slots.filter((r) => cellFilled(r.cells.find((c) => c.day === day))).length;

  return (
    <View>
      <View style={styles.dayHeader}>
        <Text style={styles.dayHeaderTitle}>{DAY_FULL[day]}</Text>
        <Text style={styles.dayHeaderCount}>
          {slots.length === 0 ? 'nothing scheduled' : `${filledCount} of ${slots.length} filled`}
        </Text>
      </View>

      {slots.map((row) => {
        const cell = row.cells.find((c) => c.day === day) || { day, topic: '', presenter: '' };
        const filled = cellFilled(cell);
        const oneOff = !activeDaysOf(row).includes(day);
        const setCell = (patch: Partial<Cell>) => {
          onUpdate(row.id, { ...row, cells: row.cells.map((c) => c.day === day ? { ...c, ...patch } : c) });
        };
        return (
          <DepthCard key={row.id} sheen={false} style={[styles.slotCard, filled && styles.slotCardFilled]}>
            <View style={styles.slotHead}>
              {!!row.time_label && <Text style={styles.slotTime}>{row.time_label}</Text>}
              <Text style={styles.slotLabel} numberOfLines={1}>{row.label}</Text>
              {oneOff && (
                <View style={styles.oneOffTag}>
                  <Text style={styles.oneOffTagText}>1-off</Text>
                </View>
              )}
              {filled && <Ionicons name="checkmark-circle" size={15} color="#16a34a" />}
            </View>
            <TextInput
              value={cell.presenter}
              onChangeText={(v) => setCell({ presenter: v })}
              style={styles.cellPresenterInput}
              placeholder="Presenter"
              placeholderTextColor={colors.textMuted}
            />
            <TextInput
              value={cell.topic}
              onChangeText={(v) => setCell({ topic: v })}
              style={styles.cellTopicInput}
              placeholder="Topic (optional)"
              placeholderTextColor={colors.textMuted}
            />
          </DepthCard>
        );
      })}

      {/* One-offs: pull a row that doesn't normally run this day */}
      {offDay.length > 0 && (
        <View style={styles.oneOffSection}>
          <Text style={styles.oneOffSectionTitle}>Add a one-off to {DAY_FULL[day]}</Text>
          <View style={styles.oneOffChipsRow}>
            {offDay.map((r) => (
              <TouchableOpacity key={r.id} style={styles.oneOffChip} onPress={() => onForceDay(r.id, day)}>
                <Ionicons name="add" size={12} color={colors.primary} />
                <Text style={styles.oneOffChipText} numberOfLines={1}>{r.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Structure · one row's layout config — label, time, schedule match, hide.
// ─────────────────────────────────────────────────────────────────────────
function StructureRowCard({
  row, titles, hidden, onToggleHidden, onUpdate, onRemove,
}: {
  row: Row; titles: string[]; hidden: boolean;
  onToggleHidden: () => void; onUpdate: (r: Row) => void; onRemove: () => void;
}) {
  const colors = useColors();
  const isDark = useTheme().effective === 'dark';
  const styles = useMemo(() => createStyles(colors, isDark), [colors, isDark]);
  const mat = useMemo(() => createMat(colors), [colors]);
  const [matcherOpen, setMatcherOpen] = useState(false);
  const activeDays = row.active_days && row.active_days.length ? row.active_days : null;

  return (
    <DepthCard sheen={false} style={[styles.rowCard, hidden && { opacity: 0.55 }]}>
      <View style={styles.rowHead}>
        <View style={styles.rowHeadLeft}>
          <TextInput
            value={row.label}
            onChangeText={(v) => onUpdate({ ...row, label: v })}
            style={styles.rowLabelInput}
            placeholder="Row label"
            placeholderTextColor={colors.textMuted}
          />
          <TextInput
            value={row.time_label}
            onChangeText={(v) => onUpdate({ ...row, time_label: v })}
            style={styles.rowTimeInput}
            placeholder="Time"
            placeholderTextColor={colors.textMuted}
          />
        </View>
        <TouchableOpacity onPress={onToggleHidden} hitSlop={8} style={{ padding: 4 }}>
          <Ionicons name={hidden ? 'eye-off-outline' : 'eye-outline'} size={16} color={hidden ? '#dc2626' : colors.textMuted} />
        </TouchableOpacity>
        <TouchableOpacity onPress={onRemove} hitSlop={8} style={{ padding: 4 }}>
          <Ionicons name="trash-outline" size={16} color="#dc2626" />
        </TouchableOpacity>
      </View>

      {/* Which days this row actually runs (from the Schedule tab) */}
      <View style={styles.activeDaysRow}>
        <Ionicons name="today-outline" size={12} color={colors.textMuted} />
        <Text style={styles.activeDaysText}>
          {activeDays ? activeDays.map((d) => DAY_LABELS[d]).join(' · ') : 'Every day (no schedule match)'}
        </Text>
      </View>

      {/* Matcher chip */}
      <TouchableOpacity style={styles.matchRow} onPress={() => setMatcherOpen(true)}>
        <Ionicons name="link-outline" size={13} color={colors.textMuted} />
        <Text style={styles.matchText} numberOfLines={1}>
          {row.schedule_match_title
            ? <>Auto-fill matches: <Text style={{ color: colors.primary, fontWeight: '700' }}>{row.schedule_match_title}</Text></>
            : 'No schedule match — tap to link'}
        </Text>
        <Ionicons name="chevron-forward" size={13} color={colors.textMuted} />
      </TouchableOpacity>

      {/* Title-picker sheet */}
      {matcherOpen && (
        <Modal visible animationType="slide" transparent onRequestClose={() => setMatcherOpen(false)}>
          <Pressable style={mat.backdrop} onPress={() => setMatcherOpen(false)}>
            <Pressable style={mat.sheet} onPress={() => {}}>
              <View style={mat.grip} />
              <Text style={mat.title}>Match this row to a Schedule block title</Text>
              <Text style={mat.sub}>When you publish, the topic + presenter you've typed for each day get auto-filled into the schedule block(s) with this title on that day.</Text>
              <ScrollView style={{ maxHeight: 320 }}>
                <TouchableOpacity style={mat.opt} onPress={() => { onUpdate({ ...row, schedule_match_title: null }); setMatcherOpen(false); }}>
                  <Ionicons name="close-circle-outline" size={16} color={colors.textMuted} />
                  <Text style={[mat.optText, { color: colors.textMuted }]}>No match (don't auto-fill)</Text>
                </TouchableOpacity>
                {(titles || []).map((t) => {
                  const sel = row.schedule_match_title === t;
                  return (
                    <TouchableOpacity key={t} style={[mat.opt, sel && mat.optSel]} onPress={() => { onUpdate({ ...row, schedule_match_title: t }); setMatcherOpen(false); }}>
                      <Ionicons name={sel ? 'checkmark-circle' : 'ellipse-outline'} size={16} color={sel ? colors.primary : colors.textMuted} />
                      <Text style={[mat.optText, sel && { color: colors.primary, fontWeight: '700' }]}>{t}</Text>
                    </TouchableOpacity>
                  );
                })}
                {(!titles || titles.length === 0) && (
                  <Text style={{ color: colors.textMuted, fontSize: 12, textAlign: 'center', padding: 16 }}>No schedule blocks found in this office.</Text>
                )}
              </ScrollView>
            </Pressable>
          </Pressable>
        </Modal>
      )}
    </DepthCard>
  );
}

// Full-width info banners: a pale-blue paper strip is right on the lavender
// field but reads as a lit paper island on the dark abyss, so dark gets a
// translucent wash of the same hue with a pale-blue (never cyan) label.
const infoBannerBg = (isDark: boolean) => (isDark ? 'rgba(56,189,248,0.12)' : '#E0F2FE');
const infoBannerBorder = (isDark: boolean) => (isDark ? 'rgba(125,211,252,0.32)' : '#BAE6FD');
const infoBannerFg = (isDark: boolean) => (isDark ? '#CFE9FB' : '#075985');
// "Done" green: a pale mint chip is right on the lavender field but a lit
// paper chip on the abyss, so dark gets a wash + a mint label.
const DONE_BG = (isDark: boolean) => (isDark ? 'rgba(34,197,94,0.16)' : '#dcfce7');
const DONE_BORDER = (isDark: boolean) => (isDark ? 'rgba(34,197,94,0.45)' : '#bbf7d0');
const DONE_FG = (isDark: boolean) => (isDark ? '#86EFAC' : '#166534');
const DONE_FG_SOFT = (isDark: boolean) => (isDark ? '#6EE7A5' : '#16a34a');
const WARN_BG = (isDark: boolean) => (isDark ? 'rgba(245,158,11,0.18)' : '#fef3c7');
const WARN_FG = (isDark: boolean) => (isDark ? '#FCD68A' : '#92400e');

const createStyles = (colors: any, isDark = false) => {
  // Hairlines inside a card face: a black wash disappears on the dark card.
  const hair = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)';
  const fillWash = isDark ? 'rgba(183,223,88,0.10)' : 'rgba(58,122,86,0.05)';
  return StyleSheet.create({
  // The screen root never paints page colour (spec §2.5) — the loader sits on
  // the PageField like everything else.
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10, marginTop: 4 },
  // The plan's own heading is a kicker, not a second screen title: the route
  // already paints one ("Weekly Schedule"), and this rides under it.
  kickerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  kickerBar: { width: 4, height: 18, borderRadius: 2 },
  kicker: {
    flex: 1, fontFamily: fonts.displayWide, fontSize: 12.5, color: colors.text,
    letterSpacing: 1.1, textTransform: 'uppercase',
  },
  subtitle: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted, marginTop: 4, marginLeft: 12 },

  // Week switcher — tappable row with prev/next arrows + center tap opens picker
  weekSwitcher: { flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: 4 },
  weekArrow: { padding: 4, borderRadius: 8 },
  weekCenter: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4, paddingHorizontal: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 999, flexShrink: 1 },
  weekCenterText: { fontFamily: fonts.bodySemibold, fontSize: 12, fontWeight: '700', color: colors.text, letterSpacing: 0.1 },
  weekRelChip: { backgroundColor: `${colors.primary}18`, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, marginLeft: 2 },
  weekRelChipText: { fontSize: 10, fontWeight: '800', color: colors.primary, letterSpacing: 0.3, textTransform: 'uppercase' },

  // Week picker modal
  pickerOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  pickerSheet: { backgroundColor: colors.background, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 16, maxHeight: '82%' },
  pickerHandle: { width: 36, height: 4, backgroundColor: colors.border, borderRadius: 2, alignSelf: 'center', marginBottom: 8 },
  pickerHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  pickerTitle: { flex: 1, fontFamily: fonts.display, fontSize: 18, fontWeight: '800', color: colors.text },
  pickerClose: { padding: 4 },
  pickerSubtitle: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted, marginBottom: 14, lineHeight: 17 },
  pickerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12, marginBottom: 6, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  // Dark primary (#7fa032) only gives white 3.2:1; primaryDark is a FILL token
  // and lands white at 6.55:1 (spec §2.3 — never use it as TEXT).
  pickerRowSelected: { backgroundColor: isDark ? colors.primaryDark : colors.primary, borderColor: isDark ? colors.primaryDark : colors.primary },
  pickerRowText: { fontFamily: fonts.bodySemibold, fontSize: 14, fontWeight: '700', color: colors.text },
  pickerRowTextSelected: { color: '#fff' },
  pickerRowMeta: { fontSize: 11, color: colors.textMuted, marginTop: 2, fontWeight: '600' },
  statusPill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  statusPillText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.4 },
  saveDot: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },

  notLiveBanner: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#fef3c7', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 12 },
  notLiveText: { fontSize: 12, color: '#92400e', fontWeight: '600', flex: 1 },

  modeToggle: { marginBottom: 12 },

  previewBanner: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: infoBannerBg(isDark), borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 12, borderWidth: 1, borderColor: infoBannerBorder(isDark) },
  previewBannerText: { fontSize: 11, color: isDark ? infoBannerFg(true) : '#0c4a6e', fontWeight: '600', flex: 1, lineHeight: 15 },

  notPublishedCard: { alignItems: 'center', padding: 28, gap: 10, backgroundColor: colors.surface, borderRadius: 14, borderWidth: 1, borderColor: colors.border, marginTop: 12 },
  fallbackBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, marginTop: 8, marginBottom: 4, borderRadius: 10, backgroundColor: infoBannerBg(isDark), borderWidth: 1, borderColor: infoBannerBorder(isDark) },
  fallbackText: { flex: 1, fontSize: 12, color: infoBannerFg(isDark), fontWeight: '700', lineHeight: 16 },
  notPublishedTitle: { fontFamily: fonts.display, fontSize: 15, fontWeight: '800', color: colors.text },
  notPublishedText: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted, textAlign: 'center', lineHeight: 18, paddingHorizontal: 8 },

  card: { backgroundColor: colors.surface, borderRadius: 14, borderWidth: 1, borderColor: colors.border, padding: 14, marginBottom: 14, shadowColor: colors.shadow, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 1 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12 },
  cardHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  cardTitle: { fontFamily: fonts.display, fontSize: 14, fontWeight: '800', color: colors.text, letterSpacing: 0.3 },

  // "Start this week" hero
  heroCard: { backgroundColor: colors.surface, borderRadius: 16, borderWidth: 1, borderColor: `${colors.primary}30`, padding: 16, marginBottom: 14, gap: 8, shadowColor: colors.shadow, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 6, elevation: 2 },
  heroTitle: { fontFamily: fonts.display, fontSize: 17, fontWeight: '800', color: colors.text, letterSpacing: -0.2 },
  heroSub: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted, lineHeight: 17, marginBottom: 2 },
  heroBtnPrimary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 13 },
  heroBtnPrimaryText: { fontFamily: fonts.bodySemibold, color: colors.onPrimary, fontSize: 14, fontWeight: '800' },
  heroBtnRow: { flexDirection: 'row', gap: 8 },
  heroBtnLight: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 11, borderRadius: 12, borderWidth: 1, borderColor: `${colors.primary}30`, backgroundColor: 'rgba(58, 122, 86, 0.06)' },
  heroBtnLightText: { fontFamily: fonts.bodySemibold, fontSize: 12, fontWeight: '700', color: colors.primary },
  heroDismiss: { alignSelf: 'center', paddingVertical: 4, paddingHorizontal: 8 },
  heroDismissText: { fontSize: 12, color: colors.textMuted, fontWeight: '600', textDecorationLine: 'underline' },

  themesGrid: { gap: 10 },
  themeField: {},
  themeLabel: { fontSize: 10, fontWeight: '800', color: colors.textMuted, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 4 },
  themeInput: { fontFamily: fonts.body, backgroundColor: colors.surfaceAlt, borderRadius: 8, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, color: colors.text, minHeight: 36 },
  themeReadValue: { fontSize: 13, color: colors.text, paddingVertical: 2 },
  themesEmptyHint: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted, marginBottom: 8, fontStyle: 'italic' },
  themeChipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  themeChip: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingVertical: 5, paddingHorizontal: 9, borderRadius: 999, borderWidth: 1, borderColor: `${colors.primary}30`, backgroundColor: 'rgba(58, 122, 86, 0.05)' },
  themeChipText: { fontFamily: fonts.bodyMedium, fontSize: 11, fontWeight: '600', color: colors.primary },

  // Weekly Stats card (Goal / Leaders / ER's / Sales / Advancements)
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  statField: { flexBasis: '47%', flexGrow: 1, minWidth: 120, paddingHorizontal: 10, paddingVertical: 8, borderLeftWidth: 3, backgroundColor: colors.surfaceAlt, borderRadius: 8 },
  statRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 4 },
  statLabel: { fontSize: 9, fontWeight: '900', letterSpacing: 0.5 },
  statInput: { fontFamily: fonts.mono, fontSize: 18, fontWeight: '800', color: colors.text, paddingVertical: 2 },
  goalActualRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 4 },
  goalActualText: { fontSize: 10, fontWeight: '700', color: colors.textMuted, fontVariant: ['tabular-nums'] as any, letterSpacing: 0.2 },
  goalActualLoading: { fontSize: 10, fontStyle: 'italic', color: colors.textMuted, marginTop: 4 },

  // Day chips (Fill filter bar)
  dayChipsRow: { flexDirection: 'row', gap: 6, paddingBottom: 10, paddingTop: 2 },
  dayChip: { alignItems: 'center', minWidth: 48, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 12, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border },
  dayChipSelected: { backgroundColor: isDark ? colors.primaryDark : colors.primary, borderColor: isDark ? colors.primaryDark : colors.primary },
  dayChipComplete: { backgroundColor: DONE_BG(isDark), borderColor: DONE_BORDER(isDark) },
  dayChipLabel: { fontFamily: fonts.bodySemibold, fontSize: 12, fontWeight: '800', color: colors.text, letterSpacing: 0.2 },
  dayChipLabelSelected: { color: '#fff' },
  dayChipCount: { fontFamily: fonts.mono, fontSize: 10, fontWeight: '700', color: colors.textMuted, marginTop: 1 },
  dayChipCountSelected: { color: 'rgba(255,255,255,0.85)' },

  rowCard: { backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 10, marginBottom: 10, shadowColor: colors.shadow, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 1 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  rowHeadLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowLabelInput: { flex: 1, fontFamily: fonts.bodySemibold, fontSize: 14, fontWeight: '800', color: colors.text, paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: colors.border },
  rowLabelRO: { flex: 1, fontSize: 14, fontWeight: '800', color: colors.text },
  rowTimeInput: { width: 90, fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted, paddingVertical: 4, textAlign: 'right' },
  rowTimeRO: { fontSize: 11, color: colors.textMuted },

  // Fill · compact row header
  fillRowHead: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 2 },
  fillRowLabel: { flex: 1, fontFamily: fonts.bodySemibold, fontSize: 14, fontWeight: '800', color: colors.text },
  fillRowTime: { fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted },
  fillRowPill: { minWidth: 34, alignItems: 'center', paddingVertical: 2, paddingHorizontal: 7, borderRadius: 999, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
  fillRowPillDone: { backgroundColor: DONE_BG(isDark), borderColor: DONE_BORDER(isDark) },
  fillRowPillText: { fontFamily: fonts.mono, fontSize: 10, fontWeight: '800', color: colors.textMuted },
  fillRowPillTextDone: { color: DONE_FG_SOFT(isDark) },

  oneOffTag: { alignSelf: 'flex-start', backgroundColor: WARN_BG(isDark), borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1, marginTop: 2 },
  oneOffTagText: { fontSize: 8, fontWeight: '800', color: WARN_FG(isDark), letterSpacing: 0.3, textTransform: 'uppercase' },

  addDayLink: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 7, paddingHorizontal: 4 },
  addDayLinkText: { fontSize: 11, fontWeight: '600', color: colors.textMuted },
  addDayRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, paddingVertical: 6, paddingHorizontal: 4 },
  addDayChip: { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, borderColor: `${colors.primary}30`, backgroundColor: 'rgba(58, 122, 86, 0.05)' },
  addDayChipText: { fontSize: 11, fontWeight: '700', color: colors.primary },

  // Fill · single-day view
  dayHeader: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginBottom: 8, marginTop: 2, paddingHorizontal: 2 },
  dayHeaderTitle: { fontFamily: fonts.display, fontSize: 16, fontWeight: '800', color: colors.text, letterSpacing: -0.2 },
  dayHeaderCount: { fontFamily: fonts.mono, fontSize: 11, fontWeight: '700', color: colors.textMuted },
  slotCard: { backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 10, marginBottom: 8, shadowColor: colors.shadow, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 1 },
  slotCardFilled: { borderColor: 'rgba(34, 197, 94, 0.35)' },
  slotHead: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 6 },
  slotTime: { fontFamily: fonts.mono, fontSize: 11, fontWeight: '700', color: colors.primary },
  slotLabel: { flex: 1, fontFamily: fonts.bodySemibold, fontSize: 13, fontWeight: '800', color: colors.text },
  oneOffSection: { marginTop: 4, marginBottom: 8, padding: 10, borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.border, backgroundColor: colors.surface },
  oneOffSectionTitle: { fontSize: 10, fontWeight: '800', color: colors.textMuted, letterSpacing: 0.4, textTransform: 'uppercase', marginBottom: 7 },
  oneOffChipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  oneOffChip: { flexDirection: 'row', alignItems: 'center', gap: 3, maxWidth: '100%', paddingVertical: 4, paddingHorizontal: 9, borderRadius: 999, borderWidth: 1, borderColor: `${colors.primary}30`, backgroundColor: 'rgba(58, 122, 86, 0.05)' },
  oneOffChipText: { fontSize: 11, fontWeight: '700', color: colors.primary, flexShrink: 1 },

  // Structure view
  structInfo: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, paddingHorizontal: 4, marginBottom: 12 },
  structInfoText: { flex: 1, fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, lineHeight: 16 },
  structFootnote: { fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, lineHeight: 16, paddingHorizontal: 4, marginBottom: 14 },
  activeDaysRow: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 4, marginBottom: 6 },
  activeDaysText: { fontFamily: fonts.mono, fontSize: 10, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.2 },

  matchRow: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 8, borderRadius: 8, backgroundColor: colors.surfaceAlt, marginBottom: 2 },
  matchText: { flex: 1, fontSize: 11, color: colors.textMuted, fontWeight: '600' },

  cell: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 5, paddingHorizontal: 4, borderTopWidth: 1, borderTopColor: hair },
  cellFilled: { backgroundColor: fillWash },
  cellDay: { fontSize: 11, fontWeight: '800', color: colors.textMuted, letterSpacing: 0.3 },
  // Presenter is the primary input — bolder, slightly larger
  cellPresenterInput: { fontFamily: fonts.bodySemibold, backgroundColor: colors.surfaceAlt, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6, fontSize: 13, fontWeight: '700', color: colors.text, borderWidth: 1, borderColor: colors.border },
  // Topic is now the secondary detail — smaller, muted
  cellTopicInput: { fontFamily: fonts.body, backgroundColor: 'transparent', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, fontSize: 11, fontWeight: '500', fontStyle: 'italic', color: colors.textMuted, marginTop: 3, borderWidth: 1, borderColor: hair, borderStyle: 'dashed' },
  // Read-only versions for legacy non-admin path
  cellPresenterRO: { fontSize: 13, fontWeight: '700', color: colors.text, paddingVertical: 2 },
  cellTopicRO: { fontSize: 11, fontWeight: '500', fontStyle: 'italic', color: colors.textMuted, marginTop: 2 },

  addRowBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: colors.surface, borderRadius: 10, borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed', paddingVertical: 12, marginTop: 4, marginBottom: 14 },
  addRowBtnText: { fontFamily: fonts.bodySemibold, fontSize: 13, fontWeight: '700', color: colors.primary },

  hiddenNote: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 8 },
  hiddenNoteText: { fontSize: 11, fontWeight: '600', color: colors.textMuted, textDecorationLine: 'underline' },

  publishRow: { flexDirection: 'row', gap: 10, marginTop: 8 },
  btnPrimary: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 14 },
  btnPrimaryText: { fontFamily: fonts.bodySemibold, color: colors.onPrimary, fontSize: 14, fontWeight: '800' },
  btnSecondary: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 14, paddingHorizontal: 16, borderRadius: 12, borderWidth: 1, borderColor: colors.primary, backgroundColor: 'rgba(58, 122, 86, 0.06)' },
  btnSecondaryText: { color: colors.primary, fontSize: 13, fontWeight: '800' },

  btnLight: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
  btnLightText: { fontSize: 11, fontWeight: '700', color: colors.primary },

  empty: { alignItems: 'center', padding: 24, gap: 6 },
  emptyText: { color: colors.textMuted, fontSize: 13, textAlign: 'center' },
  });
};

const createMat = (colors: any) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(11, 33, 28,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.background, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 18 },
  grip: { alignSelf: 'center', width: 40, height: 5, borderRadius: 999, backgroundColor: '#91B69E', marginBottom: 8 },
  title: { fontSize: 15, fontWeight: '800', color: colors.text, marginBottom: 4 },
  sub: { fontSize: 11, color: colors.textMuted, lineHeight: 16, marginBottom: 12 },
  opt: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 10, borderRadius: 8, marginBottom: 4, borderWidth: 1, borderColor: 'transparent' },
  optSel: { backgroundColor: 'rgba(58, 122, 86, 0.06)', borderColor: 'rgba(58, 122, 86, 0.18)' },
  optText: { fontSize: 13, color: colors.text, fontWeight: '600' },
});

/* __theme_static_fallback__ */
// Fallback static styles (used if a sub-component didn't pick up the
// useColors hook). Always light-mode — won't react to theme changes.
const styles = createStyles(lightColors, false);
const mat = createMat(lightColors);
