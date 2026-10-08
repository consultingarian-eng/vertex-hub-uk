import React, { useState, useMemo } from 'react';
import { showAlert } from '../../src/utils/showAlert';
import { promptText } from '../../src/utils/promptText';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, TextInput, Modal, Image, Platform, KeyboardAvoidingView, Linking, Switch,  } from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useIsLandscape } from '../../src/hooks/useIsLandscape';
import { useTabBarClearance } from '../../src/customization/CustomTabBar';
import { useKeyboardInset } from '../../src/hooks/useKeyboardInset';
import * as Clipboard from 'expo-clipboard';
import { useColors, useTheme, lightColors, fonts, GRADIENT } from '../../src/theme/ThemeContext';
import { apiService } from '../../src/api/client';
import { useAuth } from '../../src/auth/AuthContext';
import { useActiveOffice } from '../../src/office/ActiveOfficeContext';
import { ChoiceSheet, ChoiceOption } from '../../src/components/ChoiceSheet';
import PressableScale from '../../src/components/ui/PressableScale';
import { Skeleton } from '../../src/components/ui/Skeleton';
import { EmptyState } from '../../src/components/ui/EmptyState';
import { ScrollReveal } from '../../src/components/ui/ScrollFx';
import { useParallaxScroll } from '../../src/components/ui/Parallax';
import { LinearGradient } from 'expo-linear-gradient';
import { DepthCard } from '../../src/components/ui/DepthCard';
import { SectionHead } from '../../src/components/ui/SectionHead';
import { SlidingSegments, type SegmentItem } from '../../src/components/ui/SlidingSegments';
import { GlowButton } from '../../src/components/ui/GlowButton';
import { RankRibbon, type RankRibbonTint } from '../../src/components/ui/RankRibbon';
import { roleWord, levelWord } from '../../src/utils/roleTitle';

// Sliding-segment key for the "no office filter" slot (the label stays
// "All Offices"; `selectedOffice` itself is still undefined for that state).
const ALL_OFFICES_KEY = '__all_offices__';



