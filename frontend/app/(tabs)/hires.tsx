import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { showAlert } from '../../src/utils/showAlert';
import { View, Text, StyleSheet, FlatList, ScrollView, TouchableOpacity, RefreshControl, ActivityIndicator, TextInput, Image, Platform, Linking } from 'react-native';
import DraggableFlatList, { ScaleDecorator } from 'react-native-draggable-flatlist';
// expo-haptics has no web implementation — use a no-op stub on web.
const Haptics = Platform.OS !== 'web'
  ? require('expo-haptics')
  : {
      impactAsync: () => Promise.resolve(),
      notificationAsync: () => Promise.resolve(),
      ImpactFeedbackStyle: { Light: 0, Medium: 1, Heavy: 2 },
      NotificationFeedbackType: { Success: 0, Warning: 1, Error: 2 },
    };
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsLandscape } from '../../src/hooks/useIsLandscape';
import { useTabBarClearance } from '../../src/customization/CustomTabBar';
import { useColors, lightColors, fonts, buildGetStatusColor } from '../../src/theme/ThemeContext';
import { apiService, NewHire } from '../../src/api/client';
import { format } from 'date-fns';
import { useAuth } from '../../src/auth/AuthContext';
import { useActiveOffice } from '../../src/office/ActiveOfficeContext';
import OfficeToggle from '../../src/components/ui/OfficeToggle';
import TeamMapView, { type TeamMapNode } from '../../src/components/spider/TeamMapView';
import PerformanceHub from '../../src/components/hub/PerformanceHub';
import FieldInsights from '../../src/components/insights/FieldInsights';
// The Bells board (weekly sign-ups), shown here as the third section. It is
// the same screen as /bells.
import BellsBoard from '../bells';
import PressableScale from '../../src/components/ui/PressableScale';
import { Skeleton } from '../../src/components/ui/Skeleton';
import { EmptyState } from '../../src/components/ui/EmptyState';
import { Reveal } from '../../src/components/ui/Reveal';
import { usePullToRefresh } from '../../src/components/ui/PullRefresh';
import { DepthCard } from '../../src/components/ui/DepthCard';
import { PillTabs, type PillTab } from '../../src/components/ui/PillTabs';
import { RankRibbon, type RankRibbonTint } from '../../src/components/ui/RankRibbon';
import { XPBar } from '../../src/components/ui/XPBar';
import { codStageLabel } from '../../src/components/cod/stageOrder';
import { rankTitle } from '../../src/utils/roleTitle';

// ==================== TYPES ====================
type TreeNode = {
  id: string;
  name: string;
  email: string;
  phone?: string;
  role: string;
  profile_image?: string;
  children: TreeNode[];
  current_day?: number;
  current_status?: string;
  hire_id?: string;
  // Backend-computed stage-progress preview for the badge.
  // Trainee → Stage 1 (out of 8) until all days passed off, then Stage 2.
  // Leader/Admin → Stage 3 (modules completed / total).
  current_stage?: 1 | 2 | 3;
  current_stage_completed?: number;
  current_stage_total?: number;
  team_name?: string | null;
  is_super_admin?: boolean;
  owneriq_stage?: string | null;
};

type FlatTreeNode = TreeNode & {
  depth: number;
  parentId: string | null;
  /** Everyone below this person (whole branch), for "N in team". */
  teamSize: number;
};

// Indent per level, capped so deep chains never march off the screen.
const TREE_INDENT = 16;
const TREE_MAX_INDENT_LEVELS = 4;

// Folded rank-ribbon tint per role (spec §3.11) — same accent family as the
// avatar/connector colours, with AA-checked stops inside the ribbon.
const ROLE_RIBBON: Record<string, RankRibbonTint> = {
  admin: 'purple',
  super_admin: 'purple',
  leader: 'amber',
  trainee: 'green',
};

// ==================== HELPERS ====================
function flattenTree(
  node: TreeNode,
  depth = 0,
  parentId: string | null = null,
): FlatTreeNode[] {
  const self: FlatTreeNode = { ...node, depth, parentId, teamSize: 0 };
  const result: FlatTreeNode[] = [self];
  for (const child of node.children) {
    const sub = flattenTree(child, depth + 1, node.id);
    self.teamSize += sub.length;
    result.push(...sub);
  }
  return result;
}

function getDescendantIds(
  flatNodes: FlatTreeNode[],
  nodeId: string,
): Set<string> {
  const descendants = new Set<string>();
  const stack = flatNodes
    .filter((n) => n.parentId === nodeId)
    .map((n) => n.id);
  while (stack.length > 0) {
    const current = stack.pop()!;
    descendants.add(current);
    flatNodes
      .filter((n) => n.parentId === current)
      .forEach((n) => stack.push(n.id));
  }
  return descendants;
}

