/**
 * Leadership Hub — COD (Cycle of Development).
 *
 * The old folder-tree + wall-of-text impacts screen, revamped into a
 * learning hub with a two-segment switcher (The Cycle | Library) under the
 * top bar so materials aren't buried below the impacts:
 *   • THE CYCLE — hero ("COD — Cycle of Development" identity, cycle-ring
 *     motif, quick-check progress) plus impacts grouped by stage as
 *     readable row cards (title, one-line preview, read time, passed
 *     tick). Tapping opens the reader (app/cod/[id].tsx) with its
 *     Learn | Notes modes.
 *   • LIBRARY — slim identity strip, then the same folders / PDFs / links
 *     as before; file open, share and print behavior is untouched. Its
 *     search spans ALL folders (global) so a doc is findable without
 *     digging through the tree.
 *
 * The last-used segment persists (AsyncStorage 'cg1.cod.tab'). A
 * ?tab=library route param — used by the bottom-bar Library shortcut in
 * tabRegistry — beats the stored value, and is honored on param CHANGE
 * too (the tab bar replaces in place, so the mounted screen must react).
 *
 * Admin manage actions (add/edit/delete folders, resources, impacts) all
 * survive, tucked behind a single pencil toggle in the top bar — the hub
 * reads as a learning space until an admin flips it into manage mode.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { showAlert } from '../src/utils/showAlert';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  Modal, TextInput, KeyboardAvoidingView, Platform, Linking,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import * as Print from 'expo-print';
import { File, Paths } from 'expo-file-system';
// Legacy FS module — rock-solid base64 write that works in older Expo Go
// runtimes too. We only fall back to this when the new `File.writeBytes`
// class API is not available on the user's device (ships with older Expo
// Go bundles on iOS).
import * as LegacyFS from 'expo-file-system/legacy';
import * as WebBrowser from 'expo-web-browser';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { apiService } from '../src/api/client';
import { useAuth } from '../src/auth/AuthContext';
import { useColors, useTheme } from '../src/theme/ThemeContext';
import { fonts, brand, GRADIENT, GRADIENT_TEXT, GRADIENT_XP } from '../src/theme/brand';
import { toast } from '../src/utils/toast';
import { haptics } from '../src/utils/haptics';
import { openPdfWeb, reservePdfTab } from '../src/utils/openPdfWeb';
import CoachingAssistantSheet from '../src/leadership/CoachingAssistantSheet';
import { FAB } from '../src/components/ui/FAB';
import { useTabBarClearance } from '../src/customization/CustomTabBar';
import PressableScale from '../src/components/ui/PressableScale';
import { Skeleton } from '../src/components/ui/Skeleton';
import { EmptyState } from '../src/components/ui/EmptyState';
import { Reveal } from '../src/components/ui/Reveal';
import { GlowOrb } from '../src/components/ui/Decor';
import { Masthead } from '../src/components/nav/Masthead';
import { DepthCard } from '../src/components/ui/DepthCard';
import { SectionHead } from '../src/components/ui/SectionHead';
import { SlidingSegments, type SegmentItem } from '../src/components/ui/SlidingSegments';
import { GradientText } from '../src/components/ui/GradientText';
import { VertexMark } from '../src/components/ui/VertexMark';
import { useParallaxScroll } from '../src/components/ui/Parallax';
import { pageMarkKick } from '../src/theme/pageScroll';
import { CycleRing } from '../src/components/cod/CycleRing';
import { ImpactEditorSheet } from '../src/components/cod/ImpactEditorSheet';
import {
  Impact, stageMeta, CATEGORY_LABEL,
  normalizePassedIds, LOCAL_PASSED_KEY,
} from '../src/components/cod/types';
import { firstSentence, readMinutes } from '../src/components/cod/parseNotes';
import { sortCodStages, codStagePad } from '../src/components/cod/stageOrder';

type Folder = {
  id: string; name: string; parent_id: string | null; order: number;
};
type Resource = {
  id: string; folder_id: string | null; title: string; description: string;
  type: 'pdf' | 'link';
  audience: string[];
  link_url?: string;
  file_name?: string; file_size?: number; mime_type?: string;
};

const AUDIENCE_OPTIONS = [
  { key: 'admin', label: 'Admins', icon: 'shield-checkmark' as const },
  { key: 'core_leader', label: 'Core Coaches', icon: 'star' as const },
  { key: 'leader', label: 'Coaches', icon: 'people' as const },
  { key: 'trainee', label: 'BAs', icon: 'person' as const },
];

type HubTab = 'cycle' | 'library';
const HUB_TAB_KEY = 'cg1.cod.tab';

const fmtBytes = (n: number) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

export default function LeadershipHub() {
  const colors = useColors();
  const { effective } = useTheme();
  const isDark = effective === 'dark';
  // No insets here: the standalone Masthead pays the top inset itself and the
  // sheet sub-components below measure their own.
  const tabBarClearance = useTabBarClearance();
  const router = useRouter();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const styles = useMemo(() => createStyles(colors), [colors]);

  const { onScroll } = useParallaxScroll();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [manage, setManage] = useState(false);

  // Library
  const [folders, setFolders] = useState<Folder[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [usage, setUsage] = useState<{ total_bytes: number; pdf_count: number; link_count: number; soft_cap_bytes: number } | null>(null);
  const [path, setPath] = useState<(Folder | null)[]>([null]);  // breadcrumb stack, root = null
  const [showAddFolder, setShowAddFolder] = useState(false);
  const [showAddResource, setShowAddResource] = useState(false);
  const [editingFolder, setEditingFolder] = useState<Folder | null>(null);
  const [editingResource, setEditingResource] = useState<Resource | null>(null);
  const currentFolder = path[path.length - 1];

  // The Cycle
  const [impacts, setImpacts] = useState<Impact[]>([]);
  const [stages, setStages] = useState<number[]>([1, 2]);
  const [selectedStage, setSelectedStage] = useState<number | 'all'>('all');
  const [search, setSearch] = useState('');
  const [passedIds, setPassedIds] = useState<Set<string>>(new Set());
  const [editingImpact, setEditingImpact] = useState<Impact | null>(null);
  const [creatingImpact, setCreatingImpact] = useState(false);

  // ── Segment: The Cycle | Library ───────────────────────────────────
  // Entry: an explicit ?tab= param (the bottom-bar Library shortcut targets
  // '/coaching?tab=library') beats the remembered segment; with no param,
  // restore the last-used one. Keyed on the param so it re-runs when the
  // tab bar replaces in place while this screen is already mounted.
  const { tab: tabParam } = useLocalSearchParams<{ tab?: string }>();
  const [tab, setTab] = useState<HubTab>('cycle');
  const [tabLoaded, setTabLoaded] = useState(false);
  useEffect(() => {
    if (tabParam === 'library' || tabParam === 'cycle') {
      setTab(tabParam);
      setTabLoaded(true);
      return;
    }
    AsyncStorage.getItem(HUB_TAB_KEY)
      .then((v) => { if (v === 'library' || v === 'cycle') setTab(v); })
      .catch(() => {})
      .finally(() => setTabLoaded(true));
  }, [tabParam]);

  // The Cycle | Library. The pill's icon follows the selection: the colour that
  // sits on the filled pill when chosen, the quiet label colour otherwise.
  const hubItems: SegmentItem[] = useMemo(() => ([
    { key: 'cycle', label: 'The Cycle', icon: <Ionicons name="sync" size={13} color={tab === 'cycle' ? colors.onPrimary : colors.textSecondary} /> },
    { key: 'library', label: 'Library', icon: <Ionicons name="library" size={13} color={tab === 'library' ? colors.onPrimary : colors.textSecondary} /> },
  ]), [colors.onPrimary, colors.textSecondary, tab]);

  const switchTab = (t: HubTab) => {
    if (t === tab) return;
    haptics.light();
    setTab(t);
    // Each segment gets a fresh search — a stale cycle query silently
    // filtering the library (or vice versa) reads as "my files vanished".
    setSearch('');
    AsyncStorage.setItem(HUB_TAB_KEY, t).catch(() => {});
  };

  // Quick-check state backs the hub ticks; the local mirror keeps them lit
  // even if the quiz-state endpoint isn't reachable (backend ships in
  // parallel — degrade to "no server ticks", never crash).
  const refreshPassed = useCallback(async () => {
    let server = new Set<string>();
    try {
      const { data } = await apiService.coachingImpactQuizState();
      server = normalizePassedIds(data);
    } catch { /* endpoint missing / offline — fall back to local */ }
    let local: string[] = [];
    try {
      const raw = await AsyncStorage.getItem(LOCAL_PASSED_KEY);
      local = raw ? JSON.parse(raw) : [];
    } catch {}
    setPassedIds(new Set<string>([...Array.from(server), ...local]));
  }, []);

  const load = useCallback(async () => {
    try {
      const [tree, imp, u] = await Promise.all([
        apiService.coachingTree().catch(() => ({ data: { folders: [], resources: [] } })),
        apiService.coachingImpacts().catch(() => ({ data: { impacts: [], stages: [1, 2] } })),
        isAdmin ? apiService.coachingUsage().catch(() => null) : Promise.resolve(null),
      ]);
      setFolders(tree.data?.folders || []);
      setResources(tree.data?.resources || []);
      setImpacts(imp.data?.impacts || []);
      // COD display order — Stage SL (stored as 5) sits between Stage 3 and
      // Stage 4, and this list drives both the stage chips and the section
      // order in THE CYCLE. See stageOrder.ts.
      setStages(sortCodStages(imp.data?.stages || [1, 2]));
      if (u) setUsage(u.data);
      await refreshPassed();
    } catch (e: any) {
      showAlert('Failed to load', e?.response?.data?.detail || e?.message || 'Try again.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [isAdmin, refreshPassed]);
  useEffect(() => { load(); }, [load]);

  // Light refresh of the ticks whenever the hub regains focus (e.g. coming
  // back from the reader after passing a quick check).
  useFocusEffect(useCallback(() => { refreshPassed(); }, [refreshPassed]));


  // ── The Cycle — filtering + grouping ───────────────────────────────
  const filteredImpacts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return impacts.filter((it) => {
      if (selectedStage !== 'all' && it.stage !== selectedStage) return false;
      if (!q) return true;
      const hay = `${it.title} ${it.summary} ${it.category} ${it.body} ${(it.key_takeaways || []).join(' ')}`.toLowerCase();
      return hay.includes(q);
    });
  }, [impacts, selectedStage, search]);

  const groupedImpacts = useMemo(() => {
    const out: Record<number, Impact[]> = {};
    for (const it of filteredImpacts) {
      if (!out[it.stage]) out[it.stage] = [];
      out[it.stage].push(it);
    }
    return out;
  }, [filteredImpacts]);

  const passedCount = useMemo(
    () => impacts.filter((it) => passedIds.has(it.id)).length,
    [impacts, passedIds],
  );

  // ── Library — visible items in current folder ──────────────────────
  const visibleFolders = folders
    .filter((f) => (currentFolder?.id || null) === (f.parent_id || null))
    .sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name));
  const visibleResources = resources
    .filter((r) => (currentFolder?.id || null) === (r.folder_id || null))
    .sort((a, b) => a.title.localeCompare(b.title));
  const folderItemCount = (id: string) =>
    resources.filter((r) => r.folder_id === id).length +
    folders.filter((f) => f.parent_id === id).length;

  // Library search is GLOBAL (all folders, not just the current one) so a
  // doc is findable without knowing which folder it lives in. Empty query
  // (or being on the Cycle segment) = normal browse of the current folder.
  const librarySearch = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (tab !== 'library' || !q) return null;
    return {
      folders: folders
        .filter((f) => f.name.toLowerCase().includes(q))
        .sort((a, b) => a.name.localeCompare(b.name)),
      resources: resources
        .filter((r) => `${r.title} ${r.description || ''} ${r.file_name || ''}`.toLowerCase().includes(q))
        .sort((a, b) => a.title.localeCompare(b.title)),
    };
  }, [tab, search, folders, resources]);
  const shownFolders = librarySearch ? librarySearch.folders : visibleFolders;
  const shownResources = librarySearch ? librarySearch.resources : visibleResources;

  const openFolder = (f: Folder) => {
    if (!librarySearch) { setPath([...path, f]); return; }
    // Jumping in from global search results: the folder may be nested, so
    // rebuild the breadcrumb chain up to the root before landing in it.
    const byId = new Map(folders.map((x) => [x.id, x]));
    const chain: Folder[] = [f];
    let cur: Folder | undefined = f;
    let guard = folders.length;
    while (cur?.parent_id && guard-- > 0) {
      cur = byId.get(cur.parent_id);
      if (cur) chain.unshift(cur);
    }
    setPath([null, ...chain]);
    setSearch('');
  };

  // ── Open / Share / Print actions (unchanged behavior) ──────────────
  // Decode a base64 string into a Uint8Array. Hermes/RN provides global atob
  // so we don't need to pull in the `buffer` polyfill.
  const decodeBase64 = (b64: string): Uint8Array => {
    const binary = (globalThis as any).atob ? (globalThis as any).atob(b64) : '';
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };

  const openResource = async (r: Resource) => {
    if (r.type === 'link') {
      const url = r.link_url || '';
      // The server only stores https links; never open anything else.
      if (!/^https:\/\//i.test(url)) { showAlert('Could not open', 'This link is not a secure web address.'); return; }
      try { await WebBrowser.openBrowserAsync(url); }
      catch { Linking.openURL(url); }
      return;
    }
    // PDF — fetch base64, write to cache, open.
    // On web the tab MUST be reserved before the fetch below: after an await
    // the tap no longer counts as user activation and the browser blocks the
    // window, which is why this silently did nothing on phones.
    const reserved = Platform.OS === 'web' ? reservePdfTab() : null;
    try {
      toast.info('Loading…');
      const { data } = await apiService.coachingFile(r.id);
      const b64 = data.file_b64 as string;
      if (Platform.OS === 'web') {
        const problem = openPdfWeb(
          b64,
          'application/pdf',
          r.file_name || `${r.title || 'document'}.pdf`,
          reserved,
        );
        if (problem) showAlert('Could not open', problem);
        return;
      }
      const filePath = `${Paths.cache.uri}${r.id}-${(r.file_name || 'doc.pdf').replace(/\s+/g, '_')}`;
      // Resilient write: the new expo-file-system `File` class is great on
      // SDK 53+ standalone / EAS builds, but older **Expo Go** iOS bundles
      // can ship a runtime where neither `writeBytes` nor the 1-arg `write`
      // variant exists yet — you get `i.writeBytes is not a function`.
      // Try the new API first, then fall back to the legacy base64-aware
      // `writeAsStringAsync` which has been stable for years.
      let resolvedUri = filePath;
      try {
        const file = new File(filePath);
        try { file.delete(); } catch {}
        file.create();
        // Prefer `writeBytes` (takes Uint8Array)…
        if (typeof (file as any).writeBytes === 'function') {
          (file as any).writeBytes(decodeBase64(b64));
        }
        // …fall back to `write(Uint8Array)` (one arg — the {encoding} options
        // form throws `InvalidArgsNumberException` on iOS FS v19).
        else if (typeof (file as any).write === 'function') {
          (file as any).write(decodeBase64(b64));
        }
        else {
          throw new Error('no writeBytes/write on File');
        }
        resolvedUri = file.uri;
      } catch (newApiErr) {
        // Last-resort: legacy base64 write. This is what has always worked.
        // Strip the `file://` prefix because `writeAsStringAsync` wants a path.
        const legacyPath = filePath.replace(/^file:\/\//, '');
        await LegacyFS.writeAsStringAsync(legacyPath, b64, { encoding: 'base64' as any });
        resolvedUri = legacyPath.startsWith('/') ? `file://${legacyPath}` : legacyPath;
      }
      const ok = await Sharing.isAvailableAsync();
      if (ok) await Sharing.shareAsync(resolvedUri, { mimeType: 'application/pdf', dialogTitle: r.title });
    } catch (e: any) {
      // Don't strand the placeholder tab we reserved before fetching.
      try { reserved?.close(); } catch {}
      showAlert('Open failed', e?.message || 'Could not open.');
    }
  };

  const printResource = async (r: Resource) => {
    if (r.type === 'link') {
      // Escaped: on web the print page renders on the app's own origin.
      const esc = (v?: string) => String(v || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
      const href = /^https:\/\//i.test(r.link_url || '') ? r.link_url : '';
      try { await Print.printAsync({ html: `<html><body><h1>${esc(r.title)}</h1><p><a href="${esc(href)}">${esc(href)}</a></p></body></html>` }); }
      catch (e: any) { showAlert('Print failed', e?.message || ''); }
      return;
    }
    try {
      toast.info('Preparing…');
      const { data } = await apiService.coachingFile(r.id);
      const uri = `data:application/pdf;base64,${data.file_b64}`;
      await Print.printAsync({ uri });
    } catch (e: any) {
      showAlert('Print failed', e?.message || 'Could not print.');
    }
  };

  // ── Admin actions ──────────────────────────────────────────────────
  const confirmDeleteFolder = (f: Folder) => {
    showAlert(
      'Delete folder?',
      `"${f.name}" — this also deletes everything inside it.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: async () => {
          try {
            await apiService.coachingDeleteFolder(f.id, true);
            toast.success('Folder deleted');
            load();
          } catch (e: any) {
            showAlert('Delete failed', e?.response?.data?.detail || e?.message || '');
          }
        }},
      ],
    );
  };
  const confirmDeleteResource = (r: Resource) => {
    showAlert(
      'Delete resource?',
      `"${r.title}"`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: async () => {
          try { await apiService.coachingDeleteResource(r.id); toast.success('Deleted'); load(); }
          catch (e: any) { showAlert('Delete failed', e?.response?.data?.detail || e?.message || ''); }
        }},
      ],
    );
  };
  const confirmDeleteImpact = (it: Impact) => {
    showAlert(
      'Delete impact?',
      `"${it.title}"`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: async () => {
          try { await apiService.coachingDeleteImpact(it.id); toast.success('Deleted'); load(); }
          catch (e: any) { showAlert('Delete failed', e?.response?.data?.detail || e?.message || ''); }
        }},
      ],
    );
  };

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <View style={styles.root}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* This route hides the navigator header, so it mounts the editorial
          masthead itself (gradient Unbounded title + the turning cube). */}
      <Masthead
        standalone
        compact
        title="Leadership Hub"
        onBack={() => router.back()}
        right={(
          <View style={styles.topBarActions}>
            {isAdmin && (
              <TouchableOpacity
                onPress={() => { haptics.light(); setManage((m) => !m); }}
                style={[styles.iconBtn, manage && { backgroundColor: `${colors.primary}18`, borderRadius: 9 }]}
              >
                <Ionicons name={manage ? 'pencil' : 'pencil-outline'} size={18} color={manage ? colors.primary : colors.textMuted} />
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={load} style={styles.iconBtn}>
              <Ionicons name="refresh" size={19} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
        )}
      />

      {/* The Cycle | Library switcher — fixed under the top bar (same pill
          pattern as the reader's Learn | Notes toggle) so the Library is one
          tap away no matter how far down the impacts you've scrolled. */}
      <SlidingSegments
        style={styles.hubSegWrap}
        items={hubItems}
        value={tab}
        onChange={(k) => switchTab(k as HubTab)}
        haptic={false}
      />

      {loading || !tabLoaded ? (
        <View style={styles.skeletonWrap}>
          <DepthCard variant="ink" style={styles.heroSkeleton}>
            <Skeleton width={'54%' as const} height={10} borderRadius={5} />
            <View style={{ height: 16 }} />
            <Skeleton width={'70%' as const} height={28} borderRadius={8} />
            <View style={{ height: 16 }} />
            <Skeleton width={'92%' as const} height={11} borderRadius={5} />
            <View style={{ height: 8 }} />
            <Skeleton width={'58%' as const} height={11} borderRadius={5} />
          </DepthCard>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <DepthCard key={i} index={i} sheen={false} style={styles.rowSkeleton}>
              <Skeleton width={36} height={36} borderRadius={11} />
              <View style={{ flex: 1, gap: 7 }}>
                <Skeleton width={'62%' as const} height={13} borderRadius={6} />
                <Skeleton width={'86%' as const} height={10} borderRadius={5} />
              </View>
            </DepthCard>
          ))}
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 14, paddingBottom: 120 + tabBarClearance }}
          keyboardShouldPersistTaps="handled"
          onScroll={onScroll}
          scrollEventThrottle={16}
        >
          {tab === 'cycle' ? (
            <>
            {/* What this is, and how far through the quick checks you are. */}
            <View style={styles.heroCard}>
              <Text style={styles.heroEyebrow}>COD — CYCLE OF DEVELOPMENT</Text>
              <Text style={styles.heroTitle}>Leadership Hub</Text>
              <Text style={styles.heroSub}>
                Sales systems and leadership systems. Learn them card by card — or open the notes and teach straight off them.
              </Text>
              {impacts.length > 0 && (
                <View style={styles.heroProgressRow}>
                  <View style={styles.heroProgressTrack}>
                    {passedCount > 0 && (
                      <View style={[styles.heroProgressFill, { width: `${Math.max(4, (passedCount / impacts.length) * 100)}%` as any }]} />
                    )}
                  </View>
                  <Text style={styles.heroProgressText}>{passedCount}/{impacts.length} checks</Text>
                </View>
              )}
            </View>

            {/* Search + stage filter */}
            <Reveal index={1} distance={0} tilt={0}>
            <View style={styles.filterBar}>
              <View style={styles.searchBox}>
                <Ionicons name="search" size={16} color={colors.textMuted} />
                <TextInput
                  value={search}
                  onChangeText={setSearch}
                  placeholder="Search the cycle…"
                  placeholderTextColor={colors.textMuted}
                  style={styles.searchInput}
                  returnKeyType="search"
                />
                {search.length > 0 && (
                  <TouchableOpacity onPress={() => setSearch('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Ionicons name="close-circle" size={18} color={colors.textMuted} />
                  </TouchableOpacity>
                )}
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.stageChipRow}>
                <TouchableOpacity
                  style={[
                    styles.stageChip,
                    selectedStage === 'all' && styles.stageChipActive,
                    selectedStage === 'all' && isDark && styles.stageChipActiveDark,
                  ]}
                  onPress={() => setSelectedStage('all')}
                >
                  <Text style={[styles.stageChipText, selectedStage === 'all' && { color: colors.inkText }]}>All</Text>
                </TouchableOpacity>
                {stages.map((s) => {
                  const meta = stageMeta(s);
                  const active = selectedStage === s;
                  return (
                    <TouchableOpacity
                      key={s}
                      style={[styles.stageChip, active && styles.stageChipActive, active && isDark && styles.stageChipActiveDark]}
                      onPress={() => setSelectedStage(active ? 'all' : s)}
                    >
                      <View style={[styles.stageDot, { backgroundColor: meta.color }]} />
                      <Text style={[styles.stageChipText, active && { color: colors.inkText }]}>{meta.short}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>

            </Reveal>

            {/* THE CYCLE */}
            <Reveal index={2} distance={0} tilt={0}>
            <View style={styles.sectionHeadRow}>
              <SectionHead size={22} style={{ flex: 1 }}>THE CYCLE</SectionHead>
              {isAdmin && manage && (
                <TouchableOpacity style={styles.addPill} onPress={() => setCreatingImpact(true)}>
                  <Ionicons name="add" size={14} color={colors.primary} />
                  <Text style={styles.addPillText}>Impact</Text>
                </TouchableOpacity>
              )}
            </View>

            </Reveal>

            {/* No Reveal on the stage list: it is thousands of px tall, and
                any scale/tilt on a box that big throws its top off-screen.
                Each row enters on its own (DepthCard index). */}
            {filteredImpacts.length === 0 ? (
              <EmptyState
                compact
                icon="sync-outline"
                title={search ? 'Nothing matches' : 'No impacts yet'}
                subtitle={search ? 'Try another search or clear the stage filter.' : isAdmin ? 'Flip on manage mode and add the first impact.' : 'Check back soon.'}
              />
            ) : (
              <View>
                {stages
                  .filter((s) => (selectedStage === 'all' || selectedStage === s) && (groupedImpacts[s] || []).length > 0)
                  .map((s) => {
                    const meta = stageMeta(s);
                    const list = groupedImpacts[s] || [];
                    return (
                      <View key={s} style={styles.stageSection}>
                        <View style={styles.stageHeader}>
                          <Text style={[styles.stageNum, { color: meta.color }]}>{codStagePad(s)}</Text>
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <Text style={styles.stageHeaderText}>{meta.short}</Text>
                            {meta.tagline ? <Text style={styles.stageTagline} numberOfLines={1}>{meta.tagline}</Text> : null}
                          </View>
                          <Text style={styles.stageCount}>{list.length}</Text>
                        </View>
                        {list.map((it, idx) => {
                          const passed = passedIds.has(it.id);
                          const preview = firstSentence(it.summary, it.body);
                          return (
                            <DepthCard key={it.id} index={idx} sheen={false} style={styles.impactRow}>
                              <PressableScale
                                style={styles.impactRowMain}
                                onPress={() => { haptics.light(); router.push(`/cod/${it.id}` as any); }}
                              >
                                <View style={[styles.iconBox, { backgroundColor: passed ? colors.greenBg : `${meta.color}1c` }]}>
                                  <Ionicons
                                    name={passed ? 'checkmark' : (meta.icon as any)}
                                    size={18}
                                    color={passed ? colors.green : meta.color}
                                  />
                                </View>
                                <View style={{ flex: 1, minWidth: 0 }}>
                                  <Text style={styles.impactTitle} numberOfLines={1}>{it.title}</Text>
                                  {preview ? <Text style={styles.impactPreview} numberOfLines={1}>{preview}</Text> : null}
                                  <View style={styles.impactMetaRow}>
                                    <Text style={[styles.impactTag, { color: meta.color }]}>
                                      {CATEGORY_LABEL[it.category] || it.category}
                                    </Text>
                                    <Text style={styles.impactMeta}>· ~{readMinutes(it)} min</Text>
                                    {passed && (
                                      <View style={styles.passedChip}>
                                        <Ionicons name="checkmark-circle" size={11} color={colors.green} />
                                        <Text style={styles.passedChipText}>Passed</Text>
                                      </View>
                                    )}
                                  </View>
                                </View>
                                <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
                              </PressableScale>
                              {isAdmin && manage && (
                                <View style={styles.rowActions}>
                                  <TouchableOpacity onPress={() => setEditingImpact(it)} style={styles.actionBtn}>
                                    <Ionicons name="pencil" size={15} color={colors.textMuted} />
                                  </TouchableOpacity>
                                  <TouchableOpacity onPress={() => confirmDeleteImpact(it)} style={styles.actionBtn}>
                                    <Ionicons name="trash" size={15} color={colors.red} />
                                  </TouchableOpacity>
                                </View>
                              )}
                            </DepthCard>
                          );
                        })}
                      </View>
                    );
                  })}
              </View>
            )}

            </>
            ) : (
            <>
            {/* LIBRARY — slim identity strip; the full COD hero lives on
                The Cycle and doesn't repeat here. */}
            <Reveal index={0} distance={0} tilt={0}>
            <DepthCard variant="ink" sheen glow style={styles.libStrip}>
              <GlowOrb size={110} color={brand.lime} opacity={isDark ? 0.45 : 0.4} style={{ top: -40, right: -30 }} />
              <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.libStripIcon}>
                <Ionicons name="library" size={20} color={colors.textLight} />
              </LinearGradient>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.libStripEyebrow}>COD — CYCLE OF DEVELOPMENT</Text>
                <GradientText colors={GRADIENT_TEXT} style={styles.libStripTitle} numberOfLines={1}>Library</GradientText>
                <Text style={styles.libStripSub}>Materials & collateral — docs, scripts & videos to teach from</Text>
              </View>
            </DepthCard>
            </Reveal>

            {/* Admin manage row — storage usage + add actions */}
            {isAdmin && manage && (
              <View style={styles.libManageRow}>
                {usage ? (
                  <Text style={[styles.usageLine, { flex: 1, marginTop: 0 }]}>
                    {usage.pdf_count} PDF{usage.pdf_count === 1 ? '' : 's'} · {usage.link_count} link{usage.link_count === 1 ? '' : 's'} · {fmtBytes(usage.total_bytes)} of {fmtBytes(usage.soft_cap_bytes)} ({Math.round((usage.total_bytes / usage.soft_cap_bytes) * 100)}%)
                  </Text>
                ) : (
                  <View style={{ flex: 1 }} />
                )}
                <TouchableOpacity style={styles.addPill} onPress={() => setShowAddFolder(true)}>
                  <Ionicons name="folder-open" size={13} color={colors.primary} />
                  <Text style={styles.addPillText}>Folder</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.addPill, { backgroundColor: colors.primary, borderColor: colors.primary }]} onPress={() => setShowAddResource(true)}>
                  <Ionicons name="add" size={14} color={colors.onPrimary} />
                  <Text style={[styles.addPillText, { color: colors.onPrimary }]}>Resource</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Library search — spans ALL folders, not just the open one */}
            <View style={[styles.searchBox, { marginBottom: 10 }]}>
              <Ionicons name="search" size={16} color={colors.textMuted} />
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder="Search the library…"
                placeholderTextColor={colors.textMuted}
                style={styles.searchInput}
                returnKeyType="search"
              />
              {search.length > 0 && (
                <TouchableOpacity onPress={() => setSearch('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="close-circle" size={18} color={colors.textMuted} />
                </TouchableOpacity>
              )}
            </View>

            {/* Breadcrumb — only once inside a folder, and not while a
                global search is flattening the tree */}
            {path.length > 1 && !librarySearch && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.crumbsRow}>
                {path.map((f, i) => (
                  <View key={f?.id || 'root'} style={{ flexDirection: 'row', alignItems: 'center' }}>
                    {i > 0 && <Ionicons name="chevron-forward" size={13} color={colors.textMuted} style={{ marginHorizontal: 4 }} />}
                    <TouchableOpacity onPress={() => setPath(path.slice(0, i + 1))} disabled={i === path.length - 1}>
                      <Text style={[styles.crumb, i === path.length - 1 && styles.crumbActive]}>
                        {f ? f.name : 'Library'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </ScrollView>
            )}

            {/* Folder grid */}
            {shownFolders.length > 0 && (
              <View style={styles.folderGrid}>
                {shownFolders.map((f) => (
                  <View key={f.id} style={styles.folderCell}>
                    <DepthCard style={styles.folderCard}>
                    <PressableScale style={styles.folderPress} onPress={() => openFolder(f)}>
                      <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.folderIcon}>
                        <Ionicons name="folder" size={20} color={colors.textLight} />
                      </LinearGradient>
                      <Text style={styles.folderName} numberOfLines={1}>{f.name}</Text>
                      <Text style={styles.folderCount}>{folderItemCount(f.id)} item{folderItemCount(f.id) === 1 ? '' : 's'}</Text>
                    </PressableScale>
                    </DepthCard>
                    {isAdmin && manage && (
                      <View style={styles.folderActions}>
                        <TouchableOpacity onPress={() => setEditingFolder(f)} style={styles.actionBtn}>
                          <Ionicons name="pencil" size={14} color={colors.textMuted} />
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => confirmDeleteFolder(f)} style={styles.actionBtn}>
                          <Ionicons name="trash" size={14} color={colors.red} />
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>
                ))}
              </View>
            )}

            {/* Resource rows */}
            {shownResources.length > 0 && (
              <View style={{ gap: 8 }}>
                {shownResources.map((r, ri) => (
                  <DepthCard key={r.id} index={ri} sheen={false} style={styles.resCard}>
                    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                      <View style={[styles.iconBox, { backgroundColor: r.type === 'pdf' ? colors.redBg : `${colors.primary}18` }]}>
                        <Ionicons name={r.type === 'pdf' ? 'document-text' : 'link'} size={19} color={r.type === 'pdf' ? colors.red : colors.primary} />
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.resTitle} numberOfLines={2}>{r.title}</Text>
                        {r.description ? <Text style={styles.resDesc} numberOfLines={1}>{r.description}</Text> : null}
                        <View style={styles.audienceRow}>
                          {r.type === 'pdf' && r.file_size ? (
                            <Text style={styles.metaText}>{fmtBytes(r.file_size)}</Text>
                          ) : (
                            <Text style={styles.metaText}>{r.type === 'pdf' ? 'PDF' : 'Link'}</Text>
                          )}
                          {isAdmin && manage && r.audience.map((a) => {
                            const opt = AUDIENCE_OPTIONS.find((o) => o.key === a);
                            if (!opt) return null;
                            return (
                              <View key={a} style={styles.audienceChip}>
                                <Ionicons name={opt.icon} size={10} color={colors.textSecondary} />
                                <Text style={styles.audienceChipText}>{opt.label}</Text>
                              </View>
                            );
                          })}
                        </View>
                      </View>
                    </View>
                    <View style={styles.resActions}>
                      <TouchableOpacity style={styles.primaryBtn} onPress={() => openResource(r)}>
                        <Ionicons name="open-outline" size={15} color={colors.onPrimary} />
                        <Text style={styles.primaryBtnText}>{r.type === 'pdf' ? 'Open' : 'Visit'}</Text>
                      </TouchableOpacity>
                      {r.type === 'pdf' && (
                        <TouchableOpacity style={styles.secondaryBtn} onPress={() => printResource(r)}>
                          <Ionicons name="print-outline" size={15} color={colors.primary} />
                          <Text style={styles.secondaryBtnText}>Print</Text>
                        </TouchableOpacity>
                      )}
                      {isAdmin && manage && (
                        <>
                          <TouchableOpacity style={styles.iconActionBtn} onPress={() => setEditingResource(r)}>
                            <Ionicons name="pencil" size={15} color={colors.textMuted} />
                          </TouchableOpacity>
                          <TouchableOpacity style={styles.iconActionBtn} onPress={() => confirmDeleteResource(r)}>
                            <Ionicons name="trash" size={15} color={colors.red} />
                          </TouchableOpacity>
                        </>
                      )}
                    </View>
                  </DepthCard>
                ))}
              </View>
            )}

            {shownFolders.length === 0 && shownResources.length === 0 && (
              <EmptyState
                compact
                icon={librarySearch ? 'search-outline' : 'library-outline'}
                title={librarySearch ? 'Nothing matches' : (isAdmin ? 'Empty folder' : 'Nothing here yet')}
                subtitle={librarySearch
                  ? 'Try another search.'
                  : (isAdmin ? 'Flip on manage mode to add a folder or resource.' : 'Check back soon.')}
              />
            )}
            </>
            )}
        </ScrollView>
      )}

      {/* Floating Ask AI button — primary CTA */}
      <FAB
        icon="sparkles"
        onPress={() => setAssistantOpen(true)}
        testID="leadership-hub-ask-ai-fab"
      />

      <CoachingAssistantSheet
        visible={assistantOpen}
        onClose={() => setAssistantOpen(false)}
      />

      {/* Folder modal (create or edit) */}
      <FolderModal
        visible={showAddFolder || !!editingFolder}
        existing={editingFolder}
        parentFolderId={currentFolder?.id || null}
        onClose={() => { setShowAddFolder(false); setEditingFolder(null); }}
        onSaved={() => { setShowAddFolder(false); setEditingFolder(null); load(); }}
      />

      {/* Resource modal (create or edit) */}
      <ResourceModal
        visible={showAddResource || !!editingResource}
        existing={editingResource}
        folders={folders}
        defaultFolderId={currentFolder?.id || null}
        onClose={() => { setShowAddResource(false); setEditingResource(null); }}
        onSaved={() => { setShowAddResource(false); setEditingResource(null); load(); }}
      />

      {/* Impact editor (create or edit) */}
      <ImpactEditorSheet
        visible={creatingImpact || !!editingImpact}
        existing={editingImpact}
        defaultStage={selectedStage === 'all' ? (stages[0] || 1) : (selectedStage as number)}
        onClose={() => { setCreatingImpact(false); setEditingImpact(null); }}
        onSaved={() => { setCreatingImpact(false); setEditingImpact(null); load(); }}
      />
    </View>
  );
}

// ─────────────────────── Folder modal ───────────────────────
function FolderModal({ visible, existing, parentFolderId, onClose, onSaved }: {
  visible: boolean; existing: Folder | null; parentFolderId: string | null;
  onClose: () => void; onSaved: () => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { setName(existing?.name || ''); }, [existing, visible]);

  const save = async () => {
    const n = name.trim();
    if (!n) return;
    try {
      setSaving(true);
      if (existing) await apiService.coachingUpdateFolder(existing.id, { name: n });
      else await apiService.coachingCreateFolder({ name: n, parent_id: parentFolderId });
      toast.success(existing ? 'Renamed' : 'Folder created');
      onSaved();
    } catch (e: any) {
      showAlert('Save failed', e?.response?.data?.detail || e?.message || '');
    } finally { setSaving(false); }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <TouchableOpacity activeOpacity={1} onPress={onClose} style={styles.overlay}>
          <TouchableOpacity activeOpacity={1} style={[styles.sheet, { paddingBottom: 20 + insets.bottom }]}>
            <View style={styles.handle} />
            <Text style={styles.modalTitle}>{existing ? 'Rename folder' : 'New folder'}</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Folder name"
              placeholderTextColor={colors.textMuted}
              style={styles.input}
              autoFocus
            />
            <TouchableOpacity style={[styles.primaryBtn, saving && { opacity: 0.5 }]} onPress={save} disabled={saving || !name.trim()}>
              {saving ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={styles.primaryBtnText}>{existing ? 'Save' : 'Create'}</Text>}
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ─────────────────────── Resource modal ───────────────────────
function ResourceModal({ visible, existing, folders, defaultFolderId, onClose, onSaved }: {
  visible: boolean; existing: Resource | null; folders: Folder[];
  defaultFolderId: string | null;
  onClose: () => void; onSaved: () => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [type, setType] = useState<'pdf' | 'link'>('link');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [audience, setAudience] = useState<string[]>(['admin', 'leader', 'trainee']);
  const [folderId, setFolderId] = useState<string | null>(defaultFolderId);
  const [pickedFile, setPickedFile] = useState<{ name: string; b64: string; size: number; mime: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [showFolderPicker, setShowFolderPicker] = useState(false);

  useEffect(() => {
    if (existing) {
      setType(existing.type);
      setTitle(existing.title);
      setDescription(existing.description || '');
      setLinkUrl(existing.link_url || '');
      setAudience(existing.audience.length ? existing.audience : ['admin']);
      setFolderId(existing.folder_id);
      setPickedFile(null);
    } else if (visible) {
      setType('link'); setTitle(''); setDescription(''); setLinkUrl('');
      setAudience(['admin', 'leader', 'trainee']);
      setFolderId(defaultFolderId);
      setPickedFile(null);
    }
  }, [existing, visible, defaultFolderId]);

  const pickPdf = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: ['application/pdf', 'application/*'], copyToCacheDirectory: true, multiple: false });
      if (res.canceled) return;
      const f = res.assets[0];
      let b64 = '';
      if (Platform.OS === 'web') {
        const resp = await fetch(f.uri); const blob = await resp.blob();
        b64 = await new Promise<string>((resolve) => {
          const r = new FileReader();
          r.onloadend = () => resolve((r.result as string).split(',')[1] || '');
          r.readAsDataURL(blob);
        });
      } else {
        // Modern File API (SDK 54+): wrap the picked URI and read base64.
        // Fall back to the legacy `readAsStringAsync` on older Expo Go
        // runtimes that don't expose `.base64()` on `File` yet.
        try {
          const nf: any = new File(f.uri);
          if (typeof nf.base64 === 'function') {
            b64 = await nf.base64();
          } else {
            throw new Error('no base64() on File');
          }
        } catch {
          b64 = await LegacyFS.readAsStringAsync(f.uri, { encoding: 'base64' as any });
        }
      }
      setPickedFile({ name: f.name, b64, size: f.size || 0, mime: f.mimeType || 'application/pdf' });
      if (!title) setTitle(f.name.replace(/\.[^.]+$/, ''));
    } catch (e: any) {
      showAlert('File pick failed', e?.message || '');
    }
  };

  const toggleAudience = (key: string) => {
    setAudience((cur) => cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]);
  };

  const save = async () => {
    const t = title.trim();
    if (!t) { showAlert('Title required'); return; }
    if (type === 'link' && !linkUrl.trim()) { showAlert('URL required'); return; }
    if (type === 'pdf' && !existing && !pickedFile) { showAlert('Pick a PDF first'); return; }
    try {
      setSaving(true);
      const aud = audience.length ? audience : ['admin'];
      if (existing) {
        const payload: any = { title: t, description, audience: aud, folder_id: folderId };
        if (existing.type === 'link') payload.link_url = linkUrl.trim();
        if (existing.type === 'pdf' && pickedFile) {
          payload.file_b64 = pickedFile.b64;
          payload.file_name = pickedFile.name;
          payload.mime_type = pickedFile.mime;
        }
        await apiService.coachingUpdateResource(existing.id, payload);
        toast.success('Updated');
      } else {
        const payload: any = { title: t, description, type, audience: aud, folder_id: folderId };
        if (type === 'link') payload.link_url = linkUrl.trim();
        if (type === 'pdf' && pickedFile) {
          payload.file_b64 = pickedFile.b64;
          payload.file_name = pickedFile.name;
          payload.mime_type = pickedFile.mime;
        }
        await apiService.coachingCreateResource(payload);
        toast.success('Added');
      }
      onSaved();
    } catch (e: any) {
      showAlert('Save failed', e?.response?.data?.detail || e?.message || '');
    } finally { setSaving(false); }
  };

  const folderName = folders.find((f) => f.id === folderId)?.name || 'Library (root)';

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <TouchableOpacity activeOpacity={1} onPress={onClose} style={styles.overlay}>
          <TouchableOpacity activeOpacity={1} style={[styles.sheet, { paddingBottom: 20 + insets.bottom, maxHeight: '90%' }]}>
            <View style={styles.handle} />
            <Text style={styles.modalTitle}>{existing ? 'Edit resource' : 'Add resource'}</Text>
            <ScrollView keyboardShouldPersistTaps="handled" style={{ flexGrow: 0 }}>
              {/* Type segmented */}
              {!existing && (
                <View style={styles.segRow}>
                  <TouchableOpacity style={[styles.segBtn, type === 'link' && styles.segBtnActive]} onPress={() => setType('link')}>
                    <Ionicons name="link" size={14} color={type === 'link' ? colors.onPrimary : colors.textSecondary} />
                    <Text style={[styles.segText, type === 'link' && styles.segTextActive]}>YouTube / Link</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.segBtn, type === 'pdf' && styles.segBtnActive]} onPress={() => setType('pdf')}>
                    <Ionicons name="document-text" size={14} color={type === 'pdf' ? colors.onPrimary : colors.textSecondary} />
                    <Text style={[styles.segText, type === 'pdf' && styles.segTextActive]}>PDF Upload</Text>
                  </TouchableOpacity>
                </View>
              )}

              <TextInput value={title} onChangeText={setTitle} placeholder="Title" placeholderTextColor={colors.textMuted} style={styles.input} />
              <TextInput value={description} onChangeText={setDescription} placeholder="Description (optional)" placeholderTextColor={colors.textMuted} style={[styles.input, { height: 60 }]} multiline />

              {type === 'link' && (
                <TextInput value={linkUrl} onChangeText={setLinkUrl} placeholder="https://youtube.com/... or any URL" placeholderTextColor={colors.textMuted} style={styles.input} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
              )}
              {type === 'pdf' && (
                <TouchableOpacity style={styles.fileBtn} onPress={pickPdf}>
                  <Ionicons name="cloud-upload-outline" size={18} color={colors.primary} />
                  <Text style={styles.fileBtnText} numberOfLines={1}>
                    {pickedFile ? `${pickedFile.name} (${fmtBytes(pickedFile.size)})` : (existing?.file_name ? `${existing.file_name} — tap to replace` : 'Pick a PDF')}
                  </Text>
                </TouchableOpacity>
              )}

              {/* Folder picker */}
              <TouchableOpacity style={styles.input} onPress={() => setShowFolderPicker(true)}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Ionicons name="folder" size={16} color={colors.primary} />
                  <Text style={{ color: colors.text, flex: 1 }}>{folderName}</Text>
                  <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
                </View>
              </TouchableOpacity>

              {/* Audience picker */}
              <Text style={styles.fieldLabel}>Who can see this?</Text>
              <View style={styles.audienceGrid}>
                {AUDIENCE_OPTIONS.map((opt) => {
                  const on = audience.includes(opt.key);
                  return (
                    <TouchableOpacity
                      key={opt.key}
                      style={[styles.audPick, on && { borderColor: colors.primary, backgroundColor: `${colors.primary}14` }]}
                      onPress={() => toggleAudience(opt.key)}
                    >
                      <Ionicons name={opt.icon} size={16} color={on ? colors.primary : colors.textMuted} />
                      <Text style={[styles.audPickText, on && { color: colors.primary, fontWeight: '800' }]}>{opt.label}</Text>
                      {on && <Ionicons name="checkmark-circle" size={14} color={colors.primary} />}
                    </TouchableOpacity>
                  );
                })}
              </View>
            </ScrollView>

            <TouchableOpacity style={[styles.primaryBtn, saving && { opacity: 0.5 }]} onPress={save} disabled={saving}>
              {saving ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={styles.primaryBtnText}>{existing ? 'Save changes' : 'Add resource'}</Text>}
            </TouchableOpacity>

            {/* Folder picker submodal */}
            <Modal visible={showFolderPicker} transparent animationType="fade" onRequestClose={() => setShowFolderPicker(false)}>
              <TouchableOpacity activeOpacity={1} onPress={() => setShowFolderPicker(false)} style={styles.overlay}>
                <TouchableOpacity activeOpacity={1} style={[styles.sheet, { paddingBottom: 20 + insets.bottom, maxHeight: '70%' }]}>
                  <View style={styles.handle} />
                  <Text style={styles.modalTitle}>Move to…</Text>
                  <ScrollView>
                    <TouchableOpacity style={[styles.pickRow, !folderId && { backgroundColor: `${colors.primary}11` }]} onPress={() => { setFolderId(null); setShowFolderPicker(false); }}>
                      <View style={[styles.iconBox, { backgroundColor: `${colors.primary}22` }]}>
                        <Ionicons name="library" size={18} color={colors.primary} />
                      </View>
                      <Text style={styles.pickRowTitle}>Library (root)</Text>
                      {!folderId && <Ionicons name="checkmark" size={18} color={colors.primary} />}
                    </TouchableOpacity>
                    {folders.map((f) => (
                      <TouchableOpacity key={f.id} style={[styles.pickRow, folderId === f.id && { backgroundColor: `${colors.primary}11` }]} onPress={() => { setFolderId(f.id); setShowFolderPicker(false); }}>
                        <View style={[styles.iconBox, { backgroundColor: `${colors.primary}22` }]}>
                          <Ionicons name="folder" size={18} color={colors.primary} />
                        </View>
                        <Text style={styles.pickRowTitle}>{f.name}</Text>
                        {folderId === f.id && <Ionicons name="checkmark" size={18} color={colors.primary} />}
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </TouchableOpacity>
              </TouchableOpacity>
            </Modal>
          </TouchableOpacity>
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  root: { flex: 1 },

  // Masthead right slot (manage toggle + refresh)
  topBarActions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  iconBtn: { padding: 6 },
  skeletonWrap: { flex: 1, paddingHorizontal: 14, paddingTop: 14 },
  heroSkeleton: { borderRadius: 24, padding: 20, marginBottom: 16 },
  rowSkeleton: { flexDirection: 'row', alignItems: 'center', gap: 11, borderRadius: 16, padding: 12, marginBottom: 9 },

  // The Cycle | Library switcher (same pill family as the reader's
  // Learn | Notes toggle in app/cod/[id].tsx)
  hubSegWrap: { marginHorizontal: 14, marginTop: 10, marginBottom: 2 },

  // Library — slim identity strip (compact stand-in for the full hero)
  libStrip: {
    borderRadius: 20, paddingHorizontal: 16, paddingVertical: 14, overflow: 'hidden', marginBottom: 12,
    flexDirection: 'row', alignItems: 'center', gap: 12,
  },
  libStripIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  libStripEyebrow: { fontFamily: fonts.mono, fontSize: 9, color: colors.inkMuted, letterSpacing: 1.6, fontWeight: '700' },
  libStripTitle: { fontFamily: fonts.displayBlack, fontSize: 22, marginTop: 3, letterSpacing: -0.5 },
  libStripSub: { fontFamily: fonts.body, fontSize: 12, color: colors.inkMuted, marginTop: 2, lineHeight: 17 },
  libManageRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },

  // Hero — the printed ink block (text uses inkText/inkMuted)
  heroCard: { borderRadius: 16, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  heroEyebrow: { fontFamily: fonts.mono, fontSize: 10.5, color: colors.primary, letterSpacing: 1.6 },
  heroTitle: { fontFamily: fonts.display, fontSize: 22, lineHeight: 28, marginTop: 6, letterSpacing: -0.4, color: colors.text },
  heroSub: { fontFamily: fonts.body, color: colors.textSecondary, fontSize: 13.5, lineHeight: 20, marginTop: 6, maxWidth: 680 },
  heroProgressRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 14 },
  heroProgressTrack: { flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.surfaceAlt, overflow: 'hidden' },
  heroProgressFill: { height: 6, borderRadius: 3, backgroundColor: colors.primary },
  heroProgressText: { fontFamily: fonts.mono, fontSize: 11.5, color: colors.textSecondary },

  // Search + stage filter
  filterBar: { gap: 8, marginBottom: 4 },
  searchBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 13, paddingVertical: 11,
    borderRadius: 14, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border,
    boxShadow: colors.depthShadow,
  },
  searchInput: { flex: 1, fontFamily: fonts.body, fontSize: 14, color: colors.text, paddingVertical: 0 },
  stageChipRow: { paddingVertical: 2, flexDirection: 'row', gap: 6 },
  stageChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border },
  // Active = the printed ink chip; the stage colour stays in the dot.
  stageChipActive: { backgroundColor: colors.ink, borderColor: colors.primaryLight, boxShadow: '0 6px 14px -5px rgba(0,0,0,0.5)' },
  // Dark only: ink is within a few points of both the page and the inactive
  // chips, so the active chip would be carried by its 1px rim alone. surfaceAlt
  // sits clearly above both; the ring is a boxShadow (raw rgba literal, never a
  // token concat) so the chip doesn't resize when it becomes active.
  stageChipActiveDark: {
    backgroundColor: colors.surfaceAlt,
    boxShadow: '0 6px 14px -5px rgba(0,0,0,0.6), 0 0 0 1.5px rgba(197,227,127,0.85)',
  },
  stageChipText: { fontFamily: fonts.bodySemibold, fontSize: 12, fontWeight: '700', color: colors.text },
  stageDot: { width: 7, height: 7, borderRadius: 4 },

  // Section headers
  sectionHeadRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginTop: 18, marginBottom: 0 },
  usageLine: { fontFamily: fonts.mono, fontSize: 10, color: colors.textMuted, marginTop: 3 },
  addPill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: colors.primary, backgroundColor: `${colors.primary}10` },
  addPillText: { fontFamily: fonts.bodyBold, fontSize: 12, fontWeight: '800', color: colors.primary },

  // Cycle stage sections
  stageSection: { marginTop: 4, marginBottom: 6 },
  stageHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8, paddingHorizontal: 2 },
  stageNum: { fontFamily: fonts.monoSemibold, fontSize: 16, fontWeight: '700', letterSpacing: 0.5 },
  stageHeaderText: { fontFamily: fonts.display, fontSize: 13.5, fontWeight: '900', color: colors.text, letterSpacing: 0.3 },
  stageTagline: { fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, marginTop: 1 },
  stageCount: { fontFamily: fonts.mono, fontSize: 11, fontWeight: '700', color: colors.textMuted, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },

  // Impact rows
  impactRow: { flexDirection: 'row', alignItems: 'center', borderRadius: 16, padding: 12, marginBottom: 9 },
  impactRowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 11 },
  impactTitle: { fontFamily: fonts.bodyBold, fontSize: 14.5, fontWeight: '800', color: colors.text },
  impactPreview: { fontFamily: fonts.body, fontSize: 12, color: colors.textSecondary, marginTop: 2.5, lineHeight: 16 },
  impactMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 5, flexWrap: 'wrap' },
  impactTag: { fontFamily: fonts.mono, fontSize: 9.5, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  impactMeta: { fontFamily: fonts.mono, fontSize: 9.5, color: colors.textMuted, fontWeight: '600' },
  passedChip: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999, backgroundColor: colors.greenBg },
  passedChipText: { fontFamily: fonts.bodySemibold, fontSize: 9.5, fontWeight: '700', color: colors.green },
  rowActions: { flexDirection: 'row', gap: 6, marginLeft: 8 },
  actionBtn: { padding: 6, borderRadius: 6, backgroundColor: colors.background },

  iconBox: { width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },

  // Library
  crumbsRow: { alignItems: 'center', paddingVertical: 4, marginBottom: 6 },
  crumb: { fontFamily: fonts.bodySemibold, fontSize: 13, color: colors.textMuted, fontWeight: '700' },
  crumbActive: { color: colors.primary },
  folderGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  folderCell: { width: '48.5%' as any, flexGrow: 1 },
  folderCard: { borderRadius: 18 },
  folderPress: { padding: 14, gap: 8 },
  folderIcon: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  folderName: { fontFamily: fonts.bodyBold, fontSize: 14, fontWeight: '800', color: colors.text },
  folderCount: { fontFamily: fonts.mono, fontSize: 10.5, color: colors.textMuted, fontWeight: '600' },
  folderActions: { flexDirection: 'row', gap: 6, justifyContent: 'flex-end', marginTop: 6 },

  resCard: { borderRadius: 18, padding: 13, marginBottom: 2 },
  resTitle: { fontFamily: fonts.bodyBold, fontSize: 14.5, fontWeight: '800', color: colors.text },
  resDesc: { fontFamily: fonts.body, fontSize: 12, color: colors.textSecondary, marginTop: 2, lineHeight: 17 },
  audienceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 7, alignItems: 'center' },
  audienceChip: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 6, paddingVertical: 2, backgroundColor: colors.background, borderRadius: 6, borderWidth: 1, borderColor: colors.border },
  audienceChipText: { fontFamily: fonts.bodySemibold, fontSize: 10, fontWeight: '700', color: colors.textSecondary },
  metaText: { fontFamily: fonts.mono, fontSize: 10, color: colors.textMuted, fontWeight: '700' },
  resActions: { flexDirection: 'row', gap: 6, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: colors.primary, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10 },
  primaryBtnText: { fontFamily: fonts.bodyBold, color: colors.onPrimary, fontSize: 13, fontWeight: '800' },
  secondaryBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, borderWidth: 1, borderColor: colors.primary, backgroundColor: `${colors.primary}10` },
  secondaryBtnText: { fontFamily: fonts.bodyBold, color: colors.primary, fontSize: 13, fontWeight: '800' },
  iconActionBtn: { padding: 8, borderRadius: 8, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border },

  // Modals
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.background, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 16, paddingTop: 8 },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginBottom: 12 },
  modalTitle: { fontFamily: fonts.display, fontSize: 17, fontWeight: '900', color: colors.text, marginBottom: 12 },
  input: { fontFamily: fonts.body, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text, marginBottom: 8, backgroundColor: colors.surface },
  fileBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 14, borderRadius: 10, borderWidth: 1.5, borderColor: colors.primary, borderStyle: 'dashed', backgroundColor: `${colors.primary}08`, marginBottom: 8 },
  fileBtnText: { flex: 1, fontFamily: fonts.bodySemibold, fontSize: 13, fontWeight: '700', color: colors.primary },
  segRow: { flexDirection: 'row', gap: 6, marginBottom: 10 },
  segBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 9, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  segBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  segText: { fontFamily: fonts.bodySemibold, fontSize: 12, fontWeight: '700', color: colors.textSecondary },
  segTextActive: { color: colors.onPrimary },
  fieldLabel: { fontFamily: fonts.mono, fontSize: 10, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.8, textTransform: 'uppercase', marginTop: 8, marginBottom: 6 },
  audienceGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
  audPick: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, minWidth: '47%' },
  audPickText: { fontFamily: fonts.body, fontSize: 13, color: colors.text, fontWeight: '600' },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 10, marginBottom: 6 },
  pickRowTitle: { flex: 1, fontFamily: fonts.bodySemibold, fontSize: 15, fontWeight: '700', color: colors.text },
});