export default function AdminScreen() {
  const colors = useColors();
  const { effective } = useTheme();
  const isDark = effective === 'dark';
  const styles = useMemo(() => createStyles(colors), [colors]);

  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const isLandscape = useIsLandscape();
  const kbInset = useKeyboardInset();
  const queryClient = useQueryClient();
  const router = useRouter();
  const { user } = useAuth();
  const isSuperAdmin = user?.is_super_admin;
  const [tab, setTab] = useState<'users' | 'offices'>('users');
  const [selectedOffice, setSelectedOffice] = useState<string | undefined>(undefined);
  const [roleFilter, setRoleFilter] = useState<'all' | 'admin' | 'leader' | 'trainee'>('all');
  const [search, setSearch] = useState('');
  // Accounts are thin rows; one at a time opens to show and edit its details.
  const [openId, setOpenId] = useState<string | null>(null);
  const [listW, setListW] = useState(0);
  const wideList = listW >= 860;
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'leader' | 'trainee'>('trainee');
  const [newReportsTo, setNewReportsTo] = useState<string | null>(null);
  const [newSendEmail, setNewSendEmail] = useState<boolean>(true);
  const [showAddLeaderPicker, setShowAddLeaderPicker] = useState(false);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editingEmailUserId, setEditingEmailUserId] = useState<string | null>(null);
  const [editEmail, setEditEmail] = useState('');
  const [editingPhoneUserId, setEditingPhoneUserId] = useState<string | null>(null);
  const [editPhone, setEditPhone] = useState('');
  const [amplifiPicker, setAmplifiPicker] = useState<{ userId: string; userName: string; codes: string } | null>(null);
  const { scrollY, onScroll } = useParallaxScroll();

  const { data: users, isLoading: uL } = useQuery({
    queryKey: ['admin-users', selectedOffice],
    queryFn: () => apiService.getUsers(selectedOffice).then(r => r.data),
  });
  const { data: offices } = useQuery({
    queryKey: ['offices'],
    queryFn: () => apiService.getOffices().then(r => r.data),
    enabled: !!isSuperAdmin,
  });
  // Pending crew-absence requests from leaders' weekly planners
  const { officeId: activeOfficeId } = useActiveOffice();
  // Scoped to the same office the approvals screen shows, so the badge count
  // always matches what you'll find when you tap through.
  const { data: absPending } = useQuery({
    queryKey: ['absence-pending-count', activeOfficeId || 'home'],
    queryFn: () => apiService.absenceRequestsPendingCount(activeOfficeId).then((r) => r.data),
    refetchInterval: 60_000,
  });


  const createMut = useMutation({
    mutationFn: (d: { email: string; password: string; name: string; role: 'leader' | 'trainee'; reports_to: string | null; send_email: boolean }) =>
      apiService.createUser(d),
    onSuccess: (res, variables) => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      queryClient.invalidateQueries({ queryKey: ['team-tree'] });
      const { name, email, password, role } = variables;
      const emailedNote = res.data?.email_sent
        ? `\n\n✉️ Welcome email with login info sent to ${email}.`
        : `\n\nShare these credentials with the user so they can log in.`;
      setShowAdd(false);
      setNewName(''); setNewEmail(''); setNewPassword('');
      setNewRole('trainee'); setNewReportsTo(null); setNewSendEmail(true);
      showAlert(
        `${roleWord(role)} Account Created`,
        `Name: ${name}\nEmail: ${email}\nPassword: ${password}${emailedNote}`,
      );
    },
    onError: (e: any) => showAlert('Error', e.response?.data?.detail || 'Failed'),
  });

  const promoteMut = useMutation({
    mutationFn: ({ id, role }: { id: string; role: string }) => apiService.updateUserRole(id, role),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      showAlert('Success', 'Role updated');
    },
  });

  const coachPlusMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => apiService.setCoachPlus(id, enabled),
    onSuccess: (res: any) => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      showAlert('Done', res?.data?.message || 'Updated');
    },
    onError: (e: any) => showAlert('Error', e.response?.data?.detail || 'Failed'),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => apiService.deleteUser(id),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      queryClient.invalidateQueries({ queryKey: ['new-hires'] });
      const msg = res.data?.reassigned > 0
        ? `User deleted. ${res.data.reassigned} new starter(s) moved to Unassigned.`
        : 'User deleted';
      showAlert('Done', msg);
    },
  });

  const renameMut = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => apiService.updateUserName(id, name),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      queryClient.invalidateQueries({ queryKey: ['new-hires'] });
      setEditingUserId(null);
      setEditName('');
      showAlert('Updated', res.data?.message || 'Name updated');
    },
    onError: (e: any) => showAlert('Error', e.response?.data?.detail || 'Failed'),
  });

  const changeEmailMut = useMutation({
    mutationFn: ({ id, email }: { id: string; email: string }) => apiService.updateUserEmail(id, email),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setEditingEmailUserId(null);
      setEditEmail('');
      showAlert('Updated', res.data?.message || 'Email updated');
    },
    onError: (e: any) => showAlert('Error', e.response?.data?.detail || 'Failed'),
  });

  const changePhoneMut = useMutation({
    mutationFn: ({ id, phone }: { id: string; phone: string }) => apiService.updateUserPhone(id, phone),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setEditingPhoneUserId(null);
      setEditPhone('');
      showAlert('Updated', res.data?.message || 'Phone number updated');
    },
    onError: (e: any) => showAlert('Error', e.response?.data?.detail || 'Failed'),
  });

  // Tap-to-call — works on native (Expo) and web/PWA (browser hands `tel:`
  // to the device dialer). Strip to digits/+ so formatted numbers still dial.
  const openPhone = (phone?: string) => {
    const cleaned = (phone || '').replace(/[^\d+]/g, '');
    if (!cleaned) return;
    Linking.openURL(`tel:${cleaned}`).catch(() => {});
  };

  const removePhotoMut = useMutation({
    mutationFn: (userId: string) => apiService.removeUserProfileImage(userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      showAlert('Done', 'Profile picture removed');
    },
    onError: () => showAlert('Error', 'Failed to remove photo'),
  });

  const reportsToMut = useMutation({
    mutationFn: ({ userId, parentId }: { userId: string; parentId: string | null }) =>
      apiService.setReportsTo(userId, parentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      queryClient.invalidateQueries({ queryKey: ['team-tree'] });
      queryClient.invalidateQueries({ queryKey: ['new-hires'] });
      showAlert('Updated', 'Coach assignment updated');
    },
    onError: (e: any) => showAlert('Error', e.response?.data?.detail || 'Failed to update coach'),
  });

  const amplifiCodesMut = useMutation({
    mutationFn: ({ userId, codes }: { userId: string; codes: string[] }) =>
      apiService.updateUserAmplifiCodes(userId, codes),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setAmplifiPicker(null);
    },
    onError: (e: any) => showAlert('Error', e?.response?.data?.detail || 'Failed to save codes'),
  });

  // Leader picker state — scrollable bottom sheet instead of a stacked Alert
  const [leaderPicker, setLeaderPicker] = useState<{ userId: string; userName: string; currentReportsTo?: string } | null>(null);

  const showLeaderPicker = (userId: string, currentReportsTo?: string, userName?: string) => {
    setLeaderPicker({ userId, userName: userName || 'this user', currentReportsTo });
  };

  const leaderPickerOptions: ChoiceOption<string | null>[] = React.useMemo(() => {
    if (!leaderPicker || !users) return [];
    return (users as any[])
      .filter((u: any) => u.id !== leaderPicker.userId && (u.role === 'admin' || u.role === 'leader'))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      .map((l: any) => ({
        label: l.name,
        subtitle: roleWord(l.role) + (l.email ? ` · ${l.email}` : ''),
        value: l.id as string,
        icon: (l.role === 'admin' ? 'shield-checkmark' : 'person') as any,
        selected: l.id === leaderPicker.currentReportsTo,
      }));
  }, [leaderPicker, users]);

  const assignOfficeMut = useMutation({
    mutationFn: ({ userId, officeId }: { userId: string; officeId: string }) =>
      apiService.updateUserOffices(userId, { office_id: officeId, accessible_offices: [officeId] }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      showAlert('Updated', 'Office assignment updated');
    },
    onError: () => showAlert('Error', 'Failed to assign office'),
  });

  // Office picker state — scrollable bottom sheet
  const [officePicker, setOfficePicker] = useState<{ userId: string; currentOfficeId?: string } | null>(null);

  const showOfficePicker = (userId: string, currentOfficeId?: string) => {
    if (!offices || offices.length === 0) return;
    setOfficePicker({ userId, currentOfficeId });
  };

  const officePickerOptions: ChoiceOption<string>[] = React.useMemo(() => {
    if (!officePicker || !offices) return [];
    return (offices as any[]).map((o: any) => ({
      label: o.name,
      subtitle: [o.city, o.state].filter(Boolean).join(', '),
      value: o.id as string,
      icon: 'business' as any,
      selected: o.id === officePicker.currentOfficeId,
    }));
  }, [officePicker, offices]);

  const handleCreate = () => {
    if (!newName.trim() || !newEmail.trim() || !newPassword.trim()) {
      showAlert('Error', 'Fill name, email, and password'); return;
    }
    if (newPassword.length < 8) {
      showAlert('Error', 'Password must be at least 8 characters'); return;
    }
    createMut.mutate({
      email: newEmail.trim(),
      password: newPassword,
      name: newName.trim(),
      role: newRole,
      reports_to: newReportsTo,
      send_email: newSendEmail,
    });
  };

  // Auto-generate a quick random password for the admin to copy/edit
  const generatePassword = () => {
    const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    let p = '';
    for (let i = 0; i < 10; i++) p += charset.charAt(Math.floor(Math.random() * charset.length));
    setNewPassword(p);
  };

  // Available leaders/admins to pick as the new user's "reports_to"
  const newUserLeaderOptions: ChoiceOption<string | null>[] = React.useMemo(() => {
    if (!users) return [];
    const arr = (users as any[])
      .filter((u: any) => u.role === 'admin' || u.role === 'leader')
      .map((l: any) => ({
        label: l.name,
        subtitle: `${roleWord(l.role).toUpperCase()} · ${l.email}`,
        value: l.id as string | null,
        icon: (l.role === 'admin' ? 'shield-checkmark' : 'star') as any,
        selected: l.id === newReportsTo,
      }));
    return arr as ChoiceOption<string | null>[];
  }, [users, newReportsTo]);

  const reportsToName = React.useMemo(() => {
    if (!newReportsTo || !users) return null;
    const u = (users as any[]).find((x: any) => x.id === newReportsTo);
    return u?.name || null;
  }, [newReportsTo, users]);

  const filteredUsers = React.useMemo(() => {
    if (!users) return [];
    let list = users as any[];
    if (roleFilter !== 'all') {
      list = list.filter(u => u.role === roleFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      list = list.filter(u => u.name?.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q));
    }
    return list;
  }, [users, roleFilter, search]);

  // Users | Offices — the ink rail with the sliding tile (spec §3.13).
  const tabItems = React.useMemo<SegmentItem[]>(() => (
    isSuperAdmin
      ? [{ key: 'users', label: 'Users' }, { key: 'offices', label: 'Offices' }]
      : [{ key: 'users', label: 'Users' }]
  ), [isSuperAdmin]);

  // Super-admin office switcher — the same rail, scrollable.
  const officeItems = React.useMemo<SegmentItem[]>(() => ([
    { key: ALL_OFFICES_KEY, label: 'All Offices' },
    ...((offices || []) as any[]).map((o: any) => ({ key: o.id as string, label: o.name as string })),
  ]), [offices]);

  const roleCounts = React.useMemo(() => {
    if (!users) return { all: 0, admin: 0, leader: 0, trainee: 0 };
    const u = users as any[];
    return {
      all: u.length,
      admin: u.filter(x => x.role === 'admin').length,
      leader: u.filter(x => x.role === 'leader').length,
      trainee: u.filter(x => x.role === 'trainee').length,
    };
  }, [users]);

  // Owner only: put back any Manual + Module items missing on this server.
  const restoreBundle = () => {
    showAlert(
      'Restore Manual + Modules',
      'This pulls every Manual + Module item out of the bundled snapshot and inserts whatever is missing on this server, matching offices BY NAME, and rebuilds empty new-starter checklists.\n\n' +
      '• Existing rows are NEVER overwritten\n' +
      '• Any office not in the bundle stays untouched\n' +
      '• New-starter assessments and filled checklists are NOT touched\n\n' +
      'Run a dry-run first to preview?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Dry run',
          onPress: async () => {
            try {
              const res = await apiService.restoreManualByName(true);
              const officeLines = res.data.offices.map(o =>
                o.dst_id ? `✅ ${o.name} → ${o.dst_id.slice(0, 8)}…` : `⊘ ${o.name} — ${o.skipped || 'no match'}`
              ).join('\n');
              const resultLines = res.data.results.map(r =>
                `${r.collection}: would insert ${r.inserted ?? 0}, skip ${r.skipped_already_present ?? 0} dup, ${r.skipped_office_unmatched ?? 0} no-match`
              ).join('\n');
              showAlert('Dry run', `${officeLines}\n\n${resultLines}`);
            } catch (e: any) {
              showAlert('Dry run failed', e?.response?.data?.detail || e?.message);
            }
          },
        },
        {
          text: 'Restore now',
          style: 'destructive',
          onPress: async () => {
            try {
              const res = await apiService.restoreManualByName(false);
              const lines = res.data.results.map(r =>
                `${r.collection}: +${r.inserted ?? 0} new (${r.skipped_already_present ?? 0} kept, ${r.skipped_office_unmatched ?? 0} skipped)`
              ).join('\n');
              showAlert('Restore complete', lines);
            } catch (e: any) {
              showAlert('Restore failed', e?.response?.data?.detail || e?.message);
            }
          },
        },
      ],
    );
  };

  const showOfficeFilter = !!isSuperAdmin && tab === 'users' && !!offices && offices.length > 0;

  type Tool = { key: string; icon: React.ComponentProps<typeof Ionicons>['name']; title: string; sub: string; onPress: () => void; badge?: number; testID?: string };
  const tools: Tool[] = [
    { key: 'review', icon: 'podium-outline', title: 'Monday Review', sub: "Last week's numbers and plans", onPress: () => router.push('/weekly-review' as any) },
    { key: 'absences', icon: 'calendar-outline', title: 'Absence Approvals', sub: 'Approve or decline absences', badge: absPending?.pending || 0, onPress: () => router.push('/absence-approvals' as any) },
    { key: 'goals', icon: 'flag-outline', title: 'Goal Planner', sub: 'KPI and Rock suggestions', onPress: () => router.push('/planner-goal-menu') },
    { key: 'badges', icon: 'ribbon-outline', title: 'Badges', sub: 'Make, edit and print ID badges', testID: 'admin-badges', onPress: () => router.push('/badges' as any) },
    ...(isSuperAdmin ? [{ key: 'restore', icon: 'library-outline' as const, title: 'Restore Manual + Modules', sub: 'Put back anything missing', onPress: restoreBundle }] : []),
  ];

  return (
    <View
      style={[
        styles.container,
        // Pad horizontal safe-area in landscape so content clears the iPhone
        // notch / Dynamic Island / camera bump.
        isLandscape && { paddingLeft: insets.left, paddingRight: insets.right, paddingTop: insets.top },
      ]}
    >
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: tabBarClearance + 20 + kbInset }]} keyboardShouldPersistTaps="handled" onScroll={onScroll} scrollEventThrottle={16}>
        <View style={styles.shell}>
        {/* Users | Offices, and (for the Owner) which office: quiet pills, not
            page-wide rails. A plain admin has neither choice, so sees neither. */}
        {(tabItems.length > 1 || showOfficeFilter) && (
          <View style={styles.topRow}>
            {tabItems.length > 1 && (
              <View style={styles.pillGroup} accessibilityRole="tablist">
                {tabItems.map((t) => (
                  <TouchableOpacity
                    key={t.key}
                    onPress={() => setTab(t.key as 'users' | 'offices')}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: tab === t.key }}
                    style={[styles.pill, tab === t.key && styles.pillOn]}
                  >
                    <Text style={[styles.pillText, tab === t.key && styles.pillTextOn]}>{t.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
            {showOfficeFilter && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll} contentContainerStyle={styles.chipRow}>
                {officeItems.map((o) => {
                  const on = (selectedOffice ?? ALL_OFFICES_KEY) === o.key;
                  return (
                    <TouchableOpacity
                      key={o.key}
                      onPress={() => setSelectedOffice(o.key === ALL_OFFICES_KEY ? undefined : o.key)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on }}
                      style={[styles.chip, on && styles.chipOn]}
                    >
                      <Text style={[styles.chipText, on && styles.chipTextOn]}>{o.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}
          </View>
        )}

        {tab === 'users' && (
          <>
            <View style={styles.kickerRow}>
              <View style={styles.kickerBar} />
              <Text style={styles.kicker}>Office tools</Text>
            </View>
            <View style={styles.toolGrid}>
              {tools.map((t) => (
                <PressableScale key={t.key} style={styles.tool} onPress={t.onPress} testID={t.testID}>
                  <View style={styles.toolIcon}>
                    <Ionicons name={t.icon} size={17} color={colors.primary} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.toolTitle} numberOfLines={1}>{t.title}</Text>
                    <Text style={styles.toolSub} numberOfLines={1}>{t.sub}</Text>
                  </View>
                  {(t.badge || 0) > 0 && (
                    <View style={styles.pendingBadge}>
                      <Text style={{ fontFamily: fonts.mono, color: colors.textLight, fontSize: 11, fontWeight: '800' }}>{t.badge}</Text>
                    </View>
                  )}
                  <Ionicons name="chevron-forward" size={15} color={colors.textMuted} />
                </PressableScale>
              ))}
            </View>

            <View style={[styles.kickerRow, { marginTop: 22 }]}>
              <View style={styles.kickerBar} />
              <Text style={styles.kicker}>Accounts</Text>
              <Text style={styles.kickerCount}>{filteredUsers.length}</Text>
            </View>

            {/* Search, the role filter and Add, on one line where there is room. */}
            <View style={styles.toolbar}>
              <View style={styles.searchContainer}>
                <Ionicons name="search" size={16} color={colors.textMuted} />
                <TextInput
                  style={styles.searchInput}
                  testID="admin-search"
                  placeholder="Search by name or email"
                  placeholderTextColor={colors.textMuted}
                  value={search}
                  onChangeText={setSearch}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                {search.length > 0 && (
                  <TouchableOpacity onPress={() => setSearch('')} accessibilityLabel="Clear search">
                    <Ionicons name="close-circle" size={17} color={colors.textMuted} />
                  </TouchableOpacity>
                )}
              </View>
              <View style={styles.chipRow}>
                {([
                  { key: 'all', label: 'All', count: roleCounts.all },
                  { key: 'admin', label: 'Admins', count: roleCounts.admin },
                  { key: 'leader', label: 'Coaches', count: roleCounts.leader },
                  { key: 'trainee', label: 'BAs', count: roleCounts.trainee },
                ] as const).map((f) => {
                  const on = roleFilter === f.key;
                  return (
                    <TouchableOpacity key={f.key} style={[styles.chip, on && styles.chipOn]} onPress={() => setRoleFilter(f.key)}
                      accessibilityRole="button" accessibilityState={{ selected: on }}>
                      <Text style={[styles.chipText, on && styles.chipTextOn]}>{f.label}</Text>
                      <Text style={[styles.chipCount, on && styles.chipTextOn]}>{f.count}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <TouchableOpacity style={styles.addBtn} onPress={() => setShowAdd(true)} accessibilityRole="button" testID="admin-add">
                <Ionicons name="person-add" size={15} color={colors.onPrimary} />
                <Text style={styles.addBtnText}>Add Coach / BA</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.accountsHint}>Tap a name for that person's full breakdown and badge. Tap the row to edit their account.</Text>

            {uL ? <Skeleton.List kind="card" count={4} /> : (
              filteredUsers.length === 0 ? (
                <EmptyState
                  compact
                  icon="search-outline"
                  title="No accounts found"
                  subtitle="Try a different search or role filter."
                />
              ) : (
                <View style={styles.list} onLayout={(e) => setListW(e.nativeEvent.layout.width)}>
                  {wideList && (
                    <View style={styles.listHead}>
                      <Text style={[styles.th, styles.colName]}>Name</Text>
                      <Text style={[styles.th, styles.colRole]}>Role</Text>
                      <Text style={[styles.th, styles.colCoach]}>Coach</Text>
                      <Text style={[styles.th, styles.colBadge]}>Badge no.</Text>
                      <Text style={[styles.th, styles.colEmail]}>Email</Text>
                      <View style={{ width: 16 }} />
                    </View>
                  )}
                  {filteredUsers.map((u: any, i: number) => {
                    const open = openId === u.id;
                    const coachName: string | null = u.reports_to ? ((users as any[])?.find((l: any) => l.id === u.reports_to)?.name || null) : null;
                    const codes = (u.amplifi_codes || []) as string[];
                    const tone = u.role === 'admin' ? colors.primary : u.role === 'trainee' ? colors.green : colors.yellow;
                    const isPlus = u.role === 'leader' && !!u.coach_plus;
                    const openPerson = () => router.push(`/person/${u.id}` as any);
                    return (
                      <View key={u.id} style={[styles.row, (i > 0 || wideList) && styles.rowLine, open && styles.rowOpen]}>
                        <TouchableOpacity
                          activeOpacity={0.7}
                          style={styles.rowHead}
                          onPress={() => setOpenId(open ? null : u.id)}
                          accessibilityRole="button"
                          accessibilityState={{ expanded: open }}
                          accessibilityLabel={`${u.name}, ${levelWord(u)}. ${open ? 'Hide' : 'Show'} account details`}
                          testID={`admin-row-${u.id}`}
                        >
                          <View style={[styles.colName, { flexDirection: 'row', alignItems: 'center', gap: 10 }]}>
                            {u.profile_image ? (
                              <Image source={{ uri: u.profile_image }} style={styles.userAvatar} />
                            ) : (
                              <View style={styles.userAvatarFallback}>
                                <Text style={styles.userAvatarText}>{u.name?.charAt(0)?.toUpperCase() || '?'}</Text>
                              </View>
                            )}
                            <View style={{ flex: 1, minWidth: 0 }}>
                              <TouchableOpacity
                                style={styles.nameLink}
                                onPress={openPerson}
                                accessibilityRole="link"
                                accessibilityLabel={`Open ${u.name}'s breakdown`}
                                testID={`admin-person-${u.id}`}
                              >
                                <Text style={styles.userName} numberOfLines={1}>{u.name}</Text>
                                <Ionicons name="chevron-forward" size={13} color={colors.primary} />
                              </TouchableOpacity>
                              {!wideList && (
                                <View style={styles.rowSubRow}>
                                  <View style={[styles.roleDot, { backgroundColor: tone }]} />
                                  <Text style={styles.rowSub} numberOfLines={1}>
                                    {[levelWord(u), coachName ? `Coach: ${coachName}` : null, codes[0] || null].filter(Boolean).join(' · ')}
                                  </Text>
                                </View>
                              )}
                            </View>
                          </View>
                          {wideList && (
                            <>
                              <View style={[styles.colRole, { flexDirection: 'row', alignItems: 'center', gap: 6 }]}>
                                <View style={[styles.roleDot, { backgroundColor: tone }]} />
                                <Text style={[styles.cell, isPlus && { fontFamily: fonts.bodyBold, color: colors.text }]}>{levelWord(u)}</Text>
                              </View>
                              <Text style={[styles.cell, styles.colCoach, !coachName && styles.cellEmpty]} numberOfLines={1}>{coachName || '–'}</Text>
                              <Text style={[styles.cell, styles.colBadge, styles.cellMono, !codes.length && styles.cellEmpty]} numberOfLines={1}>{codes.join(', ') || '–'}</Text>
                              <Text style={[styles.cell, styles.colEmail, styles.cellSoft]} numberOfLines={1}>{u.email}</Text>
                            </>
                          )}
                          <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textMuted} />
                        </TouchableOpacity>

                        {open && (
                          <View style={styles.rowBody}>
                            <View style={styles.fieldGrid}>
                              {u.role !== 'admin' && (
                                <View style={styles.field}>
                                  <Text style={styles.fieldLabel}>Name</Text>
                                  {editingUserId === u.id ? (
                                    <View style={styles.editNameRow}>
                                      <TextInput style={styles.editNameInput} value={editName} onChangeText={setEditName} autoFocus autoCapitalize="words"
                                        placeholder="Enter name" placeholderTextColor={colors.textMuted} />
                                      <TouchableOpacity style={styles.editNameSave} onPress={() => {
                                        if (!editName.trim()) { showAlert('Error', 'Name cannot be empty'); return; }
                                        renameMut.mutate({ id: u.id, name: editName.trim() });
                                      }}>
                                        <Ionicons name="checkmark" size={18} color={colors.green} />
                                      </TouchableOpacity>
                                      <TouchableOpacity style={styles.editNameCancel} onPress={() => { setEditingUserId(null); setEditName(''); }}>
                                        <Ionicons name="close" size={18} color={colors.red} />
                                      </TouchableOpacity>
                                    </View>
                                  ) : (
                                    <TouchableOpacity style={styles.fieldValueRow} onPress={() => { setEditingUserId(u.id); setEditName(u.name); }} accessibilityLabel={`Edit ${u.name}'s name`}>
                                      <Text style={styles.fieldValue} numberOfLines={1}>{u.name}</Text>
                                      <Ionicons name="pencil" size={12} color={colors.primary} />
                                    </TouchableOpacity>
                                  )}
                                </View>
                              )}
                              <View style={styles.field}>
                                <Text style={styles.fieldLabel}>Email</Text>
                                {editingEmailUserId === u.id ? (
                                  <View style={styles.editNameRow}>
                                    <TextInput style={styles.editNameInput} value={editEmail} onChangeText={setEditEmail} autoFocus autoCapitalize="none" autoCorrect={false}
                                      keyboardType="email-address" placeholder="Enter email" placeholderTextColor={colors.textMuted} />
                                    <TouchableOpacity style={styles.editNameSave} onPress={() => {
                                      const v = editEmail.trim().toLowerCase();
                                      if (!v) { showAlert('Error', 'Email cannot be empty'); return; }
                                      changeEmailMut.mutate({ id: u.id, email: v });
                                    }}>
                                      <Ionicons name="checkmark" size={18} color={colors.green} />
                                    </TouchableOpacity>
                                    <TouchableOpacity style={styles.editNameCancel} onPress={() => { setEditingEmailUserId(null); setEditEmail(''); }}>
                                      <Ionicons name="close" size={18} color={colors.red} />
                                    </TouchableOpacity>
                                  </View>
                                ) : (
                                  <TouchableOpacity style={styles.fieldValueRow} onPress={() => { setEditingEmailUserId(u.id); setEditEmail(u.email); }} accessibilityLabel={`Edit ${u.name}'s email`}>
                                    <Text style={styles.fieldValue} numberOfLines={1}>{u.email}</Text>
                                    <Ionicons name="pencil" size={12} color={colors.primary} />
                                  </TouchableOpacity>
                                )}
                              </View>
                              {/* Phone: tap the number to call; the pencil edits it. */}
                              <View style={styles.field}>
                                <Text style={styles.fieldLabel}>Phone</Text>
                                {editingPhoneUserId === u.id ? (
                                  <View style={styles.editNameRow}>
                                    <TextInput style={styles.editNameInput} value={editPhone} onChangeText={setEditPhone} autoFocus keyboardType="phone-pad"
                                      placeholder="Mobile, e.g. 07123 456789" placeholderTextColor={colors.textMuted} />
                                    <TouchableOpacity style={styles.editNameSave} onPress={() => changePhoneMut.mutate({ id: u.id, phone: editPhone.trim() })}>
                                      <Ionicons name="checkmark" size={18} color={colors.green} />
                                    </TouchableOpacity>
                                    <TouchableOpacity style={styles.editNameCancel} onPress={() => { setEditingPhoneUserId(null); setEditPhone(''); }}>
                                      <Ionicons name="close" size={18} color={colors.red} />
                                    </TouchableOpacity>
                                  </View>
                                ) : (
                                  <View style={styles.fieldValueRow}>
                                    {u.phone ? (
                                      <TouchableOpacity style={styles.phoneLink} onPress={() => openPhone(u.phone)} accessibilityRole="button"
                                        accessibilityLabel={`Call ${u.name || u.email} at ${u.phone}`}>
                                        <Ionicons name="call" size={12} color={colors.green} />
                                        <Text style={styles.phoneLinkText}>{u.phone}</Text>
                                      </TouchableOpacity>
                                    ) : (
                                      <Text style={[styles.cell, styles.cellEmpty]} numberOfLines={1}>No phone number</Text>
                                    )}
                                    <TouchableOpacity onPress={() => { setEditingPhoneUserId(u.id); setEditPhone(u.phone || ''); }} style={styles.editNameBtn} accessibilityLabel={`Edit ${u.name}'s phone number`}>
                                      <Ionicons name="pencil" size={12} color={colors.primary} />
                                    </TouchableOpacity>
                                  </View>
                                )}
                              </View>
                              {!u.is_super_admin && (
                                <View style={styles.field}>
                                  <Text style={styles.fieldLabel}>Coach</Text>
                                  <TouchableOpacity style={styles.fieldValueRow} onPress={() => showLeaderPicker(u.id, u.reports_to, u.name)}>
                                    <Text style={[styles.fieldValue, !u.reports_to && styles.cellEmpty]} numberOfLines={1}>
                                      {u.reports_to ? (coachName || 'Unknown') : 'No Coach assigned'}
                                    </Text>
                                    <Ionicons name="swap-horizontal" size={13} color={colors.primary} />
                                  </TouchableOpacity>
                                </View>
                              )}
                              {/* Badge number: links them to their OwnerIQ numbers. */}
                              <View style={styles.field}>
                                <Text style={styles.fieldLabel}>Badge number</Text>
                                <TouchableOpacity style={styles.fieldValueRow}
                                  onPress={() => setAmplifiPicker({ userId: u.id, userName: u.name || u.email, codes: codes.join(', ') })}>
                                  <Text style={[styles.fieldValue, !codes.length && styles.cellEmpty]} numberOfLines={1}>{codes.length ? codes.join(', ') : 'Add badge number'}</Text>
                                  <Ionicons name="pencil" size={12} color={colors.primary} />
                                </TouchableOpacity>
                              </View>
                              {isSuperAdmin && offices && (
                                <View style={styles.field}>
                                  <Text style={styles.fieldLabel}>Office</Text>
                                  <TouchableOpacity style={styles.fieldValueRow} onPress={() => showOfficePicker(u.id, u.office_id)}>
                                    <Text style={styles.fieldValue} numberOfLines={1}>{offices.find((o: any) => o.id === u.office_id)?.name || 'No office'}</Text>
                                    <Ionicons name="swap-horizontal" size={13} color={colors.primary} />
                                  </TouchableOpacity>
                                </View>
                              )}
                            </View>

                            <View style={styles.actionRow}>
                              <TouchableOpacity style={[styles.act, styles.actPrimary]} onPress={openPerson}>
                                <Ionicons name="stats-chart" size={14} color={colors.onPrimary} />
                                <Text style={[styles.actText, { color: colors.onPrimary }]}>Full breakdown</Text>
                              </TouchableOpacity>
                              {u.role === 'trainee' && (
                                <TouchableOpacity style={styles.act} onPress={() => showAlert('Advance to Stage 3', `Advance ${u.name} to Stage 3 as a coach?`, [
                                  { text: 'Cancel', style: 'cancel' },
                                  { text: 'Advance', onPress: () => promoteMut.mutate({ id: u.id, role: 'leader' }) },
                                ])}>
                                  <Ionicons name="arrow-up-circle-outline" size={15} color={colors.green} />
                                  <Text style={styles.actText}>Advance to Coach</Text>
                                </TouchableOpacity>
                              )}
                              {u.role === 'leader' && !isPlus && (
                                <TouchableOpacity style={styles.act} testID={`admin-coach-plus-${u.id}`} onPress={() => showAlert('Make Coach+',
                                  `${u.name} will see the whole office in Live Operations, the Performance Hub and Field KPIs, and can make and print anyone's ID badge.`, [
                                    { text: 'Cancel', style: 'cancel' },
                                    { text: 'Make Coach+', onPress: () => coachPlusMut.mutate({ id: u.id, enabled: true }) },
                                  ])}>
                                  <Ionicons name="add-circle-outline" size={15} color={colors.primary} />
                                  <Text style={styles.actText}>Make Coach+</Text>
                                </TouchableOpacity>
                              )}
                              {isPlus && (
                                <TouchableOpacity style={styles.act} testID={`admin-coach-plus-${u.id}`} onPress={() => showAlert('Back to Coach',
                                  `${u.name} goes back to seeing their own team only, and loses access to badges.`, [
                                    { text: 'Cancel', style: 'cancel' },
                                    { text: 'Back to Coach', style: 'destructive', onPress: () => coachPlusMut.mutate({ id: u.id, enabled: false }) },
                                  ])}>
                                  <Ionicons name="remove-circle-outline" size={15} color={colors.yellow} />
                                  <Text style={styles.actText}>Remove Coach+</Text>
                                </TouchableOpacity>
                              )}
                              {u.role === 'leader' && (
                                <TouchableOpacity style={styles.act} onPress={() => showAlert('Make Admin', `Give ${u.name} admin access?`, [
                                  { text: 'Cancel', style: 'cancel' },
                                  { text: 'Make Admin', onPress: () => promoteMut.mutate({ id: u.id, role: 'admin' }) },
                                ])}>
                                  <Ionicons name="arrow-up-circle-outline" size={15} color={colors.primary} />
                                  <Text style={styles.actText}>Make Admin</Text>
                                </TouchableOpacity>
                              )}
                              {u.role === 'leader' && (
                                <TouchableOpacity style={styles.act} onPress={() => showAlert('Move back to BA', `Move ${u.name} from coach back to BA? Their Day 1–8 record reopens.`, [
                                  { text: 'Cancel', style: 'cancel' },
                                  { text: 'Move back', style: 'destructive', onPress: () => promoteMut.mutate({ id: u.id, role: 'trainee' }) },
                                ])}>
                                  <Ionicons name="arrow-down-circle-outline" size={15} color={colors.yellow} />
                                  <Text style={styles.actText}>Move back to BA</Text>
                                </TouchableOpacity>
                              )}
                              {u.role === 'admin' && !u.is_super_admin && u.id !== user?.id && (
                                <TouchableOpacity style={styles.act} onPress={() => showAlert('Remove admin access', `Move ${u.name} from admin back to coach?`, [
                                  { text: 'Cancel', style: 'cancel' },
                                  { text: 'Remove admin', style: 'destructive', onPress: () => promoteMut.mutate({ id: u.id, role: 'leader' }) },
                                ])}>
                                  <Ionicons name="arrow-down-circle-outline" size={15} color={colors.yellow} />
                                  <Text style={styles.actText}>Remove admin access</Text>
                                </TouchableOpacity>
                              )}
                              {u.profile_image && (
                                <TouchableOpacity style={styles.act} onPress={() => showAlert('Remove Photo', `Remove ${u.name}'s profile picture?`, [
                                  { text: 'Cancel', style: 'cancel' },
                                  { text: 'Remove', style: 'destructive', onPress: () => removePhotoMut.mutate(u.id) },
                                ])}>
                                  <Ionicons name="image-outline" size={15} color={colors.textMuted} />
                                  <Text style={styles.actText}>Remove photo</Text>
                                </TouchableOpacity>
                              )}
                              {!u.is_super_admin && (
                                <TouchableOpacity style={[styles.act, styles.actDanger]} onPress={() => showAlert('Delete', `Remove ${u.name}?`, [
                                  { text: 'Cancel', style: 'cancel' },
                                  { text: 'Delete', style: 'destructive', onPress: () => deleteMut.mutate(u.id) },
                                ])}>
                                  <Ionicons name="trash-outline" size={14} color={colors.red} />
                                  <Text style={[styles.actText, { color: colors.red }]}>Delete</Text>
                                </TouchableOpacity>
                              )}
                            </View>
                          </View>
                        )}
                      </View>
                    );
                  })}
                </View>
              )
            )}
          </>
        )}

        {/* Offices Tab (Super Admin) */}
        {tab === 'offices' && isSuperAdmin && (
          <>
            <GlowButton breathe style={styles.addBtn} onPress={async () => {
              const name = await promptText('New Office', 'Office name:');
              if (!name) return;
              try {
                await apiService.createOffice({ name, city: name, state: '' });
                queryClient.invalidateQueries({ queryKey: ['offices'] });
                showAlert('Created', `Office "${name}" created`);
              } catch (e: any) {
                showAlert('Couldn\'t create office', e?.response?.data?.detail || 'Please try again.');
              }
            }}>
              <Ionicons name="add-circle" size={20} color={colors.textLight} />
              <Text style={styles.addBtnText}>Create New Office</Text>
            </GlowButton>

            {/* List rows never carry the sheen (spec §5) — the office-tool
                cards and the search well already hold this screen's quota. */}
            {offices && offices.map((o: any, i: number) => (
              <DepthCard key={o.id} index={i} sheen={false} style={styles.officeCard}>
                <View style={styles.officeCardHeader}>
                  <Ionicons name="business" size={22} color={colors.primary} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.officeCardName}>{o.name}</Text>
                    <Text style={styles.officeCardLocation}>{o.city}{o.state ? `, ${o.state}` : ''}</Text>
                  </View>
                  <TouchableOpacity onPress={() => showAlert('Delete Office', `Remove "${o.name}"?`, [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Delete', style: 'destructive', onPress: () => apiService.deleteOffice(o.id).then(() => queryClient.invalidateQueries({ queryKey: ['offices'] })) },
                  ])}>
                    <Ionicons name="trash-outline" size={18} color={colors.red} />
                  </TouchableOpacity>
                </View>
                {/* Public Bells share link */}
                <BellsShareCodeRow officeId={o.id} officeName={o.name} />
              </DepthCard>
            ))}
          </>
        )}
        </View>
      </ScrollView>

      {/* Add Coach / BA Modal — admin shortcut bypassing OTP */}
      <Modal visible={showAdd} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { maxHeight: '92%' }]}>
            <ScrollView contentContainerStyle={{ paddingBottom: 4 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <Text style={styles.modalTitle}>Add {roleWord(newRole)}</Text>
              <Text style={styles.modalSubtitle}>Creates an active account immediately — no OTP required.</Text>

              {/* Role picker */}
              <Text style={styles.modalLabel}>Role</Text>
              <View style={styles.roleRow}>
                <TouchableOpacity
                  style={[styles.roleChip, newRole === 'trainee' && styles.roleChipActive]}
                  onPress={() => setNewRole('trainee')}
                >
                  <Ionicons name="school-outline" size={14} color={newRole === 'trainee' ? colors.onPrimary : colors.textMuted} />
                  <Text style={[styles.roleChipText, newRole === 'trainee' && { color: colors.onPrimary }]}>BA</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.roleChip, newRole === 'leader' && styles.roleChipActive]}
                  onPress={() => setNewRole('leader')}
                >
                  <Ionicons name="star-outline" size={14} color={newRole === 'leader' ? colors.onPrimary : colors.textMuted} />
                  <Text style={[styles.roleChipText, newRole === 'leader' && { color: colors.onPrimary }]}>Coach</Text>
                </TouchableOpacity>
              </View>

              <Text style={styles.modalLabel}>Full Name</Text>
              <TextInput style={styles.modalInput} placeholder="e.g. Jane Doe" value={newName} onChangeText={setNewName} autoCapitalize="words" placeholderTextColor={colors.textMuted} />

              <Text style={styles.modalLabel}>Email</Text>
              <TextInput style={styles.modalInput} placeholder="jane@example.com" value={newEmail} onChangeText={setNewEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" placeholderTextColor={colors.textMuted} />

              <Text style={styles.modalLabel}>Password</Text>
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                <TextInput
                  style={[styles.modalInput, { flex: 1, marginBottom: 0 }]}
                  placeholder="At least 8 characters"
                  value={newPassword}
                  onChangeText={setNewPassword}
                  autoCapitalize="none"
                  placeholderTextColor={colors.textMuted}
                />
                <TouchableOpacity style={styles.genBtn} onPress={generatePassword}>
                  <Ionicons name="dice-outline" size={16} color={colors.primary} />
                  <Text style={styles.genBtnText}>Generate</Text>
                </TouchableOpacity>
              </View>

              <Text style={styles.modalLabel}>Reports To {newRole === 'leader' ? '(optional)' : ''}</Text>
              <TouchableOpacity style={styles.pickerRow} onPress={() => setShowAddLeaderPicker(true)}>
                <Ionicons name="people-outline" size={16} color={colors.textMuted} />
                <Text style={[styles.pickerText, !reportsToName && { color: colors.textMuted }]}>
                  {reportsToName || 'Pick a coach…'}
                </Text>
                <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
              </TouchableOpacity>
              {reportsToName && (
                <TouchableOpacity onPress={() => setNewReportsTo(null)} style={{ marginTop: -4, marginBottom: 8, alignSelf: 'flex-end' }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textMuted }}>Clear</Text>
                </TouchableOpacity>
              )}

              {/* Send email toggle */}
              <TouchableOpacity
                style={styles.checkRow}
                onPress={() => setNewSendEmail(!newSendEmail)}
                activeOpacity={0.7}
              >
                <View style={[styles.checkBox, newSendEmail && styles.checkBoxOn]}>
                  {newSendEmail && <Ionicons name="checkmark" size={14} color={colors.onPrimary} />}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.checkLabel}>Email login info to {newRole === 'leader' ? 'coach' : 'BA'}</Text>
                  <Text style={styles.checkSub}>Sends a welcome email with their email + password.</Text>
                </View>
              </TouchableOpacity>

              <View style={styles.modalActions}>
                <TouchableOpacity style={styles.modalCancel} onPress={() => setShowAdd(false)}>
                  <Text style={styles.modalCancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.modalSubmit} onPress={handleCreate} disabled={createMut.isPending}>
                  <Text style={styles.modalSubmitText}>{createMut.isPending ? 'Creating…' : `Create ${roleWord(newRole)}`}</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Reports-to picker for the Add modal */}
      <ChoiceSheet
        visible={showAddLeaderPicker}
        title="Reports To"
        subtitle="Who should this user report to?"
        options={newUserLeaderOptions}
        onSelect={(parentId) => {
          setNewReportsTo(parentId);
          setShowAddLeaderPicker(false);
        }}
        onClose={() => setShowAddLeaderPicker(false)}
        destructiveOption={newReportsTo ? { label: 'No coach (top level)', value: null } : undefined}
      />

      {/* Scrollable picker — Assign Leader */}
      <ChoiceSheet
        visible={!!leaderPicker}
        title="Assign Coach"
        subtitle={leaderPicker ? `Who should ${leaderPicker.userName} report to?` : undefined}
        options={leaderPickerOptions}
        onSelect={(parentId) => {
          if (leaderPicker) {
            reportsToMut.mutate({ userId: leaderPicker.userId, parentId });
          }
          setLeaderPicker(null);
        }}
        onClose={() => setLeaderPicker(null)}
        destructiveOption={leaderPicker?.currentReportsTo ? { label: 'Remove Coach (Top Level)', value: null } : undefined}
      />

      {/* Scrollable picker — Assign Office */}
      <ChoiceSheet
        visible={!!officePicker}
        title="Assign Office"
        subtitle="Select an office for this user"
        options={officePickerOptions}
        onSelect={(officeId) => {
          if (officePicker) {
            assignOfficeMut.mutate({ userId: officePicker.userId, officeId });
          }
          setOfficePicker(null);
        }}
        onClose={() => setOfficePicker(null)}
      />

      {/* Badge numbers editor */}
      <Modal visible={!!amplifiPicker} transparent animationType="fade" onRequestClose={() => setAmplifiPicker(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
          <TouchableOpacity activeOpacity={1} onPress={() => setAmplifiPicker(null)} style={amplifiStyles(colors).overlay}>
            <TouchableOpacity activeOpacity={1} style={amplifiStyles(colors).sheet}>
              <View style={amplifiStyles(colors).handle} />
              <Text style={amplifiStyles(colors).title}>Badge Number</Text>
              <TextInput
                value={amplifiPicker?.codes || ''}
                onChangeText={(v) => setAmplifiPicker((p) => p ? { ...p, codes: v } : p)}
                placeholder="AMPB1007"
                placeholderTextColor={colors.textMuted}
                style={[amplifiStyles(colors).input, { marginTop: 12 }]}
                autoCapitalize="characters"
                autoCorrect={false}
                autoFocus
              />
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                <TouchableOpacity onPress={() => setAmplifiPicker(null)} style={[amplifiStyles(colors).btn, { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }]}>
                  <Text style={[amplifiStyles(colors).btnText, { color: colors.textSecondary }]}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => {
                    if (!amplifiPicker) return;
                    const codes = amplifiPicker.codes.split(/[\s,;]+/).map((c) => c.trim()).filter(Boolean);
                    amplifiCodesMut.mutate({ userId: amplifiPicker.userId, codes });
                  }}
                  disabled={amplifiCodesMut.isPending}
                  style={[amplifiStyles(colors).btn, { backgroundColor: colors.primary }]}
                >
                  <Text style={[amplifiStyles(colors).btnText, { color: colors.onPrimary }]}>{amplifiCodesMut.isPending ? 'Saving…' : 'Save'}</Text>
                </TouchableOpacity>
              </View>
            </TouchableOpacity>
          </TouchableOpacity>
        </KeyboardAvoidingView>
      </Modal>

    </View>
  );
}

const amplifiStyles = (colors: any) => StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 16 },
  sheet: { backgroundColor: colors.background, borderRadius: 16, padding: 20 },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginBottom: 12 },
  title: { fontFamily: fonts.display, fontSize: 17, fontWeight: '900', color: colors.text, marginBottom: 6 },
  sub: { fontSize: 12, color: colors.textMuted, marginBottom: 14, lineHeight: 17 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12, fontSize: 15, fontWeight: '700', color: colors.text, backgroundColor: colors.surface, fontVariant: ['tabular-nums'] as any },
  btn: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  btnText: { fontFamily: fonts.bodyBold, fontSize: 14, fontWeight: '800' },
});