// ==================== MAIN COMPONENT ====================
export default function HiresScreen() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const getStatusColor = useMemo(() => buildGetStatusColor(colors), [colors]);
  // Role accents follow the theme so badges read on both light + dark plum.
  const roleColors: Record<string, string> = useMemo(() => ({
    admin: colors.primary,
    leader: colors.yellow,
    trainee: colors.green,
  }), [colors]);

  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const isLandscape = useIsLandscape();
  const router = useRouter();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin' || user?.is_super_admin === true;
  const canSeeUnassigned = isAdmin;
  // Super admins can switch office; the tree + unassigned list follow it.
  const { officeId, canSwitch } = useActiveOffice();

  // View state
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  // Performance (OwnerIQ's Performance Hub), Spider and Bells are the views on
  // offer. Tree and Unassigned were taken off the bar (owner, Oct 2026); their
  // views are still below but nothing switches to them.
  const [viewMode, setViewMode] = useState<'performance' | 'timeline' | 'spider' | 'bells' | 'tree' | 'unassigned'>('performance');
  // A link can open a section directly: /hires?view=bells (Home's Bells shortcut).
  const { view: viewParam } = useLocalSearchParams<{ view?: string }>();
  useEffect(() => {
    if (viewParam === 'performance' || viewParam === 'timeline' || viewParam === 'spider' || viewParam === 'bells') setViewMode(viewParam);
  }, [viewParam]);
  // Which tree row has its contact dropdown (phone / email / call) open.
  const [expandedContactId, setExpandedContactId] = useState<string | null>(null);
  const [isMoving, setIsMoving] = useState(false);
  // Collapsed branches (by person id). Unset = the default: branches deeper
  // than the first level of coaches start closed, so the tree reads as teams.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [treeSearch, setTreeSearch] = useState('');
  const [backfilling, setBackfilling] = useState(false);

  // ---- Data queries ----
  const {
    data: hires,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ['new-hires', officeId],
    queryFn: () => apiService.getNewHires(officeId).then((res) => res.data),
  });

  const { data: treeData, refetch: refetchTree } = useQuery({
    queryKey: ['team-tree', officeId],
    queryFn: () => apiService.getTeamTree(officeId).then((r) => r.data),
  });

  // Web pull-to-refresh (native RefreshControl below is a no-op on web).
  // Mirrors onRefresh's refetch calls; onRefresh is declared later in the component.
  const { pullIndicator } = usePullToRefresh(async () => {
    await Promise.all([refetch(), refetchTree()]);
  });

  // Flatten tree for rendering
  const flatNodes = useMemo(() => {
    if (!treeData) return [];
    return flattenTree(treeData as TreeNode);
  }, [treeData]);

  // This week's sign-ups / Field IQ target per person (OwnerIQ Performance Hub).
  const { data: fieldWeek } = useQuery({
    queryKey: ['owneriq-performance-week'],
    queryFn: () => apiService.getFieldIqWeek().then((r) => r.data),
    staleTime: 5 * 60 * 1000,
  });
  const weekByUser = useMemo(() => {
    const m: Record<string, { sales?: number | null; target?: number | null }> = {};
    for (const r of (fieldWeek?.team || [])) m[r.user_id] = { sales: r.sales, target: r.sales_target };
    if (fieldWeek?.me?.user_id) m[fieldWeek.me.user_id] = { sales: fieldWeek.me.kpis?.sales, target: fieldWeek.me.kpis?.sales_target };
    return m;
  }, [fieldWeek]);

  const isCollapsed = useCallback(
    (n: FlatTreeNode) => (n.id in collapsed ? collapsed[n.id] : n.depth >= 2),
    [collapsed],
  );
  // What the list shows: everyone, minus the inside of closed branches — or,
  // while searching, just the people whose name matches.
  const visibleNodes = useMemo(() => {
    const q = treeSearch.trim().toLowerCase();
    if (q) return flatNodes.filter((n) => n.name.toLowerCase().includes(q) || (n.team_name || '').toLowerCase().includes(q));
    const out: FlatTreeNode[] = [];
    let hideBelow: number | null = null;
    for (const n of flatNodes) {
      if (hideBelow !== null && n.depth > hideBelow) continue;
      hideBelow = null;
      out.push(n);
      if (n.children.length > 0 && isCollapsed(n)) hideBelow = n.depth;
    }
    return out;
  }, [flatNodes, treeSearch, isCollapsed]);
  const treeCounts = useMemo(() => ({
    people: Math.max(0, flatNodes.length - 1),
    coaches: flatNodes.filter((n) => n.role === 'leader').length,
    bas: flatNodes.filter((n) => n.role === 'trainee').length,
    teams: flatNodes.filter((n) => !!n.team_name).length,
  }), [flatNodes]);

  // Unassigned trainees — hires in admin's office where leader is 'Unassigned'
  const unassignedHires = useMemo(() => {
    if (!hires) return [];
    return (hires as NewHire[]).filter((h) => h.leader === 'Unassigned');
  }, [hires]);

  // Segment items for the sliding view toggle (labels/testIDs unchanged).
  const viewSegments = useMemo<PillTab[]>(() => {
    const items: PillTab[] = [
      { key: 'performance', label: 'Performance', testID: 'hires-view-performance' },
      { key: 'timeline', label: 'Timeline', testID: 'hires-view-timeline' },
      { key: 'spider', label: 'Spider', testID: 'hires-view-spider' },
      { key: 'bells', label: 'Bells', testID: 'hires-view-bells' },
    ];
    return items;
  }, []);

  // Orientation mass-grader nudge — today's Day-1/Day-2 cohort still ungraded.
  // Backup entry point for the 6 PM push; hides silently on empty/error.
  // Checks BOTH orientation days so an ungraded Day 1 never hides behind
  // the weekday default — the banner targets the earliest day waiting.
  const { data: orientationCohort1 } = useQuery({
    queryKey: ['orientation-cohort', 1, canSwitch ? officeId : 'home'],
    queryFn: () => apiService.getOrientationCohort(1, canSwitch ? officeId : undefined).then((r) => r.data),
    enabled: isAdmin,
    retry: false,
  });
  const { data: orientationCohort2 } = useQuery({
    queryKey: ['orientation-cohort', 2, canSwitch ? officeId : 'home'],
    queryFn: () => apiService.getOrientationCohort(2, canSwitch ? officeId : undefined).then((r) => r.data),
    enabled: isAdmin,
    retry: false,
  });
  const orientationDay1Count = orientationCohort1?.items?.length || 0;
  const orientationDay2Count = orientationCohort2?.items?.length || 0;
  const orientationDay: 1 | 2 = orientationDay1Count > 0 ? 1 : 2;
  const orientationWaiting = orientationDay1Count + orientationDay2Count;

  const backfillMut = useMutation({
    mutationFn: () => apiService.backfillMissingNewHires(),
    onSuccess: (res: any) => {
      const d = res?.data || {};
      const n = d.fixed ?? (d.users?.length ?? '?');
      showAlert('Backfill complete', n === 0 ? 'Everyone already has assessment records — nothing to fix.' : `Created assessment records for ${n} new starter(s). Pull to refresh to see them.`);
      refetch();
    },
    onError: (e: any) => showAlert('Backfill failed', e?.response?.data?.detail || 'Try again.'),
  });

  // ---- Refresh ----
  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([refetch(), refetchTree()]);
    setRefreshing(false);
  };

  // ---- Drag-and-drop handler ----
  const handleDragEnd = useCallback(
    ({ data, from, to }: { data: FlatTreeNode[]; from: number; to: number }) => {
      if (from === to) return;

      const movedNode = visibleNodes[from];
      // The item above the new position is the new parent
      const targetParent = to > 0 ? data[to - 1] : null;

      if (!targetParent) return;

      // Prevent circular: can't drop under own descendants
      const descendants = getDescendantIds(flatNodes, movedNode.id);
      if (descendants.has(targetParent.id)) {
        showAlert('Invalid Move', 'Cannot place a member under their own subordinate.');
        return;
      }
      // Same parent? No change needed
      if (movedNode.parentId === targetParent.id) return;

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      showAlert(
        'Reassign Team Member',
        `Move "${movedNode.name}" under "${targetParent.name}"?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Move',
            style: 'default',
            onPress: async () => {
              setIsMoving(true);
              try {
                await apiService.setReportsTo(movedNode.id, targetParent.id);
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                await Promise.all([refetchTree(), refetch()]);
                queryClient.invalidateQueries({ queryKey: ['admin-users'] });
              } catch (e: any) {
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
                showAlert('Error', e?.response?.data?.detail || 'Failed to reassign');
              }
              setIsMoving(false);
            },
          },
        ],
      );
    },
    [flatNodes, visibleNodes, refetchTree, refetch, queryClient],
  );

  // Spider card: advance / demote someone's stage in OwnerIQ (admins), after a
  // confirm. The tree re-loads so the new stage badge shows straight away.
  const onStageChange = useCallback(
    (userId: string, direction: 'promote' | 'demote', name: string) => new Promise<void>((resolve) => {
      const verb = direction === 'promote' ? 'Advance' : 'Demote';
      showAlert(
        `${verb} ${name}?`,
        `This moves ${name} ${direction === 'promote' ? 'up' : 'down'} one stage in OwnerIQ.`,
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve() },
          {
            text: verb,
            onPress: async () => {
              try {
                const r = await apiService.owneriqRepAction({ cg1_user_id: userId, action: direction });
                const d: any = r?.data || {};
                if (d.ok === false) {
                  showAlert('Not changed', d.error || 'OwnerIQ did not accept the change.');
                } else {
                  const st = String(d.after?.stage || '').replace(/^stage_/, '').replace('_plus', '+');
                  showAlert('Done', st ? `${name} is now Stage ${st} in OwnerIQ.` : `${name} was updated in OwnerIQ.`);
                }
                await refetchTree();
              } catch (e: any) {
                showAlert('OwnerIQ', e?.response?.data?.detail || 'Could not reach OwnerIQ. Try again.');
              } finally {
                resolve();
              }
            },
          },
        ],
      );
    }),
    [refetchTree],
  );

  // Spider: a person dragged onto a Coach. Confirm, save, reload. The save
  // also moves them under that Coach in OwnerIQ.
  const onSpiderMove = useCallback(
    (userId: string, coachId: string, name: string, coachName: string) => {
      showAlert(
        `Move ${name}?`,
        `${name} will move into ${coachName}'s team, here and in OwnerIQ.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Move',
            onPress: async () => {
              try {
                await apiService.setReportsTo(userId, coachId);
                await Promise.all([refetchTree(), refetch()]);
                queryClient.invalidateQueries({ queryKey: ['admin-users'] });
              } catch (e: any) {
                showAlert('Not moved', e?.response?.data?.detail || 'Could not move them. Try again.');
              }
            },
          },
        ],
      );
    },
    [refetchTree, refetch, queryClient],
  );

  // Spider card: remove someone from the team. They are released here (their
  // records are kept) and deactivated in OwnerIQ.
  const onSpiderRemove = useCallback(
    (userId: string, name: string, directReports: number) => new Promise<void>((resolve) => {
      showAlert(
        `Remove ${name}?`,
        `${name} is released from the team and can no longer sign in. They are deactivated in OwnerIQ too. Their past numbers are kept.`
          + (directReports ? ` The ${directReports === 1 ? 'person' : `${directReports} people`} they coach will need a new Coach.` : ''),
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve() },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: async () => {
              try {
                await apiService.deleteUser(userId);
                await Promise.all([refetchTree(), refetch()]);
                queryClient.invalidateQueries({ queryKey: ['admin-users'] });
              } catch (e: any) {
                showAlert('Not removed', e?.response?.data?.detail || 'Could not remove them. Try again.');
              } finally {
                resolve();
              }
            },
          },
        ],
      );
    }),
    [refetchTree, refetch, queryClient],
  );

  // Grading / all-stages drill-in — was the row tap, now lives on the
  // "Open Profile" button inside the contact dropdown.
  const openProfile = useCallback((item: FlatTreeNode) => {
    const role = (user?.role || '').toLowerCase();
    if (role === 'leader' || role === 'admin') {
      router.push(`/leader/trainee/${item.id}`);
      return;
    }
    if (item.hire_id) router.push(`/new-hire/${item.hire_id}`);
  }, [user?.role, router]);

  // ---- Tree node renderer ----
  // One slim row per person: avatar, name (+ team tag for coaches who lead a
  // named team), one line of detail ("Coach · 4 in team · Stage 3"), this
  // week's sign-ups against their Field IQ target, and a chevron that opens
  // or closes their branch. Tapping the row still opens the contact card.
  const renderTreeItem = useCallback(
    ({ item, drag, isActive }: { item: FlatTreeNode; drag: () => void; isActive: boolean }) => {
      const hasChildren = item.children.length > 0;
      const isExpanded = expandedContactId === item.id;
      const telUrl = item.phone ? `tel:${item.phone.replace(/[^+\d]/g, '')}` : null;
      const searching = treeSearch.trim().length > 0;
      const level = searching ? 0 : Math.min(item.depth, TREE_MAX_INDENT_LEVELS);
      const indent = level * TREE_INDENT;
      const dropIndent = indent + (isAdmin ? 30 : 0) + 46;
      const isRoot = item.depth === 0 && !searching;
      const isTeamHead = item.depth === 1 && hasChildren && !searching;
      const open = hasChildren && !isCollapsed(item);
      const roleText = item.is_super_admin ? 'Owner' : item.role === 'admin' ? 'Admin' : item.role === 'leader' ? 'Coach' : 'BA';
      const stagePct = item.current_stage != null && (item.current_stage_total || 0) > 0
        ? Math.round(((item.current_stage_completed || 0) / (item.current_stage_total || 1)) * 100) : 0;
      const detail = [
        roleText,
        hasChildren ? `${item.teamSize} in team` : null,
        item.current_stage != null ? `Stage ${codStageLabel(item.current_stage)}${stagePct > 0 ? ` · ${stagePct}%` : ''}` : null,
      ].filter(Boolean).join(' · ');
      const wk = weekByUser[item.id];
      const initials = item.name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '?';
      const isCoach = item.role !== 'trainee';

      return (
        <ScaleDecorator>
          <View style={isTeamHead ? styles.t2TeamGap : null}>
          <View style={[styles.t2Row, isRoot && styles.t2RootRow, isTeamHead && styles.t2TeamRow, isActive && styles.treeNodeActive]}>
            {/* Indent with one guide line per level (capped) */}
            {level > 0 && (
              <View style={{ width: indent, alignSelf: 'stretch', flexDirection: 'row' }}>
                {Array.from({ length: level }).map((_, i) => (
                  <View key={i} style={styles.t2Guide} />
                ))}
              </View>
            )}

            {/* Drag handle (admins) */}
            {isAdmin && !searching && (
              <TouchableOpacity onLongPress={drag} delayLongPress={200} style={styles.t2Grip} disabled={isActive}>
                <Ionicons name="reorder-two" size={18} color={isActive ? colors.primary : colors.textMuted} />
              </TouchableOpacity>
            )}

            <PressableScale
              style={styles.t2Press}
              onPress={() => {
                if (item.id === user?.id) return;
                setExpandedContactId((prev) => (prev === item.id ? null : item.id));
              }}
              disabled={isActive || item.id === user?.id}
            >
              {item.profile_image ? (
                <Image source={{ uri: item.profile_image }} style={[styles.t2Avatar, (isRoot || isTeamHead) && styles.t2AvatarLg]} />
              ) : (
                <View style={[styles.t2Avatar, (isRoot || isTeamHead) && styles.t2AvatarLg,
                  isRoot || isTeamHead ? styles.t2AvatarLead : isCoach ? styles.t2AvatarCoach : styles.t2AvatarBa]}>
                  <Text style={[styles.t2AvatarText, !isCoach && styles.t2AvatarTextBa, (isRoot || isTeamHead) && styles.t2AvatarTextLead]}>{initials}</Text>
                </View>
              )}
              <View style={styles.t2Info}>
                <View style={styles.t2NameLine}>
                  <Text style={[styles.t2Name, (isRoot || isTeamHead) && styles.t2NameLg]} numberOfLines={1}>{item.name}</Text>
                  {item.team_name ? (
                    <View style={styles.t2TeamTag}><Text style={styles.t2TeamTagText} numberOfLines={1}>{item.team_name}</Text></View>
                  ) : null}
                </View>
                <Text style={styles.t2Detail} numberOfLines={1}>{detail}</Text>
              </View>
              {wk && wk.sales != null && (wk.sales > 0 || !!wk.target) ? (
                <View style={styles.t2Week}>
                  <Text style={styles.t2WeekN}>
                    {wk.sales}<Text style={styles.t2WeekT}>{wk.target ? ` / ${wk.target}` : ''}</Text>
                  </Text>
                  {wk.target ? (
                    <View style={styles.t2WeekBar}><View style={[styles.t2WeekFill, { width: `${Math.min(100, Math.round((100 * wk.sales) / wk.target))}%` }]} /></View>
                  ) : null}
                </View>
              ) : null}
            </PressableScale>

            {/* Open / close this person's branch */}
            {hasChildren && !searching ? (
              <TouchableOpacity
                style={styles.t2Chevron}
                onPress={() => setCollapsed((c) => ({ ...c, [item.id]: open }))}
                accessibilityLabel={open ? `Hide ${item.name}'s team` : `Show ${item.name}'s team`}
              >
                <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={18} color={colors.textMuted} />
              </TouchableOpacity>
            ) : (
              <View style={styles.t2Chevron} />
            )}
          </View>

          {/* Mini contact dropdown — phone, email, Call + Open Profile */}
          {isExpanded && item.id !== user?.id && (
            <View style={[styles.contactDrop, { marginLeft: dropIndent }]}>
              <TouchableOpacity
                style={styles.contactRow}
                disabled={!telUrl}
                onPress={() => telUrl && Linking.openURL(telUrl)}
              >
                <Ionicons name="call-outline" size={16} color={item.phone ? colors.textSecondary : colors.textMuted} />
                <Text style={[styles.contactRowText, !item.phone && styles.contactRowMuted]} numberOfLines={1}>
                  {item.phone || 'No phone number on file'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.contactRow}
                disabled={!item.email}
                onPress={() => item.email && Linking.openURL(`mailto:${item.email}`)}
              >
                <Ionicons name="mail-outline" size={16} color={item.email ? colors.textSecondary : colors.textMuted} />
                <Text style={[styles.contactRowText, !item.email && styles.contactRowMuted]} numberOfLines={1}>
                  {item.email || 'No email on file'}
                </Text>
              </TouchableOpacity>
              {item.role === 'trainee' ? (
                // Trainee rows: the two coaching destinations are separate
                // links — Day 1-8 assessment grading vs the Stage 1 COD sheet.
                <>
                  <View style={styles.contactBtnRow}>
                    <TouchableOpacity
                      style={[styles.callBtn, !telUrl && { opacity: 0.4 }]}
                      disabled={!telUrl}
                      onPress={() => telUrl && Linking.openURL(telUrl)}
                    >
                      <Ionicons name="call" size={16} color={colors.textLight} />
                      <Text style={styles.callBtnText}>Call</Text>
                    </TouchableOpacity>
                  </View>
                  <View style={styles.contactBtnRow}>
                    <TouchableOpacity
                      style={styles.profileBtn}
                      onPress={() => router.push(`/leader/trainee/${item.id}?tab=orientation`)}
                      testID={`team-assessments-${item.id}`}
                    >
                      <Ionicons name="clipboard-outline" size={16} color={colors.primary} />
                      <Text style={styles.profileBtnText}>Assessments</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.profileBtn}
                      onPress={() => router.push(`/leader/trainee/${item.id}?tab=stage1`)}
                      testID={`team-cod-${item.id}`}
                    >
                      <Ionicons name="grid-outline" size={16} color={colors.primary} />
                      <Text style={styles.profileBtnText}>COD</Text>
                    </TouchableOpacity>
                  </View>
                </>
              ) : (
                <View style={styles.contactBtnRow}>
                  <TouchableOpacity
                    style={[styles.callBtn, !telUrl && { opacity: 0.4 }]}
                    disabled={!telUrl}
                    onPress={() => telUrl && Linking.openURL(telUrl)}
                  >
                    <Ionicons name="call" size={16} color={colors.textLight} />
                    <Text style={styles.callBtnText}>Call</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.profileBtn} onPress={() => openProfile(item)}>
                    <Ionicons name="person-circle-outline" size={16} color={colors.primary} />
                    <Text style={styles.profileBtnText}>Open Profile</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}
          </View>
        </ScaleDecorator>
      );
    },
    [isAdmin, router, expandedContactId, user?.id, openProfile, styles, colors, treeSearch, isCollapsed, weekByUser],
  );

  // ---- List view helpers ----
  const getProgressPercentage = (currentDay: number) => (currentDay / 6) * 100;

  const filteredHires = useMemo(() => {
    if (!hires) return [];
    if (!search.trim()) return hires;
    const q = search.toLowerCase().trim();
    return hires.filter(
      (h: NewHire) =>
        h.name.toLowerCase().includes(q) || h.leader.toLowerCase().includes(q),
    );
  }, [hires, search]);

  const renderHireCard = ({ item }: { item: NewHire }) => (
    <PressableScale
      style={styles.hireCard}
      onPress={() => router.push(`/new-hire/${item.id}`)}
    >
      <View style={styles.hireHeader}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{item.name.charAt(0).toUpperCase()}</Text>
        </View>
        <View style={styles.hireInfo}>
          <Text style={styles.hireName}>{item.name}</Text>
          <Text style={styles.hireLeader}>Coach: {item.leader}</Text>
          <Text style={styles.hireDate}>Started: {format(new Date(item.start_date), 'MMM d, yyyy')}</Text>
        </View>
        <View style={[styles.statusBadge, { backgroundColor: getStatusColor(item.current_status).bg }]}>
          <Text style={[styles.statusText, { color: getStatusColor(item.current_status).text }]}>{item.current_status}</Text>
        </View>
      </View>
      <View style={styles.progressContainer}>
        <View style={styles.progressInfo}>
          <Text style={styles.progressLabel}>Day {item.current_day} of 6</Text>
          <Text style={styles.progressPercent}>{Math.round(getProgressPercentage(item.current_day))}%</Text>
        </View>
        <View style={styles.progressBar}>
          <View style={[styles.progressFill, { width: `${getProgressPercentage(item.current_day)}%` }]} />
        </View>
      </View>
      {item.final_outcome && (
        <View style={styles.outcomeContainer}>
          <Ionicons name={item.final_outcome === 'Ready' ? 'checkmark-circle' : 'time'} size={16} color={item.final_outcome === 'Ready' ? colors.green : colors.yellow} />
          <Text style={styles.outcomeText}>Outcome: {item.final_outcome}</Text>
        </View>
      )}
    </PressableScale>
  );

  // ==================== RENDER ====================
  return (
    <View
      style={[
        styles.container,
        isLandscape && { paddingLeft: insets.left, paddingRight: insets.right, paddingTop: insets.top },
      ]}
    >
      {pullIndicator}
      {/* Office switcher (super admins only — renders nothing otherwise) */}
      <View style={{ paddingHorizontal: 16, paddingTop: 10 }}>
        <OfficeToggle />
      </View>

      {/* Performance | Spider | Bells: a small row of pills. */}
      <View style={styles.topBar}>
        <PillTabs
          items={viewSegments}
          value={viewMode}
          onChange={(k) => setViewMode(k as 'performance' | 'timeline' | 'spider' | 'bells')}
        />
      </View>

      {/* Moving overlay */}
      {isMoving && (
        <View style={styles.movingOverlay}>
          <ActivityIndicator size="small" color={colors.textLight} />
          <Text style={styles.movingText}>Reassigning...</Text>
        </View>
      )}

      {viewMode === 'performance' ? (
        /* ==================== PERFORMANCE (OwnerIQ Performance Hub) ==================== */
        <PerformanceHub
          bottomPad={tabBarClearance + 24}
          // Admins and Coach+ open the person's own page (and their badge);
          // a Coach opens the COD screen of someone they coach.
          onOpenPerson={(id) => router.push((isAdmin || user?.coach_plus ? `/person/${id}` : `/leader/trainee/${id}`) as never)}
          onBadges={isAdmin || (user?.role === 'leader' && user?.coach_plus) ? () => router.push('/badges' as never) : undefined}
        />
      ) : viewMode === 'timeline' ? (
        /* ==================== TIMELINE (sign-ups hour by hour, patterns) ==================== */
        <FieldInsights
          bottomPad={tabBarClearance + 24}
          // Same rule as the hub: Admins and Coach+ open the person's page, a
          // Coach opens the COD screen of someone they coach.
          onOpenPerson={(id) => router.push((isAdmin || user?.coach_plus ? `/person/${id}` : `/leader/trainee/${id}`) as never)}
        />
      ) : viewMode === 'bells' ? (
        /* ==================== BELLS (weekly sign-ups board) ==================== */
        <BellsBoard />
      ) : isLoading && viewMode !== 'unassigned' ? (
        <View style={styles.skeletonWrap}>
          <Skeleton.List kind="row" count={8} />
        </View>
      ) : viewMode !== 'spider' && viewMode !== 'unassigned' ? (
        /* ==================== TREE VIEW with DraggableFlatList ==================== */
        <DraggableFlatList
          data={visibleNodes}
          keyExtractor={(item) => item.id}
          renderItem={renderTreeItem}
          onDragBegin={() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)}
          onDragEnd={handleDragEnd}
          activationDistance={10}
          containerStyle={{ flex: 1 }}
          contentContainerStyle={[styles.treeContent, { paddingBottom: tabBarClearance + 80 }]}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
          ListHeaderComponent={
            <View style={styles.t2Header}>
              <View style={styles.t2Chips}>
                {[
                  [treeCounts.people, 'people'],
                  [treeCounts.coaches, 'coaches'],
                  [treeCounts.bas, 'BAs'],
                  [treeCounts.teams, 'teams'],
                ].map(([n, l]) => (
                  <View key={String(l)} style={styles.t2Chip}>
                    <Text style={styles.t2ChipText}><Text style={styles.t2ChipN}>{n}</Text> {l}</Text>
                  </View>
                ))}
              </View>
              <View style={styles.t2Search}>
                <Ionicons name="search" size={15} color={colors.textMuted} />
                <TextInput
                  value={treeSearch}
                  onChangeText={setTreeSearch}
                  placeholder="Search by name or team"
                  placeholderTextColor={colors.textMuted}
                  style={styles.t2SearchInput}
                />
                {treeSearch ? (
                  <TouchableOpacity onPress={() => setTreeSearch('')}><Ionicons name="close-circle" size={16} color={colors.textMuted} /></TouchableOpacity>
                ) : null}
              </View>
              {isAdmin && !treeSearch ? (
                <Text style={styles.t2Hint}>Hold the grip to drag someone onto a new coach. Tap a row for contact details.</Text>
              ) : null}
            </View>
          }
          ListEmptyComponent={
            <EmptyState
              icon="people-outline"
              title="No team members yet"
              subtitle="Team members appear here once accounts are created."
            />
          }
        />
      ) : viewMode === 'spider' ? (
        /* ==================== SPIDER VIEW ==================== */
        <TeamMapView
          root={treeData as TeamMapNode | null}
          week={weekByUser}
          canEditStage={isAdmin}
          onStageChange={onStageChange}
          canMove={isAdmin}
          onMove={onSpiderMove}
          onRemove={isAdmin ? onSpiderRemove : undefined}
          onOpen={isAdmin ? (id) => router.push(`/person/${id}` as never) : undefined}
          bottomInset={tabBarClearance + 8}
        />
      ) : (
        /* ==================== UNASSIGNED TRAINEES (admin only) ==================== */
        <ScrollView
          contentContainerStyle={{ padding: 14, paddingBottom: tabBarClearance + 60 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        >
          {/* Orientation mass-grading shortcut — mirrors the 6 PM push */}
          {orientationWaiting > 0 && (
            <PressableScale
              style={styles.orientationBanner}
              onPress={() => router.push(`/orientation-grading?day=${orientationDay}` as never)}
              testID="orientation-grade-banner"
            >
              <Text style={styles.orientationEmoji}>🎓</Text>
              <Text style={styles.orientationBannerText}>
                {orientationDay1Count > 0 && orientationDay2Count > 0
                  ? `Grade BA Academy — Day 1: ${orientationDay1Count} · Day 2: ${orientationDay2Count}`
                  : `Grade BA Academy Day ${orientationDay} — ${orientationWaiting} waiting`}
              </Text>
              <Ionicons name="chevron-forward" size={14} color={colors.yellow} />
            </PressableScale>
          )}

          {/* Backfill banner */}
          <PressableScale
            style={styles.backfillBanner}
            onPress={() =>
              showAlert(
                'Fix missing records?',
                'This will create Day 1-8 records (assessments and checklists) for any BA account that is missing them.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Run backfill', onPress: () => backfillMut.mutate() },
                ],
              )
            }
            disabled={backfillMut.isPending}
          >
            {backfillMut.isPending ? (
              <ActivityIndicator size="small" color={colors.yellow} />
            ) : (
              <Ionicons name="build-outline" size={15} color={colors.yellow} />
            )}
            <Text style={styles.backfillBannerText}>
              {backfillMut.isPending ? 'Running backfill…' : 'Fix BAs with missing assessment records'}
            </Text>
            <Ionicons name="chevron-forward" size={14} color={colors.yellow} />
          </PressableScale>

          {isLoading ? (
            <Skeleton.List kind="row" count={4} />
          ) : unassignedHires.length === 0 ? (
            <EmptyState
              icon="checkmark-circle-outline"
              title="All BAs have a coach assigned."
              subtitle="New starters without a coach will show up here."
            />
          ) : (
            unassignedHires.map((hire, i) => (
              <Reveal key={hire.id} index={i}>
              <PressableScale
                style={styles.unassignedPress}
                onPress={() => {
                  if (hire.trainee_user_id) {
                    router.push(`/leader/trainee/${hire.trainee_user_id}`);
                  } else {
                    router.push(`/new-hire/${hire.id}`);
                  }
                }}
              >
                <DepthCard style={styles.unassignedCard}>
                <View style={styles.unassignedAvatar}>
                  <Text style={styles.unassignedAvatarText}>{hire.name.charAt(0).toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.unassignedName}>{hire.name}</Text>
                  <Text style={styles.unassignedMeta}>Started {hire.start_date} · Day {hire.current_day}</Text>
                  <View style={styles.unassignedBadge}>
                    <Ionicons name="person-remove-outline" size={11} color={colors.yellow} />
                    <Text style={styles.unassignedBadgeText}>No coach assigned</Text>
                  </View>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
                </DepthCard>
              </PressableScale>
              </Reveal>
            ))
          )}
        </ScrollView>
      )}
    </View>
  );
}

// ==================== STYLES ====================
const createStyles = (colors: any) => StyleSheet.create({
  // ── My Team tree (slim rows) ──────────────────────────────────────────
  t2Header: { paddingTop: 2, paddingBottom: 10, gap: 10 },
  t2Chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  t2Chip: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 5 },
  t2ChipText: { fontFamily: fonts.body, fontSize: 12.5, color: colors.textMuted },
  t2ChipN: { fontFamily: fonts.bodySemibold, fontWeight: '700', color: colors.text },
  t2Search: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, borderRadius: 999, paddingHorizontal: 14, height: 40 },
  t2SearchInput: { flex: 1, fontFamily: fonts.body, fontSize: 14, color: colors.text, outlineStyle: 'none' as any },
  t2Hint: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted },
  t2TeamGap: { marginTop: 10 },
  t2Row: { flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingRight: 4,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  t2RootRow: { backgroundColor: colors.surface, borderRadius: 14, borderBottomWidth: 0, marginBottom: 6, paddingVertical: 4, paddingLeft: 6 },
  t2TeamRow: { backgroundColor: colors.surface, borderTopLeftRadius: 14, borderTopRightRadius: 14, paddingVertical: 4, paddingLeft: 6 },
  t2Guide: { width: TREE_INDENT, borderLeftWidth: 1, borderLeftColor: colors.border, marginLeft: 8 },
  t2Grip: { width: 28, height: 44, alignItems: 'center', justifyContent: 'center' },
  t2Press: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 8, minWidth: 0 },
  t2Avatar: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  t2AvatarLg: { width: 42, height: 42, borderRadius: 12 },
  t2AvatarLead: { backgroundColor: colors.accent || colors.primary },
  t2AvatarCoach: { backgroundColor: colors.primary },
  t2AvatarBa: { backgroundColor: colors.surfaceAlt || colors.background, borderWidth: 1, borderColor: colors.border },
  t2AvatarText: { fontFamily: fonts.body, fontWeight: '700', fontSize: 12.5, color: colors.textLight },
  t2AvatarTextBa: { color: colors.textMuted },
  t2AvatarTextLead: { color: colors.onAccent || colors.onPrimary, fontSize: 15 },
  t2Info: { flex: 1, minWidth: 0 },
  t2NameLine: { flexDirection: 'row', alignItems: 'center', gap: 7, minWidth: 0 },
  t2Name: { fontFamily: fonts.body, fontWeight: '600', fontSize: 15, color: colors.text, flexShrink: 1 },
  t2NameLg: { fontFamily: fonts.display, fontSize: 16.5 },
  t2TeamTag: { backgroundColor: colors.accent || colors.primary, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1.5, maxWidth: 150 },
  t2TeamTagText: { fontFamily: fonts.body, fontWeight: '700', fontSize: 10, letterSpacing: 0.7, color: colors.onAccent || colors.onPrimary, textTransform: 'uppercase' },
  t2Detail: { fontFamily: fonts.body, fontSize: 12.5, color: colors.textMuted, marginTop: 1 },
  t2Week: { alignItems: 'flex-end', minWidth: 58 },
  t2WeekN: { fontFamily: fonts.body, fontWeight: '700', fontSize: 14, color: colors.text, fontVariant: ['tabular-nums'] },
  t2WeekT: { fontWeight: '400', fontSize: 12, color: colors.textMuted },
  t2WeekBar: { width: 56, height: 4, borderRadius: 2, backgroundColor: colors.trackBg || colors.border, marginTop: 4, overflow: 'hidden' },
  t2WeekFill: { height: '100%', backgroundColor: colors.accent || colors.primary, borderRadius: 2 },
  t2Chevron: { width: 34, height: 44, alignItems: 'center', justifyContent: 'center' },

  container: { flex: 1 },
  topBar: { paddingHorizontal: 12, paddingTop: 12, paddingBottom: 10, width: '100%', maxWidth: 1264, alignSelf: 'center' },

  skeletonWrap: { paddingHorizontal: 16, paddingTop: 8 },

  movingOverlay: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: 'rgba(0,0,0,0.7)', marginHorizontal: 16, marginTop: 8, paddingVertical: 10, borderRadius: 12 },
  movingText: { fontFamily: fonts.bodySemibold, color: colors.textLight, fontSize: 14, fontWeight: '600' },

  dragHint: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10, paddingHorizontal: 4 },
  dragHintText: { fontSize: 12, color: colors.textMuted, fontStyle: 'italic' },

  searchContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.background, marginHorizontal: 16, marginTop: 12, marginBottom: 4, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: colors.border, gap: 8 },
  searchInput: { flex: 1, fontSize: 15, color: colors.text, padding: 0 },

  // Tree view
  treeContent: { padding: 12 },
  // No page fill on the row strip — the cards float on the PageField.
  treeNodeRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  treeNodeActive: { opacity: 0.9, transform: [{ scale: 1.03 }], shadowColor: colors.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 10, elevation: 8 },
  depthLine: { width: 20, height: '100%', borderLeftWidth: 1, borderLeftColor: colors.borderDark },
  connectorH: { width: 12, height: 2, marginRight: 4, borderRadius: 1 },
  dragHandle: { width: 32, height: 44, alignItems: 'center', justifyContent: 'center', marginRight: 2 },
  // The Pressable is the tap target + squish; the DepthCard inside is the face.
  treeNodePress: { flex: 1, borderRadius: 16 },
  treeNodeCard: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 16, padding: 10 },
  treeAvatar: { width: 36, height: 36, borderRadius: 18 },
  treeAvatarFallback: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  treeAvatarText: { fontFamily: fonts.bodyBold, fontSize: 14, fontWeight: '700', color: colors.textLight },
  treeNodeInfo: { flex: 1 },
  treeNodeName: { fontFamily: fonts.bodySemibold, fontSize: 15, fontWeight: '600', color: colors.text },
  treeNodeMeta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, rowGap: 5, marginTop: 5 },
  treeDay: { fontSize: 11, color: colors.textSecondary },
  stagePctBadge: {
    backgroundColor: colors.surfaceAlt || colors.background,
    paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6,
    borderWidth: 1, borderColor: colors.border,
  },
  stagePctText: { fontFamily: fonts.mono, fontSize: 10, fontWeight: '800', color: colors.textSecondary, letterSpacing: 0.3 },
  // Mini XP bar beside the stage chip — tip/glow off, so zero loops. Held at
  // the spec's 44 px: letting it grow turned the common "Stage 3 · 0%" row into
  // a long empty groove, and made sibling rows ragged (inline vs wrapped).
  stageBar: { width: 44, flexGrow: 0, flexShrink: 0 },
  treeChildCount: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: colors.surfaceAlt, paddingHorizontal: 6, paddingVertical: 3, borderRadius: 10 },
  treeChildCountText: { fontFamily: fonts.mono, fontSize: 11, fontWeight: '600', color: colors.textMuted },

  // Contact dropdown (tap a row to expand)
  expandBtn: { width: 28, height: 28, borderRadius: 14, borderWidth: 1.5, borderColor: colors.primary, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary + '14' },
  expandBtnOpen: { backgroundColor: colors.primary },
  contactDrop: { backgroundColor: colors.background, borderRadius: 14, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 8, marginTop: -2, marginBottom: 8 },
  contactRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  contactRowText: { fontFamily: fonts.bodyMedium, fontSize: 13, color: colors.text, fontWeight: '500', flexShrink: 1 },
  contactRowMuted: { color: colors.textMuted, fontStyle: 'italic', fontWeight: '400' },
  contactBtnRow: { flexDirection: 'row', gap: 8, marginTop: 6, marginBottom: 2 },
  callBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: colors.green, borderRadius: 10, paddingVertical: 10 },
  callBtnText: { fontFamily: fonts.bodyBold, color: colors.textLight, fontSize: 14, fontWeight: '800' },
  profileBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 10, paddingVertical: 10, borderWidth: 1.5, borderColor: colors.primary, backgroundColor: colors.primary + '14' },
  profileBtnText: { fontFamily: fonts.bodySemibold, color: colors.primary, fontSize: 14, fontWeight: '700' },

  // List view
  listContent: { padding: 16 },
  hireCard: { backgroundColor: colors.background, borderRadius: 16, padding: 16, marginBottom: 12, shadowColor: colors.shadow, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 1 },
  hireHeader: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 16 },
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  avatarText: { fontFamily: fonts.bodySemibold, fontSize: 20, fontWeight: '600', color: colors.onPrimary },
  hireInfo: { flex: 1 },
  hireName: { fontFamily: fonts.bodySemibold, fontSize: 17, fontWeight: '600', color: colors.text, marginBottom: 2 },
  hireLeader: { fontSize: 14, color: colors.textSecondary, marginBottom: 2 },
  hireDate: { fontFamily: fonts.mono, fontSize: 12, color: colors.textMuted },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6 },
  statusText: { fontFamily: fonts.bodySemibold, fontSize: 12, fontWeight: '600' },
  progressContainer: { marginTop: 4 },
  progressInfo: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  progressLabel: { fontSize: 13, color: colors.textSecondary },
  progressPercent: { fontFamily: fonts.mono, fontSize: 13, color: colors.primary, fontWeight: '600' },
  progressBar: { height: 6, backgroundColor: colors.surfaceAlt, borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: colors.primary, borderRadius: 3 },
  outcomeContainer: { flexDirection: 'row', alignItems: 'center', marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border, gap: 6 },
  outcomeText: { fontSize: 14, color: colors.textSecondary },

  emptyState: { alignItems: 'center', paddingVertical: 60, paddingHorizontal: 32 },
  emptyTitle: { fontSize: 20, fontWeight: '600', color: colors.text, marginTop: 16, marginBottom: 8 },
  emptyText: { fontSize: 15, color: colors.textSecondary, textAlign: 'center', marginBottom: 24 },
  emptyButton: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.primary, paddingHorizontal: 20, paddingVertical: 12, borderRadius: 10, gap: 8 },
  emptyButtonText: { color: colors.onPrimary, fontWeight: '600', fontSize: 16 },

  fab: { position: 'absolute', right: 16, width: 56, height: 56, borderRadius: 28, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', shadowColor: colors.shadow, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 6 },
  loader: { flex: 1, justifyContent: 'center' },

  orientationBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.yellow + '18', borderWidth: 1, borderColor: colors.yellow + '40', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 10 },
  orientationEmoji: { fontSize: 15 },
  orientationBannerText: { flex: 1, fontFamily: fonts.bodyBold, fontSize: 13.5, color: colors.yellow, fontWeight: '700' },

  backfillBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.yellow + '18', borderWidth: 1, borderColor: colors.yellow + '40', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, marginBottom: 16 },
  backfillBannerText: { flex: 1, fontFamily: fonts.bodySemibold, fontSize: 13, color: colors.yellow, fontWeight: '600' },

  unassignedPress: { borderRadius: 18, marginBottom: 10 },
  unassignedCard: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 18, padding: 14 },
  unassignedAvatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.yellow + '30', alignItems: 'center', justifyContent: 'center' },
  unassignedAvatarText: { fontFamily: fonts.bodyBold, fontSize: 16, fontWeight: '700', color: colors.yellow },
  unassignedName: { fontFamily: fonts.bodySemibold, fontSize: 15, fontWeight: '700', color: colors.text, marginBottom: 2 },
  unassignedMeta: { fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted, marginBottom: 4 },
  unassignedBadge: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  unassignedBadgeText: { fontFamily: fonts.bodySemibold, fontSize: 11, color: colors.yellow, fontWeight: '600' },
});

/* __theme_static_fallback__ */
// Fallback static styles (used if a sub-component didn't pick up the
// useColors hook). Always light-mode — won't react to theme changes.
const styles = createStyles(lightColors);