const createStyles = (colors: any) => StyleSheet.create({
  container: { flex: 1 },
  // The ink segment rail replaces the old underlined tab strip — no page-wide
  // white band above the field any more (the rail IS the chrome).
  // marginBottom is deliberately generous: in DARK the ink rail (#0e271f) and
  // the paper office rail below it (trackBg #07110C) are only a few points
  // apart on the abyss, so without real air they read as one doubled rail.
  tabBar: { marginHorizontal: 16, marginTop: 10, marginBottom: 10 },
  // One-segment fallback (plain admin): the rail's own label treatment —
  // displayWide 11.5 uppercase — behind the brand rule, so it reads as a
  // section kicker instead of a tappable tile.
  soloTabRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14, marginBottom: 4 },
  soloTabRule: { width: 28, height: 3, borderRadius: 1.5 },
  soloTabLabel: { fontFamily: fonts.displayWide, fontSize: 11.5, letterSpacing: 1.6, textTransform: 'uppercase', color: colors.textMuted },
  syncBundleWrap: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  syncBundleBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.primary, paddingVertical: 12, paddingHorizontal: 14,
    borderRadius: 14, gap: 8,
    // Raw rgba shadow string (never a token concat) — the info-blue lift.
    boxShadow: '0 8px 18px -6px rgba(37,99,168,0.5)',
  },
  syncBundleText: { fontFamily: fonts.bodySemibold, color: colors.onPrimary, fontSize: 13, fontWeight: '700' },
  content: { padding: 16 },
  shell: { width: '100%', maxWidth: 1240, alignSelf: 'center' },
  topRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 18 },
  pillGroup: { flexDirection: 'row', padding: 3, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  pill: { minHeight: 32, paddingHorizontal: 16, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  pillOn: { backgroundColor: colors.primary },
  pillText: { fontFamily: fonts.bodySemibold, fontSize: 13, color: colors.textSecondary },
  pillTextOn: { color: colors.onPrimary },
  chipScroll: { flexGrow: 0, flexShrink: 1 },
  chipRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontFamily: fonts.bodySemibold, fontSize: 12.5, color: colors.textSecondary },
  chipTextOn: { color: colors.onPrimary },
  chipCount: { fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted },
  // Section labels: a short brand rule and a wide, tracked kicker.
  kickerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  kickerBar: { width: 18, height: 3, borderRadius: 1.5, backgroundColor: colors.primary },
  kicker: { fontFamily: fonts.displayWide, fontSize: 12, letterSpacing: 1.8, textTransform: 'uppercase', color: colors.text },
  kickerCount: { fontFamily: fonts.mono, fontSize: 11.5, color: colors.textMuted },
  toolGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tool: { flexGrow: 1, flexBasis: 230, minWidth: 210, maxWidth: 420, flexDirection: 'row', alignItems: 'center', gap: 11, minHeight: 56, paddingHorizontal: 12, paddingVertical: 9,
    borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  toolIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceAlt },
  toolTitle: { fontFamily: fonts.bodySemibold, fontSize: 13.5, color: colors.text },
  toolSub: { fontFamily: fonts.body, fontSize: 11.5, color: colors.textMuted, marginTop: 1 },
  toolbar: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  sectionHead: { marginTop: 6, marginBottom: 12, marginLeft: 2 },
  searchContainer: { flexGrow: 1, flexBasis: 220, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, height: 40, borderRadius: 12, gap: 8,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  searchInput: { flex: 1, fontFamily: fonts.body, fontSize: 14, color: colors.text, padding: 0, outlineStyle: 'none' } as any,
  list: { borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background, overflow: 'hidden' },
  listHead: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 34, paddingHorizontal: 14, backgroundColor: colors.surface },
  th: { fontFamily: fonts.mono, fontSize: 9.5, letterSpacing: 1, textTransform: 'uppercase', color: colors.textMuted },
  row: {},
  rowLine: { borderTopWidth: 1, borderTopColor: colors.border },
  rowOpen: { backgroundColor: colors.surface },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 14, paddingVertical: 7 },
  rowSubRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 1 },
  rowSub: { flex: 1, fontFamily: fonts.body, fontSize: 11.5, color: colors.textMuted },
  roleDot: { width: 7, height: 7, borderRadius: 4 },
  colName: { flex: 2.2, minWidth: 0 },
  colRole: { width: 78 },
  colCoach: { flex: 1.4, minWidth: 0 },
  colBadge: { width: 96 },
  colEmail: { flex: 2, minWidth: 0 },
  cell: { fontFamily: fonts.body, fontSize: 13, color: colors.textSecondary },
  cellSoft: { color: colors.textMuted },
  cellMono: { fontFamily: fonts.mono, fontSize: 12 },
  cellEmpty: { color: colors.textMuted, fontFamily: fonts.body },
  rowBody: { paddingHorizontal: 14, paddingBottom: 14, paddingTop: 2 },
  fieldGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  field: { flexGrow: 1, flexBasis: 240, minWidth: 200, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  fieldLabel: { fontFamily: fonts.mono, fontSize: 9.5, letterSpacing: 1, textTransform: 'uppercase', color: colors.textMuted, marginBottom: 3 },
  fieldValueRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 24 },
  fieldValue: { flex: 1, fontFamily: fonts.bodySemibold, fontSize: 13.5, color: colors.text },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  act: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  actPrimary: { backgroundColor: colors.primary, borderColor: colors.primary },
  actDanger: { borderColor: colors.red + '66' },
  actText: { fontFamily: fonts.bodySemibold, fontSize: 12.5, color: colors.text },
  filterRow: { marginBottom: 12, maxHeight: 40 },
  filterRowContent: { gap: 8 },
  filterPill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 13, paddingVertical: 9, borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  // Active = the printed ink chip (inkText on ink is 16.7:1 in both themes).
  filterPillActive: { backgroundColor: colors.ink, borderColor: colors.primaryLight, boxShadow: '0 6px 14px -5px rgba(0,0,0,0.5)' },
  // Dark only: surfaceAlt is the one fill that reads clearly above BOTH the
  // abyss page and the raised inactive pills; the ring is a boxShadow (raw
  // rgba literal, never a token concat) so the pill doesn't resize on tap.
  filterPillActiveDark: {
    backgroundColor: colors.surfaceAlt,
    boxShadow: '0 6px 14px -5px rgba(0,0,0,0.6), 0 0 0 1.5px rgba(197,227,127,0.85)',
  },
  filterPillText: { fontFamily: fonts.bodySemibold, fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  filterCount: { backgroundColor: colors.surfaceAlt, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 10, minWidth: 22, alignItems: 'center' },
  filterCountText: { fontFamily: fonts.mono, fontSize: 11, fontWeight: '700', color: colors.textMuted },
  // flexGrow/Shrink 0 keeps the row from being squeezed by the flex column, and
  // paddingVertical gives the pills clearance so web's scrollbar gutter can't
  // clip them (the old maxHeight:50 cap did exactly that).
  officeSwitcherScroll: { marginTop: 8, marginBottom: 12, marginHorizontal: 16, flexGrow: 0, flexShrink: 0 },
  officeCard: { borderRadius: 20, padding: 16, marginBottom: 12 },
  officeCardHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  officeCardName: { fontFamily: fonts.bodySemibold, fontSize: 16, fontWeight: '600', color: colors.text },
  officeCardLocation: { fontSize: 13, color: colors.textSecondary },
  addBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, height: 40, paddingHorizontal: 14, borderRadius: 12, backgroundColor: colors.primary },
  addBtnText: { fontFamily: fonts.bodySemibold, color: colors.onPrimary, fontSize: 13.5 },
  userCard: { borderRadius: 20, padding: 14, marginBottom: 12 },
  userCardRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  userAvatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.surfaceAlt },
  userAvatarFallback: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  userAvatarText: { fontFamily: fonts.bodySemibold, fontSize: 14, color: colors.primary },
  userInfo: { flex: 1 },
  roleBadge: { alignSelf: 'flex-start', marginBottom: 7 },
  userName: { flexShrink: 1, fontFamily: fonts.bodySemibold, fontSize: 14.5, color: colors.text },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  nameLink: { flexDirection: 'row', alignItems: 'center', gap: 3, minHeight: 22, alignSelf: 'flex-start', maxWidth: '100%' },
  accountsHint: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted, marginBottom: 10, marginLeft: 2 },
  editNameBtn: { padding: 4 },
  editNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  editNameInput: { flex: 1, backgroundColor: colors.surface, borderRadius: 8, borderWidth: 1, borderColor: colors.primary, paddingHorizontal: 10, paddingVertical: 6, fontSize: 15, color: colors.text },
  editNameSave: { padding: 6, backgroundColor: colors.greenBg, borderRadius: 6 },
  editNameCancel: { padding: 6, backgroundColor: colors.redBg, borderRadius: 6 },
  userEmail: { fontSize: 13, color: colors.textSecondary },
  phoneLink: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.green + '18', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  phoneLinkText: { fontFamily: fonts.bodySemibold, fontSize: 13, fontWeight: '600', color: colors.green },
  officeBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.primary + '10', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, marginTop: 4, alignSelf: 'flex-start' },
  officeBadgeText: { fontFamily: fonts.bodySemibold, fontSize: 11, fontWeight: '600', color: colors.primary },
  leaderBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.yellow + '18', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, marginTop: 4, alignSelf: 'flex-start' },
  leaderBadgeText: { fontFamily: fonts.bodySemibold, fontSize: 11, fontWeight: '600', color: colors.yellow },
  userActions: { flexDirection: 'row', gap: 12 },
  actionBtn: { padding: 4 },
  sectionTitle: { fontFamily: fonts.display, fontSize: 18, fontWeight: '600', color: colors.text, marginBottom: 16 },
  gmCard: { borderRadius: 20, marginBottom: 14 },
  gmPress: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 15 },
  gmIcon: { width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center', boxShadow: '0 6px 14px -6px rgba(16,45,37,0.75)' },
  gmTitle: { fontFamily: fonts.display, fontSize: 14.5, fontWeight: '800', color: colors.text },
  gmSub: { fontSize: 11.5, color: colors.textMuted, marginTop: 2 },
  pendingBadge: {
    backgroundColor: colors.red, borderRadius: 999, minWidth: 22, height: 22,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6, marginRight: 4,
    boxShadow: '0 0 12px rgba(220,38,38,0.55)',
  },
  rankCard: { backgroundColor: colors.background, borderRadius: 12, padding: 16, marginBottom: 12 },
  rankHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
  rankBadge: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  rankNum: { fontSize: 14, fontWeight: '700', color: colors.onPrimary },
  rankInfo: { flex: 1 },
  rankName: { fontSize: 16, fontWeight: '600', color: colors.text },
  rankEmail: { fontSize: 13, color: colors.textSecondary },
  readyBadge: { alignItems: 'center', backgroundColor: colors.greenBg, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  readyText: { fontSize: 18, fontWeight: '700', color: colors.green },
  readyLabel: { fontSize: 10, color: colors.green },
  rankStats: { flexDirection: 'row', justifyContent: 'space-between' },
  rankStat: { alignItems: 'center' },
  rankStatVal: { fontSize: 15, fontWeight: '600', color: colors.text },
  rankStatLabel: { fontSize: 10, color: colors.textMuted, marginTop: 2 },
  empty: { alignItems: 'center', paddingVertical: 40 },
  emptyText: { fontSize: 16, color: colors.textSecondary, marginTop: 12 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', paddingHorizontal: 24 },
  modalContent: { backgroundColor: colors.background, borderRadius: 16, padding: 24 },
  modalTitle: { fontFamily: fonts.display, fontSize: 20, fontWeight: '600', color: colors.text, marginBottom: 4 },
  modalSubtitle: { fontSize: 12, color: colors.textMuted, marginBottom: 14, lineHeight: 16 },
  modalLabel: { fontSize: 11, fontWeight: '800', color: colors.textMuted, letterSpacing: 0.4, textTransform: 'uppercase', marginTop: 8, marginBottom: 6 },
  modalInput: { backgroundColor: colors.surface, borderRadius: 10, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, color: colors.text, marginBottom: 12 },
  modalActions: { flexDirection: 'row', gap: 12, marginTop: 16 },

  roleRow: { flexDirection: 'row', gap: 8, marginBottom: 4 },
  roleChip: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  roleChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  roleChipText: { fontSize: 13, fontWeight: '700', color: colors.text },

  genBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, marginBottom: 12 },
  genBtnText: { fontSize: 12, fontWeight: '700', color: colors.primary },

  pickerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, marginBottom: 12 },
  pickerText: { flex: 1, fontSize: 14, fontWeight: '600', color: colors.text },

  checkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, marginTop: 4 },
  checkBox: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, marginTop: 1 },
  checkBoxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkLabel: { fontSize: 14, fontWeight: '700', color: colors.text },
  checkSub: { fontSize: 11, color: colors.textMuted, marginTop: 2, lineHeight: 14 },
  modalCancel: { flex: 1, paddingVertical: 14, borderRadius: 10, borderWidth: 1, borderColor: colors.border, alignItems: 'center' },
  modalCancelText: { fontFamily: fonts.bodySemibold, color: colors.textSecondary, fontWeight: '600' },
  modalSubmit: { flex: 2, paddingVertical: 14, borderRadius: 10, backgroundColor: colors.primary, alignItems: 'center' },
  modalSubmitText: { fontFamily: fonts.bodySemibold, color: colors.onPrimary, fontWeight: '600' },
});


// ─── Bells Public Share Code manager for an office (super admin only) ───
// Matches SHARE_CODE_MIN_LENGTH in backend/routes/bells.py.
const SHARE_CODE_MIN_LENGTH = 16;

function BellsShareCodeRow({ officeId, officeName }: { officeId: string; officeName: string }) {
  const colors = useColors();
  const shareStyles = useMemo(() => createShareStyles(colors), [colors]);

  const queryClient = useQueryClient();
  const [codeInput, setCodeInput] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [justSaved, setJustSaved] = React.useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['office-share-code', officeId],
    queryFn: () => apiService.getOfficeShareCode(officeId).then((r: any) => r.data),
  });

  React.useEffect(() => {
    if (data?.share_code !== undefined) {
      setCodeInput(data.share_code || '');
    }
  }, [data?.share_code]);

  const baseUrl = React.useMemo(() => {
    // Prefer the public backend URL (stable, shareable across devices).
    // Fall back to window.location.origin for local dev.
    const envBase = (process.env.EXPO_PUBLIC_BACKEND_URL || '').replace(/\/$/, '');
    if (envBase) return envBase;
    if (typeof window !== 'undefined' && (window as any).location) {
      return (window as any).location.origin;
    }
    return '';
  }, []);
  const slug = data?.slug || '';
  const publicUrl = slug ? `${baseUrl}/public/bells/${slug}` : '';

  const save = async (generate = false) => {
    const trimmed = codeInput.trim();
    if (!generate && trimmed && trimmed.length < SHARE_CODE_MIN_LENGTH) {
      showAlert('Code too short', `Use at least ${SHARE_CODE_MIN_LENGTH} characters, or tap Generate for a random one.`);
      return;
    }
    setSaving(true);
    try {
      if (generate) await apiService.generateOfficeShareCode(officeId);
      else await apiService.setOfficeShareCode(officeId, trimmed);
      queryClient.invalidateQueries({ queryKey: ['office-share-code', officeId] });
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 1500);
    } catch (e: any) {
      showAlert('Error', e?.response?.data?.detail || 'Failed to save share code.');
    } finally {
      setSaving(false);
    }
  };

  const [copiedPulse, setCopiedPulse] = React.useState(false);
  const copyUrl = async () => {
    if (!publicUrl) return;
    const fullUrl = codeInput.trim() ? `${publicUrl}?code=${encodeURIComponent(codeInput.trim())}` : publicUrl;
    try {
      await Clipboard.setStringAsync(fullUrl);
    } catch {
      // expo-clipboard should always succeed on web + native; no-op fallback
    }
    setCopiedPulse(true);
    setTimeout(() => setCopiedPulse(false), 1500);
  };

  const hasCode = !!(data?.share_code);
  const currentCode = data?.share_code || '';

  return (
    <View style={shareStyles.wrap}>
      <View style={shareStyles.headerRow}>
        <Ionicons name="link-outline" size={14} color={colors.primary} />
        <Text style={shareStyles.title}>Public Bells Share Link</Text>
        {hasCode ? (
          <View style={shareStyles.activePill}><Text style={shareStyles.activePillText}>Active</Text></View>
        ) : (
          <View style={shareStyles.inactivePill}><Text style={shareStyles.inactivePillText}>Disabled</Text></View>
        )}
      </View>

      {isLoading ? (
        <ActivityIndicator size="small" color={colors.primary} />
      ) : (
        <>
          {hasCode && publicUrl ? (
            <TouchableOpacity onPress={copyUrl} style={shareStyles.urlBox}>
              <Text style={shareStyles.urlText} numberOfLines={1}>{publicUrl}</Text>
              <View style={shareStyles.copyBtn}>
                <Ionicons name={copiedPulse ? 'checkmark' : 'copy-outline'} size={13} color={copiedPulse ? colors.sgreen : colors.primary} />
                <Text style={[shareStyles.copyBtnText, copiedPulse && { color: colors.sgreen }]}>{copiedPulse ? 'Copied!' : 'Copy'}</Text>
              </View>
            </TouchableOpacity>
          ) : null}

          <View style={shareStyles.codeRow}>
            <TextInput
              style={shareStyles.codeInput}
              value={codeInput}
              onChangeText={setCodeInput}
              placeholder={`Tap Generate, or type ${SHARE_CODE_MIN_LENGTH}+ characters`}
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={80}
            />
            <TouchableOpacity
              style={[shareStyles.saveBtn, saving && { opacity: 0.5 }]}
              disabled={saving}
              onPress={() => save(true)}
            >
              <Text style={shareStyles.saveBtnText}>Generate</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[shareStyles.saveBtn, saving && { opacity: 0.5 }]}
              disabled={saving}
              onPress={() => save(false)}
            >
              {justSaved ? (
                <Ionicons name="checkmark" size={14} color={colors.onPrimary} />
              ) : (
                <Text style={shareStyles.saveBtnText}>{saving ? '...' : 'Save'}</Text>
              )}
            </TouchableOpacity>
          </View>
          {hasCode && codeInput.trim() === currentCode ? (
            <Text style={shareStyles.hint}>
              Share this URL with non-app users. They'll need the code above to unlock it.
            </Text>
          ) : codeInput.trim() ? (
            <Text style={shareStyles.hintWarning}>Tap Save to apply your changes.</Text>
          ) : (
            <Text style={shareStyles.hint}>
              Leave empty and Save to disable public sharing for {officeName}.
            </Text>
          )}
        </>
      )}
    </View>
  );
}

const createShareStyles = (colors: any) => StyleSheet.create({
  wrap: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  title: { fontFamily: fonts.bodySemibold, fontSize: 13, fontWeight: '700', color: colors.text, flex: 1 },
  activePill: { backgroundColor: colors.sgreen, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 },
  activePillText: { fontFamily: fonts.bodyBold, fontSize: 10, fontWeight: '800', color: colors.textLight, letterSpacing: 0.5 },
  inactivePill: { backgroundColor: colors.textMuted, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 },
  inactivePillText: { fontFamily: fonts.bodyBold, fontSize: 10, fontWeight: '800', color: colors.textLight, letterSpacing: 0.5 },
  urlBox: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, gap: 8, marginBottom: 8 },
  urlText: { flex: 1, fontSize: 12, color: colors.primary, fontFamily: fonts.mono },
  copyBtn: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  copyBtnText: { fontFamily: fonts.bodySemibold, fontSize: 11, color: colors.primary, fontWeight: '700' },
  codeRow: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  codeInput: { flex: 1, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, color: colors.text },
  saveBtn: { backgroundColor: colors.primary, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 8 },
  saveBtnText: { fontFamily: fonts.bodySemibold, color: colors.onPrimary, fontSize: 13, fontWeight: '700' },
  hint: { fontSize: 11, color: colors.textMuted, marginTop: 6, fontStyle: 'italic' },
  hintWarning: { fontFamily: fonts.bodySemibold, fontSize: 11, color: colors.yellow, marginTop: 6, fontWeight: '600' },
});

/* __theme_static_fallback__ */
// Fallback static styles (used if a sub-component didn't pick up the
// useColors hook). Always light-mode — won't react to theme changes.
const styles = createStyles(lightColors);
const shareStyles = createShareStyles(lightColors);
