import React, { useState, useMemo } from 'react';
import { showAlert } from '../../src/utils/showAlert';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, Image, Switch, Modal } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsLandscape } from '../../src/hooks/useIsLandscape';
import { useTabBarClearance } from '../../src/customization/CustomTabBar';
import { useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { colors } from '../../src/theme/colors';
import { lightColors } from '../../src/theme/ThemeContext';
import { useColors, useTheme, fonts, type ThemeMode } from '../../src/theme/ThemeContext';
import { useAuth } from '../../src/auth/AuthContext';
import { setAuthTokens } from '../../src/auth/tokenStorage';
import { toast } from '../../src/utils/toast';
import { apiService } from '../../src/api/client';
import { getScheduleRemindersEnabled, setScheduleRemindersEnabled } from '../../src/utils/notificationPrefs';
import { clearAllScheduledForUser, rescheduleAllForUser } from '../../src/utils/scheduleNotifications';
import { useTabPrefs } from '../../src/customization/TabPrefsContext';
import { MAX_BOTTOM_TABS } from '../../src/customization/tabRegistry';
import { ChoiceSheet, ChoiceOption } from '../../src/components/ChoiceSheet';
import { useActiveOffice } from '../../src/office/ActiveOfficeContext';
import WebPushToggle from '../../src/components/settings/WebPushToggle';
import { ScrollReveal } from '../../src/components/ui/ScrollFx';
import { useParallaxScroll } from '../../src/components/ui/Parallax';
import { LinearGradient } from 'expo-linear-gradient';
import { GRADIENT, GRADIENT_FULL } from '../../src/theme/brand';
import { EditorialHero } from '../../src/components/ui/EditorialHero';
import { DepthCard } from '../../src/components/ui/DepthCard';
import { OrbitRing, orbitRingInnerSize } from '../../src/components/ui/OrbitRing';
import { HexCoin, type HexCoinTint } from '../../src/components/ui/HexCoin';
import { HexFrame } from '../../src/components/ui/HexFrame';
import { RankRibbon, type RankRibbonTint } from '../../src/components/ui/RankRibbon';
import { Keycap } from '../../src/components/ui/Keycap';
import { SectionHead } from '../../src/components/ui/SectionHead';
import { Reveal } from '../../src/components/ui/Reveal';
import { rankTitle, roleWord } from '../../src/utils/roleTitle';
import { APP_LOCALE } from '../../src/utils/appTime';

// ── Hero geometry ("Ink & Cube" §4 Profile) ──────────────────────────────────
const AVATAR_RING = 96;                                  // OrbitRing outer diameter
const AVATAR_SIZE = orbitRingInnerSize(AVATAR_RING);     // 82px avatar inside the rings
const ROLE_COIN = 32;                                    // static HexCoin badge (no loop at ≤32)
const HERO_OVERLAP = 18;                                 // px the "Preview as…" card rides up
/**
 * The hero's Vertex X, bleeding off the top-right of the ink block. Offsets
 * keep the OrbitRing's clear space.
 */
const HERO_CUBE = {
  size: 200,
  opacity: 0.68,
  right: -40,
  top: -50,
} as const;

/** Role → ribbon tint (admin purple / leader amber / trainee green). */
function roleRibbonTint(role?: string): RankRibbonTint {
  return role === 'admin' ? 'purple' : role === 'leader' ? 'amber' : 'green';
}
/** Role → coin metal (HexCoin has no amber, so leaders get gold). */
function roleCoinTint(role?: string): HexCoinTint {
  return role === 'admin' ? 'purple' : role === 'leader' ? 'gold' : 'green';
}
/** Role → coin glyph (rendered on the coin's un-rotated overlay). */
function roleCoinIcon(role?: string): keyof typeof Ionicons.glyphMap {
  return role === 'admin' ? 'shield-checkmark' : role === 'leader' ? 'star' : 'flash';
}
/**
 * Unbounded-Black is a very wide face, so a fixed 30px hero name ellipsises
 * long names ("Visual QA (temp…") and wraps two-word ones onto a second line
 * away from the pencil. Step the SIZE down with the length instead — the
 * string itself never changes, and every name lands on ≤2 full lines.
 * (adjustsFontSizeToFit is a no-op on react-native-web, so this is manual.)
 */
function heroNameType(name?: string): { fontSize: number; lineHeight: number } {
  const n = (name || '').trim().length;
  const fontSize = n <= 12 ? 30 : n <= 15 ? 26 : n <= 24 ? 22 : 19;
  return { fontSize, lineHeight: Math.round(fontSize * 1.2) };
}
/**
 * Opaque blend of two 6-digit hex colours: `t` = 0 → a, 1 → b. Used for the
 * Quick Access wells (tint over the key face, so the gradient rim underneath
 * never shows through a translucent fill) and for pulling each spectrum hue
 * toward ink / white so the glyph stays readable on the key.
 */
function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1, 7), 16);
  const pb = parseInt(b.slice(1, 7), 16);
  const ch = (shift: number) => Math.round(((pa >> shift) & 255) * (1 - t) + ((pb >> shift) & 255) * t);
  return '#' + [16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('');
}

/**
 * IconWell — the 38px gradient-rimmed key every settings row hangs its icon
 * in (the same rim + tinted-face recipe as the Quick Access keycaps, so the
 * list reads as one system). `tone="red"` for the destructive Sign Out row.
 * Static: one LinearGradient + one View, no shadow, no loop.
 */
const ICON_WELL = 38;
const ICON_WELL_RADIUS = 12;
function IconWell({ children, tone = 'brand' }: { children: React.ReactNode; tone?: 'brand' | 'red' }) {
  const colors = useColors();
  const stops = tone === 'red' ? ([colors.red, '#b91c1c'] as const) : GRADIENT;
  const fill = mixHex(tone === 'red' ? colors.red : colors.primary, colors.background, 0.88);
  return (
    <LinearGradient
      colors={stops}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={{ width: ICON_WELL, height: ICON_WELL, borderRadius: ICON_WELL_RADIUS, padding: 1.5 }}
    >
      <View style={{ flex: 1, borderRadius: ICON_WELL_RADIUS - 1.5, backgroundColor: fill, alignItems: 'center', justifyContent: 'center' }}>
        {children}
      </View>
    </LinearGradient>
  );
}

export default function ProfileScreen() {
  const colors = useColors();
  const styles = useMemo(() => createStyles3(colors), [colors]);

  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const isLandscape = useIsLandscape();
  const router = useRouter();
  const { user, setUser, realUser, isPreviewing, startPreview, logout } = useAuth();
  const isAdmin = user?.role === 'admin';
  const queryClient = useQueryClient();
  const { officeId } = useActiveOffice();
  const [showPreviewPicker, setShowPreviewPicker] = useState(false);
  const canPreview = !!realUser?.is_super_admin;
  const showPreviewCard = canPreview && !isPreviewing;
  const previewCandidatesQ = useQuery({
    queryKey: ['preview-candidates', officeId],
    queryFn: () => apiService.getUsers(officeId).then((res: any) => res.data as any[]),
    // Not while previewing: the request would carry the view-as header, hit
    // the admin-only endpoint as the previewed trainee, and 403-retry-loop.
    enabled: canPreview && !!officeId && !isPreviewing,
    staleTime: 60_000,
  });
  const previewOptions: ChoiceOption<string>[] = useMemo(() => {
    const rows = (previewCandidatesQ.data || []).filter(
      (u: any) => (u.role === 'trainee' || u.role === 'leader') && u.is_active !== false,
    );
    return rows.map((u: any) => ({
      label: u.name,
      subtitle: `${roleWord(u.role)} · ${u.email}`,
      value: u.id,
    }));
  }, [previewCandidatesQ.data]);
  const handleSelectPreview = (userId: string) => {
    const target = (previewCandidatesQ.data || []).find((u: any) => u.id === userId);
    setShowPreviewPicker(false);
    if (!target) return;
    startPreview({ id: target.id, name: target.name, role: target.role, email: target.email });
    router.replace('/(tabs)');
  };
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showEditName, setShowEditName] = useState(false);
  const [editNameValue, setEditNameValue] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [showEditPhone, setShowEditPhone] = useState(false);
  const [editPhoneValue, setEditPhoneValue] = useState('');
  const [savingPhone, setSavingPhone] = useState(false);
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [showCurrentPw, setShowCurrentPw] = useState(false);
  const [showNewPw, setShowNewPw] = useState(false);
  const [uploading, setUploading] = useState(false);
  const { scrollY, onScroll } = useParallaxScroll();

  const handleSaveName = async () => {
    const trimmed = (editNameValue || '').trim();
    if (!trimmed) {
      showAlert('Required', 'Name cannot be empty.');
      return;
    }
    if (trimmed === (user?.name || '').trim()) {
      setShowEditName(false);
      return;
    }
    try {
      setSavingName(true);
      const { data } = await apiService.updateMyName(trimmed);
      // Optimistically refresh AuthContext so the new name shows immediately
      // everywhere (header, bulletin, leaderboards). The bulletin endpoint
      // also resolves names live from `users.name` so it picks up on the next
      // refetch automatically.
      if (user) setUser({ ...user, name: data?.name ?? trimmed });
      queryClient.invalidateQueries();
      toast.success('Name updated', `Saved as "${data?.name ?? trimmed}"`);
      setShowEditName(false);
    } catch (e: any) {
      showAlert('Error', e?.response?.data?.detail || 'Could not update name. Try again.');
    } finally {
      setSavingName(false);
    }
  };

  const handleSavePhone = async () => {
    const trimmed = (editPhoneValue || '').trim();
    if (trimmed === (user?.phone || '').trim()) {
      setShowEditPhone(false);
      return;
    }
    try {
      setSavingPhone(true);
      const { data } = await apiService.updateMyPhone(trimmed);
      if (user) setUser({ ...user, phone: data?.phone ?? trimmed });
      queryClient.invalidateQueries({ queryKey: ['onboarding'] });
      toast.success(trimmed ? 'Phone number updated' : 'Phone number removed');
      setShowEditPhone(false);
    } catch (e: any) {
      showAlert('Error', e?.response?.data?.detail || 'Could not update phone number. Try again.');
    } finally {
      setSavingPhone(false);
    }
  };

  const changePwMut = useMutation({
    mutationFn: async () => {
      const response = await apiService.changePassword(currentPw, newPw);
      const { token, refresh_token: refreshToken } = response.data || {};
      if (!token || !refreshToken) {
        throw new Error('Password changed, but the new session could not be restored. Please sign in again.');
      }
      // The backend revokes every previous session, then returns a fresh pair
      // for this device. Persist it before reporting success so the very next
      // API action does not unexpectedly send the user back to Login.
      await setAuthTokens(token, refreshToken);
      return response;
    },
    onSuccess: () => {
      showAlert('Success', 'Password changed successfully');
      setShowChangePassword(false);
      setCurrentPw('');
      setNewPw('');
      setConfirmPw('');
    },
    onError: (e: any) => {
      showAlert('Error', e.response?.data?.detail || e.message || 'Failed to change password');
    },
  });

  const handleChangePassword = () => {
    if (!currentPw || !newPw || !confirmPw) {
      showAlert('Error', 'Please fill all fields');
      return;
    }
    if (newPw !== confirmPw) {
      showAlert('Error', 'New passwords do not match');
      return;
    }
    if (newPw.length < 8) {
      showAlert('Error', 'New password must be at least 8 characters');
      return;
    }
    changePwMut.mutate();
  };

  const compressImage = async (uri: string): Promise<string> => {
    // Resize to max 400x400 and compress to JPEG at 60% quality
    const manipulated = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: 400, height: 400 } }],
      { compress: 0.6, format: ImageManipulator.SaveFormat.JPEG, base64: true }
    );
    return manipulated.base64 || '';
  };

  const pickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      showAlert('Permission needed', 'Please allow access to your photo library.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 1, // Full quality - we compress ourselves
    });

    if (!result.canceled && result.assets[0].uri) {
      const base64 = await compressImage(result.assets[0].uri);
      if (base64) uploadImage(base64);
    }
  };

  const takePhoto = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      showAlert('Permission needed', 'Please allow camera access.');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: true,
      aspect: [1, 1],
      quality: 1, // Full quality - we compress ourselves
    });

    if (!result.canceled && result.assets[0].uri) {
      const base64 = await compressImage(result.assets[0].uri);
      if (base64) uploadImage(base64);
    }
  };

  const uploadImage = async (base64: string) => {
    setUploading(true);
    try {
      const imageData = `data:image/jpeg;base64,${base64}`;
      const res = await apiService.uploadProfileImage(imageData);
      // The server stores the photo as a file and returns its URL; keep that
      // rather than the local data so the header matches what others see.
      const saved = res?.data?.profile_image || imageData;
      if (user) {
        setUser({ ...user, profile_image: saved });
      }
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      showAlert('Success', 'Profile picture updated!');
    } catch (e: any) {
      showAlert('Error', e.response?.data?.detail || 'Failed to upload image');
    } finally {
      setUploading(false);
    }
  };

  const removeImage = async () => {
    showAlert('Remove Photo', 'Remove your profile picture?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive', onPress: async () => {
          try {
            await apiService.removeProfileImage();
            if (user) {
              const updated = { ...user };
              delete (updated as any).profile_image;
              setUser(updated);
            }
            queryClient.invalidateQueries({ queryKey: ['admin-users'] });
            showAlert('Done', 'Profile picture removed');
          } catch {
            showAlert('Error', 'Failed to remove image');
          }
        }
      },
    ]);
  };

  const showImageOptions = () => {
    showAlert('Profile Picture', 'Choose an option', [
      { text: 'Take Photo', onPress: takePhoto },
      { text: 'Choose from Library', onPress: pickImage },
      ...(user?.profile_image ? [{ text: 'Remove Photo', style: 'destructive' as const, onPress: removeImage }] : []),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  };

  const handleLogout = () => {
    showAlert('Logout', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: logout },
    ]);
  };

  return (
    <KeyboardAvoidingView
      style={[
        styles.container,
        isLandscape && { paddingLeft: insets.left, paddingRight: insets.right, paddingTop: insets.top },
      ]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView contentContainerStyle={[styles.scrollContent, { paddingBottom: tabBarClearance + 20 }]} keyboardShouldPersistTaps="handled" onScroll={onScroll} scrollEventThrottle={16}>
        {/* Ink hero — the identity block. A 200px rubik cube turns at the
            top-right behind the avatar; the "Preview as…" glass card (super
            admins only) rides up over its bottom edge. When there is no card
            to ride the overlap, the hero keeps a plain 16px gap instead so the
            next section head never lands on ink. */}
        <EditorialHero
          variant="ink"
          scrollY={scrollY}
          cube={HERO_CUBE}
          overlapNext={showPreviewCard ? HERO_OVERLAP : 0}
          style={showPreviewCard ? null : styles.heroNoOverlap}
        >
          <View style={styles.heroBody}>
            {/* Profile Picture — inside a rotating OrbitRing, role coin at the
                bottom-right, camera (upload) button at the bottom-left. */}
            <TouchableOpacity style={styles.avatarContainer} onPress={showImageOptions} activeOpacity={0.7}>
              <OrbitRing size={AVATAR_RING}>
                {user?.profile_image ? (
                  <Image source={{ uri: user.profile_image }} style={styles.avatarImage} />
                ) : (
                  <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.avatarFallback}>
                    <Ionicons name="person" size={40} color={colors.textLight} />
                  </LinearGradient>
                )}
              </OrbitRing>
              <View style={styles.cameraIcon}>
                {uploading ? (
                  <ActivityIndicator size="small" color={colors.onPrimary} />
                ) : (
                  <Ionicons name="camera" size={14} color={colors.onPrimary} />
                )}
              </View>
              <HexCoin size={ROLE_COIN} tint={roleCoinTint(user?.role)} animate={false} style={styles.roleCoin}>
                <Ionicons
                  name={roleCoinIcon(user?.role)}
                  size={14}
                  color={user?.role === 'admin' ? '#ffffff' : '#0b211c'}
                />
              </HexCoin>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.nameRow}
              onPress={() => {
                setEditNameValue(user?.name || '');
                setShowEditName(true);
              }}
              activeOpacity={0.7}
              hitSlop={{ top: 6, bottom: 6, left: 12, right: 12 }}
            >
              {/* The pencil is NESTED IN the name so it trails the last wrapped
                  line. As a sibling in a flex row it sat at the right edge of
                  the (full-width) wrapped text block — ~230px of empty ink away
                  from a short second line, reading as a stray glyph. */}
              <Text style={[styles.name, heroNameType(user?.name)]} numberOfLines={2}>
                {user?.name}
                <Ionicons name="pencil" size={16} color={colors.inkMuted} style={styles.namePencil} />
              </Text>
            </TouchableOpacity>
            <Text style={styles.email}>{user?.email}</Text>
            <TouchableOpacity
              style={styles.nameRow}
              onPress={() => {
                setEditPhoneValue(user?.phone || '');
                setShowEditPhone(true);
              }}
              activeOpacity={0.7}
              hitSlop={{ top: 6, bottom: 6, left: 12, right: 12 }}
            >
              <Text style={[styles.email, !user?.phone && { fontStyle: 'italic', opacity: 0.8 }]}>
                {user?.phone || 'Add phone number'}
              </Text>
              <Ionicons name="pencil" size={14} color={colors.inkMuted} style={{ marginLeft: 6 }} />
            </TouchableOpacity>
            <RankRibbon tint={roleRibbonTint(user?.role)} style={styles.roleRibbon}>
              {rankTitle(user).toUpperCase()}
            </RankRibbon>
          </View>
        </EditorialHero>

        {/* Preview as… — super admin only. Renders the app exactly as a real
            trainee/leader in the currently-selected office would see it
            (read-only), so admin-side edits and role visibility can be
            verified without a separate login. */}
        {showPreviewCard && (
          <DepthCard edge="gradient" glow index={0} style={styles.section}>
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => setShowPreviewPicker(true)}
              testID="preview-as-btn"
            >
              <IconWell><Ionicons name="eye-outline" size={20} color={colors.primary} /></IconWell>
              <Text style={styles.menuItemText}>Preview as…</Text>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          </DepthCard>
        )}

        {/* Quick Access — items hidden from the bottom tab bar appear here
            so they're still one tap away. Tapping a tile navigates straight
            to that screen. The grid is hidden when nothing is hidden. */}
        <QuickAccessGrid />

        {/* Web/PWA push-notification toggle (renders only on web where it applies). */}
        <WebPushToggle />

        {/* Admin-only tools that have no Quick Access tab. */}
        {isAdmin && (
          <ScrollReveal scrollY={scrollY}>
          <DepthCard style={styles.section}>
            {isAdmin && (
              <TouchableOpacity
                style={styles.menuItem}
                onPress={() => router.navigate('/report')}
                testID="ai-reports-btn"
              >
                <IconWell><Ionicons name="sparkles-outline" size={20} color={colors.primary} /></IconWell>
                <Text style={styles.menuItemText}>AI Reports</Text>
                <View style={styles.betaBadge}>
                  <Text style={styles.betaBadgeText}>BETA</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
              </TouchableOpacity>
            )}
            {isAdmin && !!user?.is_super_admin && (
              <TouchableOpacity
                style={styles.menuItem}
                onPress={() => router.navigate('/owneriq-admin' as any)}
                testID="owneriq-sync-btn"
              >
                <IconWell><Ionicons name="git-merge-outline" size={20} color={colors.primary} /></IconWell>
                <Text style={styles.menuItemText}>OwnerIQ Sync</Text>
                <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
              </TouchableOpacity>
            )}
          </DepthCard>
          </ScrollReveal>
        )}

        {/* Team Planners (Admins & Leaders) — view your reports' monthly plans.
            The personal Monthly Goal Planner lives in Quick Access (MGP). */}
        {(isAdmin || user?.role === 'leader') && (
          <ScrollReveal scrollY={scrollY}>
          <DepthCard style={styles.section}>
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => router.navigate('/monthly-planner-team')}
              testID="monthly-planner-team-btn"
            >
              <IconWell><Ionicons name="people-outline" size={20} color={colors.primary} /></IconWell>
              <Text style={styles.menuItemText}>Team Planners</Text>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          </DepthCard>
          </ScrollReveal>
        )}

        {/* ZIP Code Map entry removed — it lives inside Maps now. */}

        {/* Team Name (Leaders/Admins) — sets the team that YOU lead. Propagates to everyone
            in your subtree on the Bells screen (up to 6 generations). */}
        {(isAdmin || user?.role === 'leader') && (
          <ScrollReveal scrollY={scrollY}>
            <TeamNameSection />
          </ScrollReveal>
        )}

        {/* Admin-only tools with no Quick Access tab (Bulletins, Letter Maker).
            The Training Manual editor is the Manual tab in Quick Access. */}
        {isAdmin && (
          <ScrollReveal scrollY={scrollY}>
          <DepthCard style={styles.section}>
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => router.navigate('/weekly-share')}
              testID="admin-bulletins-btn"
            >
              <IconWell><Ionicons name="newspaper-outline" size={20} color={colors.primary} /></IconWell>
              <Text style={styles.menuItemText}>Bulletins</Text>
              <View style={styles.lockBadge}>
                <Ionicons name="key" size={10} color={colors.textMuted} />
                <Text style={styles.lockBadgeText}>Admin</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          </DepthCard>
          </ScrollReveal>
        )}

        {/* My Badges — earned achievements, placed after operational tools. */}
        <MyBadgesSection />

        {/* Notifications Preferences */}
        <ScrollReveal scrollY={scrollY}>
          <NotificationsSection />
        </ScrollReveal>

        {/* Inbox — the in-app history of every notification we've sent. */}
        <ScrollReveal scrollY={scrollY}>
        <DepthCard style={styles.section}>
          <TouchableOpacity
            style={styles.menuItem}
            onPress={() => router.navigate('/notifications' as never)}
            testID="inbox-btn"
          >
            <IconWell><Ionicons name="mail-outline" size={20} color={colors.primary} /></IconWell>
            <Text style={styles.menuItemText}>Inbox</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
          </TouchableOpacity>
        </DepthCard>
        </ScrollReveal>

        {/* Biometric / Face ID quick sign-in */}
        <BiometricSection />

        {/* Change Password Section */}
        <ScrollReveal scrollY={scrollY}>
        <DepthCard style={styles.section}>
          <TouchableOpacity
            style={styles.menuItem}
            onPress={() => setShowChangePassword(!showChangePassword)}
          >
            <IconWell><Ionicons name="lock-closed-outline" size={20} color={colors.primary} /></IconWell>
            <Text style={styles.menuItemText}>Change Password</Text>
            <Ionicons name={showChangePassword ? 'chevron-up' : 'chevron-forward'} size={18} color={colors.textMuted} />
          </TouchableOpacity>

          {showChangePassword && (
            <View style={styles.passwordForm}>
              <View style={styles.passwordField}>
                <TextInput
                  style={styles.passwordInput}
                  placeholder="Current Password"
                  placeholderTextColor={colors.textMuted}
                  value={currentPw}
                  onChangeText={setCurrentPw}
                  secureTextEntry={!showCurrentPw}
                  autoCapitalize="none"
                />
                <TouchableOpacity style={styles.eyeBtn} onPress={() => setShowCurrentPw(!showCurrentPw)}>
                  <Ionicons name={showCurrentPw ? 'eye-off' : 'eye'} size={20} color={colors.textMuted} />
                </TouchableOpacity>
              </View>
              <View style={styles.passwordField}>
                <TextInput
                  style={styles.passwordInput}
                  placeholder="New Password"
                  placeholderTextColor={colors.textMuted}
                  value={newPw}
                  onChangeText={setNewPw}
                  secureTextEntry={!showNewPw}
                  autoCapitalize="none"
                />
                <TouchableOpacity style={styles.eyeBtn} onPress={() => setShowNewPw(!showNewPw)}>
                  <Ionicons name={showNewPw ? 'eye-off' : 'eye'} size={20} color={colors.textMuted} />
                </TouchableOpacity>
              </View>
              <TextInput
                style={styles.inputField}
                placeholder="Confirm New Password"
                placeholderTextColor={colors.textMuted}
                value={confirmPw}
                onChangeText={setConfirmPw}
                secureTextEntry={!showNewPw}
                autoCapitalize="none"
              />
              <TouchableOpacity
                style={[styles.savePasswordBtn, changePwMut.isPending && { opacity: 0.6 }]}
                onPress={handleChangePassword}
                disabled={changePwMut.isPending}
              >
                {changePwMut.isPending ? (
                  <ActivityIndicator size="small" color={colors.onPrimary} />
                ) : (
                  <Text style={styles.savePasswordText}>Update Password</Text>
                )}
              </TouchableOpacity>
            </View>
          )}
        </DepthCard>
        </ScrollReveal>

        {/* Appearance — System / Light / Dark */}
        <ScrollReveal scrollY={scrollY}>
          <AppearanceSection />
        </ScrollReveal>

        {/* Customise Tab Bar — pick which items appear on the bottom bar
            (max 7 + Profile). Hidden items show up in Quick Access at the
            top of this Profile screen. */}
        <ScrollReveal scrollY={scrollY}>
        <DepthCard style={styles.section}>
          <TouchableOpacity
            style={styles.menuItem}
            onPress={() => router.navigate('/customize-tabs')}
            testID="customize-tabs-btn"
          >
            <IconWell><Ionicons name="apps-outline" size={20} color={colors.primary} /></IconWell>
            <Text style={styles.menuItemText}>Customise Sidebar</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
          </TouchableOpacity>
        </DepthCard>
        </ScrollReveal>

        {/* Logout */}
        <ScrollReveal scrollY={scrollY}>
        <DepthCard style={styles.section}>
          <TouchableOpacity testID="logout-btn" style={styles.logoutBtn} onPress={() => {
            showAlert('Logout', 'Are you sure you want to sign out?', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Sign Out', style: 'destructive', onPress: logout },
            ]);
          }}>
            <IconWell tone="red"><Ionicons name="log-out-outline" size={20} color={colors.red} /></IconWell>
            <Text style={styles.logoutText}>Sign Out</Text>
          </TouchableOpacity>
        </DepthCard>
        </ScrollReveal>
      </ScrollView>

      {canPreview && (
        <ChoiceSheet
          visible={showPreviewPicker}
          title="Preview as…"
          subtitle="Pick a real BA or coach in the current office. Read-only — nothing you tap will save."
          options={previewOptions}
          onSelect={handleSelectPreview}
          onClose={() => setShowPreviewPicker(false)}
          searchable
        />
      )}

      {/* Edit-name modal — slides up, dismissible by tapping the backdrop. */}
      <Modal
        visible={showEditName}
        transparent
        animationType="fade"
        onRequestClose={() => setShowEditName(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.editNameBackdrop}
        >
          <TouchableOpacity
            activeOpacity={1}
            style={StyleSheet.absoluteFill}
            onPress={() => setShowEditName(false)}
          />
          <View style={styles.editNameCard}>
            <Text style={styles.editNameTitle}>Edit Name</Text>
            <Text style={styles.editNameSub}>This is how your name appears across the app, leaderboards, and the Weekly Bulletin.</Text>
            <TextInput
              value={editNameValue}
              onChangeText={setEditNameValue}
              style={styles.editNameInput}
              placeholder="Your full name"
              placeholderTextColor={colors.textMuted}
              autoFocus
              autoCapitalize="words"
              autoCorrect={false}
              maxLength={80}
              returnKeyType="done"
              onSubmitEditing={handleSaveName}
            />
            <View style={styles.editNameRowBtns}>
              <TouchableOpacity
                style={[styles.editNameBtn, styles.editNameBtnGhost]}
                onPress={() => setShowEditName(false)}
                disabled={savingName}
              >
                <Text style={styles.editNameBtnGhostText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.editNameBtn, styles.editNameBtnPrimary, savingName && { opacity: 0.6 }]}
                onPress={handleSaveName}
                disabled={savingName}
              >
                {savingName ? (
                  <ActivityIndicator color={colors.onPrimary} />
                ) : (
                  <Text style={styles.editNameBtnPrimaryText}>Save</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Edit-phone modal — shows up as a tap-to-call contact on the
          onboarding hub of anyone who reports to you. */}
      <Modal
        visible={showEditPhone}
        transparent
        animationType="fade"
        onRequestClose={() => setShowEditPhone(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.editNameBackdrop}
        >
          <TouchableOpacity
            activeOpacity={1}
            style={StyleSheet.absoluteFill}
            onPress={() => setShowEditPhone(false)}
          />
          <View style={styles.editNameCard}>
            <Text style={styles.editNameTitle}>Edit Phone Number</Text>
            <Text style={styles.editNameSub}>Shown as a tap-to-call contact on the onboarding hub of anyone who reports to you. Leave blank to remove it.</Text>
            <TextInput
              value={editPhoneValue}
              onChangeText={setEditPhoneValue}
              style={styles.editNameInput}
              placeholder="Your mobile, e.g. 07123 456789"
              placeholderTextColor={colors.textMuted}
              autoFocus
              keyboardType="phone-pad"
              maxLength={40}
              returnKeyType="done"
              onSubmitEditing={handleSavePhone}
            />
            <View style={styles.editNameRowBtns}>
              <TouchableOpacity
                style={[styles.editNameBtn, styles.editNameBtnGhost]}
                onPress={() => setShowEditPhone(false)}
                disabled={savingPhone}
              >
                <Text style={styles.editNameBtnGhostText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.editNameBtn, styles.editNameBtnPrimary, savingPhone && { opacity: 0.6 }]}
                onPress={handleSavePhone}
                disabled={savingPhone}
              >
                {savingPhone ? (
                  <ActivityIndicator color={colors.onPrimary} />
                ) : (
                  <Text style={styles.editNameBtnPrimaryText}>Save</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </KeyboardAvoidingView>
  );
}

// ── Quick Access Grid ───────────────────────────────────────────────────
// Items the user has hidden from the bottom tab bar still need to be one
// tap away. Render them as a compact 4-column icon grid at the top of the
// Profile screen. Hidden when nothing is hidden.
function QuickAccessGrid() {
  const colors = useColors();
  const router = useRouter();
  const { resolved, loaded } = useTabPrefs();
  const { effective } = useTheme();
  const isDark = effective === 'dark';
  const qaStyles = useMemo(() => createQuickAccessStyles(colors), [colors]);

  if (!loaded) return null;

  // "Visible" items go on the bar (max N + Profile pinned). Anything past
  // that or explicitly hidden surfaces here. Profile is never in this grid.
  const allVisible = resolved.filter((r) => r.visible);
  const visibleOnBar = new Set(allVisible.slice(0, MAX_BOTTOM_TABS).map((r) => r.item.id));
  const hidden = resolved.filter(
    (r) => r.item.id !== 'profile' && !visibleOnBar.has(r.item.id),
  );

  if (hidden.length === 0) return null;

  const onPress = (it: { kind: 'tab' | 'route'; target: string }) => {
    if (it.kind === 'tab') {
      try {
        router.navigate(('/(tabs)/' + (it.target === 'index' ? '' : it.target)) as never);
      } catch {}
    } else {
      router.navigate(it.target as never);
    }
  };

  return (
    <View style={qaStyles.wrap}>
      <SectionHead size={22} style={qaStyles.head}>QUICK ACCESS</SectionHead>
      <View style={qaStyles.grid}>
        {hidden.map(({ item }, i) => {
          // Each key's icon well is tinted along the poster spectrum (rim =
          // this stop → next stop, fill = 18 % of the stop over the key face)
          // so the grid reads as one gradient. The glyph is the same hue
          // pulled 40 % toward ink (light) / white (dark) — every stop stays
          // ≥4.5:1 on the key, including the cyan end.
          const tint = GRADIENT_FULL[i % GRADIENT_FULL.length];
          const next = GRADIENT_FULL[(i + 1) % GRADIENT_FULL.length];
          const wellFill = mixHex(tint, colors.background, 0.82);
          const glyph = mixHex(tint, isDark ? '#ffffff' : '#000000', 0.4);
          const go = () => onPress(item);
          return (
            <Reveal key={item.id} index={Math.floor(i / 4)} style={qaStyles.tile}>
              {/* Key and label are separate pressables on the SAME handler: the
                  key owns the sink animation (and pads its own hit area to 44px),
                  the label is its own tap target. Nesting them would fire `go`
                  twice on web, where both DOM handlers run. */}
              <View style={qaStyles.tileHit}>
                <Keycap size={64} radius={16} onPress={go} accessibilityLabel={item.label}>
                  <LinearGradient colors={[tint, next] as const} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={qaStyles.wellRim}>
                    <View style={[qaStyles.well, { backgroundColor: wellFill }]}>
                      <Ionicons name={item.icon} size={22} color={glyph} />
                    </View>
                  </LinearGradient>
                </Keycap>
                <TouchableOpacity
                  onPress={go}
                  activeOpacity={0.7}
                  style={qaStyles.labelHit}
                  hitSlop={{ top: 4, bottom: 8, left: 8, right: 8 }}
                  accessibilityLabel={item.label}
                >
                  <Text style={qaStyles.tileLabel} numberOfLines={1}>{item.short || item.label}</Text>
                </TouchableOpacity>
              </View>
            </Reveal>
          );
        })}
      </View>
    </View>
  );
}

// ── My Badges — earned achievements grid (everyone) ──────────────────────
/** Hex plinth under an EARNED badge's emoji (fits the 22%-wide tile with room). */
const BADGE_HEX = 46;
// Admins tapping a badge additionally see everyone in the office who has
// earned it (office-scoped) so the owner can see who's picked what up.
function MyBadgesSection() {
  const colors = useColors();
  const { effective } = useTheme();
  const isDark = effective === 'dark';
  const badgeStyles = useMemo(() => createMyBadgesStyles(colors, isDark), [colors, isDark]);
  const { user } = useAuth();
  const isAdmin = (user?.role || '').toLowerCase() === 'admin';
  const [detailBadge, setDetailBadge] = useState<{ key: string; title: string; emoji: string; subtitle: string; how?: string } | null>(null);

  const { data: catalog } = useQuery({
    queryKey: ['achievement-catalog'],
    queryFn: () => apiService.getAchievementCatalog().then((res) => res.data),
    staleTime: 60 * 60_000,
  });
  const { data: earned } = useQuery({
    queryKey: ['my-badges'],
    queryFn: () => apiService.getMyBadges().then((res) => res.data),
  });
  // Super admins see the earners for whichever office they've flipped to.
  const { officeId: activeOfficeId, canSwitch } = useActiveOffice();
  const earnersOffice = canSwitch ? activeOfficeId : undefined;
  const earnersQ = useQuery({
    queryKey: ['badge-earners', detailBadge?.key, earnersOffice],
    queryFn: () => apiService.getBadgeEarners(String(detailBadge?.key), earnersOffice).then((res) => res.data),
    enabled: isAdmin && !!detailBadge,
    staleTime: 60_000,
  });

  if (!catalog || catalog.length === 0) return null;
  const earnedByKey = new Map((earned || []).map((b) => [b.key, b]));

  const showDetail = (a: { key: string; title: string; emoji: string; subtitle: string; how?: string }) => {
    if (isAdmin) { setDetailBadge(a); return; }
    const got = earnedByKey.get(a.key);
    const howLine = a.how || a.subtitle;
    const statusLine = got
      ? `✅ Earned ${new Date(got.earned_at).toLocaleDateString(APP_LOCALE, { month: 'short', day: 'numeric', year: 'numeric' })}`
      : '🔒 Not earned yet — keep going!';
    showAlert(`${a.emoji} ${a.title}`, `${howLine}\n\n${statusLine}`);
  };

  const detailGot = detailBadge ? earnedByKey.get(detailBadge.key) : undefined;

  return (
    <View style={badgeStyles.section}>
      <SectionHead size={22} style={badgeStyles.head}>MY BADGES</SectionHead>
      <Text style={badgeStyles.hint}>{isAdmin ? "Tap a badge to see who in the office has earned it." : "Tap a badge to see how it's earned."}</Text>
      <View style={badgeStyles.grid}>
        {catalog.map((a) => {
          const got = earnedByKey.get(a.key);
          const face = (
            <>
              {got ? (
                // Earned slots are COINS: the emoji sits in a hex plinth with an
                // XP-gradient rim (glow off — 27 halos would be a light show).
                <HexFrame size={BADGE_HEX} stroke={2} glow={false} style={badgeStyles.hex}>
                  <Text style={badgeStyles.emojiCoin}>{a.emoji}</Text>
                </HexFrame>
              ) : (
                <Text style={[badgeStyles.emoji, badgeStyles.emojiLocked]}>{a.emoji}</Text>
              )}
              <Text style={[badgeStyles.tileTitle, !got && badgeStyles.tileTitleLocked]} numberOfLines={2}>{a.title}</Text>
            </>
          );
          return (
            <TouchableOpacity
              key={a.key}
              style={badgeStyles.tileHit}
              onPress={() => showDetail(a)}
              activeOpacity={0.7}
            >
              {got ? (
                // Plain gradient rim, NOT a DepthCard: a 78px tile does not need a
                // card's 3-LAYER depthShadow, and 27 of them on the app's largest
                // grid would be 81 shadow layers. It carries ONE lift layer instead
                // (see tileRim) — the rim + the plinth do the rest of the work.
                // 1.5px padding matches DepthCard's EDGE_PAD.
                <LinearGradient
                  colors={GRADIENT}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={badgeStyles.tileRim}
                >
                  <View style={badgeStyles.tile}>{face}</View>
                </LinearGradient>
              ) : (
                <View style={[badgeStyles.tile, badgeStyles.tileLocked]}>{face}</View>
              )}
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Admin badge detail — how it's earned + the office earners list */}
      <Modal visible={!!detailBadge} transparent animationType="fade" onRequestClose={() => setDetailBadge(null)}>
        <TouchableOpacity activeOpacity={1} style={badgeStyles.modalBackdrop} onPress={() => setDetailBadge(null)}>
          <TouchableOpacity activeOpacity={1} style={badgeStyles.modalCard} onPress={() => {}}>
            {detailBadge && (
              <>
                <Text style={badgeStyles.modalEmoji}>{detailBadge.emoji}</Text>
                <Text style={badgeStyles.modalTitle}>{detailBadge.title}</Text>
                <Text style={badgeStyles.modalHow}>{detailBadge.how || detailBadge.subtitle}</Text>
                <Text style={badgeStyles.modalStatus}>
                  {detailGot
                    ? `✅ You earned this ${new Date(detailGot.earned_at).toLocaleDateString(APP_LOCALE, { month: 'short', day: 'numeric', year: 'numeric' })}`
                    : '🔒 Not earned by you yet'}
                </Text>
                <Text style={badgeStyles.earnersLabel}>EARNED IN YOUR OFFICE</Text>
                <ScrollView style={{ maxHeight: 280 }} contentContainerStyle={{ gap: 2 }}>
                  {earnersQ.isLoading ? (
                    <ActivityIndicator color={colors.primary} style={{ paddingVertical: 16 }} />
                  ) : earnersQ.isError ? (
                    <Text style={badgeStyles.earnersEmpty}>Couldn't load the earners list — pull the modal closed and try again.</Text>
                  ) : (earnersQ.data?.earners || []).length === 0 ? (
                    <Text style={badgeStyles.earnersEmpty}>No one has earned this one yet — it's up for grabs.</Text>
                  ) : (
                    (earnersQ.data?.earners || []).map((p) => (
                      <View key={`${p.user_id}-${p.earned_at}`} style={badgeStyles.earnerRow}>
                        <View style={badgeStyles.earnerAvatar}>
                          <Text style={badgeStyles.earnerAvatarText}>{(p.name || '?').charAt(0).toUpperCase()}</Text>
                        </View>
                        <Text style={badgeStyles.earnerName} numberOfLines={1}>{p.name}</Text>
                        <Text style={badgeStyles.earnerDate}>
                          {p.earned_at ? new Date(p.earned_at).toLocaleDateString(APP_LOCALE, { month: 'short', day: 'numeric' }) : ''}
                        </Text>
                      </View>
                    ))
                  )}
                </ScrollView>
                <TouchableOpacity style={badgeStyles.modalClose} onPress={() => setDetailBadge(null)}>
                  <Text style={badgeStyles.modalCloseText}>Close</Text>
                </TouchableOpacity>
              </>
            )}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const createMyBadgesStyles = (colors: any, isDark: boolean) => StyleSheet.create({
  section: { paddingTop: 4, paddingBottom: 6 },
  head: { marginBottom: 4 },
  hint: { fontSize: 11, color: colors.textMuted, marginBottom: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tileHit: { width: '22%' },
  // The badge WALL is the biggest region on Profile, so earned-vs-locked has to
  // read as a collection to fill, not as a spreadsheet:
  //   earned = a lit COIN — gradient rim + white face + a hex plinth under the
  //            emoji, lifted off the field by ONE shadow layer;
  //   locked = an empty SOCKET — trackBg well pressed into the field by a single
  //            inset layer, hairline kept so it never goes lavender-on-lavender
  //            (surfaceAlt on page measured 1.11:1 — the flat look this replaces).
  // Single-layer shadows on purpose: 27 × depthShadow would be 81 layers.
  // A blanket opacity would fade the tile and take the title with it, so the
  // dimming lives on the emoji only and the border stays solid.
  // flex: 1 on both the rim and the face → every tile fills its wrap line, so a
  // coin and a socket sit at exactly the same height.
  tileRim: {
    flex: 1,
    borderRadius: 15.5,
    padding: 1.5,
    boxShadow: isDark ? '0 8px 18px -8px rgba(0,0,0,0.75)' : '0 7px 15px -7px rgba(16,45,37,0.45)',
  },
  tile: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 10, borderRadius: 14, backgroundColor: colors.background },
  tileLocked: {
    backgroundColor: colors.trackBg,
    borderWidth: 1,
    borderColor: colors.borderDark,
    boxShadow: isDark ? 'inset 0 3px 7px rgba(0,0,0,0.65)' : 'inset 0 3px 7px rgba(16,45,37,0.30)',
  },
  hex: { marginBottom: 4 },
  emoji: { fontSize: 26, marginBottom: 4 },
  // Inside the plinth HexFrame centres the glyph, so it carries no margin and
  // steps down 2px — framed, it reads as big as the bare 26px locked emoji.
  emojiCoin: { fontSize: 24 },
  emojiLocked: { opacity: 0.45 },
  tileTitle: { fontSize: 10.5, fontWeight: '700', color: colors.text, textAlign: 'center', maxWidth: '95%' },
  tileTitleLocked: { color: colors.textMuted },
  modalBackdrop: { flex: 1, backgroundColor: '#000a', alignItems: 'center', justifyContent: 'center', padding: 24 },
  modalCard: { width: '100%', maxWidth: 420, backgroundColor: colors.background, borderRadius: 18, padding: 18, borderWidth: 1, borderColor: colors.border },
  modalEmoji: { fontSize: 40, textAlign: 'center' },
  modalTitle: { fontSize: 18, fontWeight: '900', color: colors.text, textAlign: 'center', marginTop: 4 },
  modalHow: { fontSize: 13, lineHeight: 18, color: colors.textSecondary, textAlign: 'center', marginTop: 6 },
  modalStatus: { fontSize: 12.5, fontWeight: '700', color: colors.text, textAlign: 'center', marginTop: 10 },
  earnersLabel: { fontSize: 10.5, fontWeight: '900', color: colors.textMuted, letterSpacing: 0.6, marginTop: 14, marginBottom: 6 },
  earnersEmpty: { fontSize: 12.5, color: colors.textMuted, fontStyle: 'italic', paddingVertical: 8 },
  earnerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, borderTopWidth: 1, borderTopColor: colors.border },
  earnerAvatar: { width: 26, height: 26, borderRadius: 13, backgroundColor: colors.primary + '22', alignItems: 'center', justifyContent: 'center' },
  earnerAvatarText: { fontSize: 12, fontWeight: '800', color: colors.primary },
  earnerName: { flex: 1, fontSize: 13.5, fontWeight: '600', color: colors.text },
  earnerDate: { fontSize: 11.5, color: colors.textMuted },
  modalClose: { marginTop: 14, alignSelf: 'center', paddingHorizontal: 22, paddingVertical: 9, borderRadius: 10, backgroundColor: colors.primary },
  modalCloseText: { color: colors.onPrimary, fontSize: 13.5, fontWeight: '800' },
});

const createQuickAccessStyles = (colors: any) => StyleSheet.create({
  wrap: { paddingTop: 4, paddingBottom: 10 },
  head: { marginBottom: 14 },
  // Same 22 % / 4-column grid as before; the key itself is the tile now.
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tile: { width: '22%', alignItems: 'center' },
  tileHit: { width: '100%', alignItems: 'center', paddingVertical: 4 },
  wellRim: { width: 44, height: 44, borderRadius: 14, padding: 2 },
  // Content-width like the bare label was, clamped to the tile so long labels can't spill.
  labelHit: { maxWidth: '100%' },
  well: { flex: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  tileLabel: { fontSize: 11, fontWeight: '700', color: colors.text, marginTop: 8, maxWidth: '100%' },
});

// ── Notifications Section (everyone) ─────────────────────────────────────
// Per-device opt-out for the local "5 min before each schedule block" reminder.
// Account-wide per-TYPE toggles live in the Inbox settings sheet — linked below.
function NotificationsSection() {
  const colors = useColors();
  const notifStyles = useMemo(() => createNotifStyles(colors), [colors]);
  const router = useRouter();

  const [enabled, setEnabledState] = React.useState<boolean>(true);
  const [loaded, setLoaded] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const v = await getScheduleRemindersEnabled();
      if (!cancelled) {
        setEnabledState(v);
        setLoaded(true);
      }
      // Heal pre-fix opt-outs: the toggle used to be device-local only, so a
      // stored "off" never reached the server and PWA web pushes kept coming.
      // Push an explicit off to the server; never push "on" implicitly — a
      // fresh device's default must not re-enable an account-wide opt-out.
      if (!v) apiService.setScheduleReminders(false).catch(() => {});
    })();
    return () => { cancelled = true; };
  }, []);

  const toggle = async (next: boolean) => {
    setEnabledState(next);
    setSaving(true);
    // Server-side pref gates the web-push sender — best-effort; the local
    // half below still silences on-device notifications either way.
    apiService.setScheduleReminders(next).catch(() => {});
    try {
      await setScheduleRemindersEnabled(next);
      if (next) {
        // Re-arm using the freshest data — fetched lazily here to avoid
        // bringing in the full query client; if there's nothing in cache
        // yet the schedule screen will arm everything on next focus.
        try {
          const { data } = await apiService.listSchedule();
          await rescheduleAllForUser(data?.blocks || [], undefined);
        } catch {}
      } else {
        await clearAllScheduledForUser();
      }
    } catch {}
    setSaving(false);
  };

  return (
    <DepthCard style={notifStyles.card}>
      <View style={notifStyles.row}>
        <IconWell><Ionicons name="notifications-outline" size={20} color={colors.primary} /></IconWell>
        <View style={{ flex: 1 }}>
          <Text style={notifStyles.label}>Schedule Reminders</Text>
          <Text style={notifStyles.helper}>
            Get a push notification 5 minutes before each schedule block tagged for you.
          </Text>
        </View>
        <Switch
          value={enabled}
          onValueChange={toggle}
          disabled={!loaded || saving}
          trackColor={{ false: '#91B69E', true: colors.primary }}
          thumbColor="#fff"
        />
      </View>
      <TouchableOpacity onPress={() => router.push('/notifications' as never)} activeOpacity={0.7}>
        <Text style={notifStyles.inboxLink}>Notification types are managed in your Inbox →</Text>
      </TouchableOpacity>
    </DepthCard>
  );
}

const createNotifStyles = (colors: any) => StyleSheet.create({
  card: { borderRadius: 16, marginBottom: 16, padding: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  label: { fontSize: 15, fontWeight: '600', color: colors.text },
  helper: { fontSize: 11, color: colors.textMuted, marginTop: 2, lineHeight: 15 },
  inboxLink: { fontSize: 12, fontWeight: '700', color: colors.primary, marginTop: 12 },
});

// ── Biometric / Face ID Section ──────────────────────────────────────────
// Toggle that enables/disables Face ID (or Touch ID / Fingerprint) sign-in.
// Shows the device's actual biometric type and disables itself if the
// device doesn't have hardware enrolled.
function BiometricSection() {
  const colors = useColors();
  const bioStyles = useMemo(() => createBioStyles(colors), [colors]);
  const { user, enableBiometricForCurrentUser, disableBiometricForCurrentUser, isBiometricEnabledForUser } = useAuth();
  const [state, setState] = React.useState<{ available: boolean; enrolled: boolean; label: string; iconName: string }>({ available: false, enrolled: false, label: 'Face ID', iconName: 'finger-print' });
  const [enabled, setEnabled] = React.useState(false);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    (async () => {
      try {
        const { getBiometricState } = await import('../../src/auth/biometric');
        const s = await getBiometricState();
        const iconName = s.type === 'face' ? 'scan' : s.type === 'fingerprint' ? 'finger-print' : 'lock-closed';
        setState({ available: s.available, enrolled: s.enrolled, label: s.prettyLabel, iconName });
        setEnabled(await isBiometricEnabledForUser());
      } catch {}
    })();
  }, [user?.email]);

  const onToggle = async (next: boolean) => {
    setLoading(true);
    try {
      if (next) {
        const ok = await enableBiometricForCurrentUser();
        if (ok) { setEnabled(true); toast.success(`${state.label} enabled`); }
        else { toast.error('Could not enable', 'Please try signing in again with your password.'); }
      } else {
        await disableBiometricForCurrentUser();
        setEnabled(false);
        toast.info(`${state.label} disabled`, 'You\'ll need your password next time.');
      }
    } finally { setLoading(false); }
  };

  if (!state.available) return null;       // No hardware → don't render

  return (
    <DepthCard style={bioStyles.section}>
      <View style={bioStyles.row}>
        <IconWell><Ionicons name={state.iconName as any} size={20} color={colors.primary} /></IconWell>
        <View style={{ flex: 1 }}>
          <Text style={bioStyles.title}>Sign in with {state.label}</Text>
          <Text style={bioStyles.helper}>
            {state.enrolled
              ? `Skip the password — re-authenticate with your ${state.label.toLowerCase()}.`
              : `${state.label} is set up on this device, but no face/finger is enrolled.`}
          </Text>
        </View>
        <Switch
          value={enabled}
          disabled={!state.enrolled || loading}
          onValueChange={onToggle}
          thumbColor={enabled ? '#fff' : '#fff'}
          trackColor={{ false: colors.borderDark, true: colors.primary }}
        />
      </View>
    </DepthCard>
  );
}

const createBioStyles = (colors: any) => StyleSheet.create({
  section: { marginBottom: 16, padding: 14, borderRadius: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { fontSize: 14, fontWeight: '800', color: colors.text },
  helper: { fontSize: 11, color: colors.textMuted, marginTop: 2, lineHeight: 15 },
});

// ── Team Name Section (leaders & admins) ─────────────────────────────────
// Lets a leader set the display team name that rolls up their entire
// sub-tree on the Bells screen. Propagates instantly on save.
function TeamNameSection() {
  const colors = useColors();
  const teamStyles = useMemo(() => createTeamStyles(colors), [colors]);

  const { user, setUser } = useAuth();
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState<string>(user?.team_name || '');
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    setValue(user?.team_name || '');
  }, [user?.team_name]);

  const save = async () => {
    const trimmed = value.trim();
    setSaving(true);
    try {
      const { data } = await apiService.updateTeamName(trimmed);
      const nextName = data?.team_name || '';
      if (user) setUser({ ...user, team_name: nextName });
      setEditing(false);
    } catch (e: any) {
      showAlert('Error', e.response?.data?.detail || 'Failed to update team name');
    } finally {
      setSaving(false);
    }
  };

  const displayName = (user?.team_name || '').trim();

  return (
    <DepthCard style={teamStyles.card}>
      <View style={teamStyles.headerRow}>
        <IconWell><Ionicons name="people-circle-outline" size={20} color={colors.primary} /></IconWell>
        <View style={{ flex: 1 }}>
          <Text style={teamStyles.label}>Team Name</Text>
          <Text style={teamStyles.helper}>
            Shown on the Bells Team view. Every member in your sub-tree rolls up under this team.
          </Text>
        </View>
      </View>

      {!editing ? (
        <View style={teamStyles.valueRow}>
          <Text style={[teamStyles.valueText, !displayName && { color: colors.textMuted, fontStyle: 'italic' }]} numberOfLines={1}>
            {displayName || 'No team name set yet'}
          </Text>
          <TouchableOpacity style={teamStyles.editBtn} onPress={() => setEditing(true)}>
            <Ionicons name={displayName ? 'create-outline' : 'add'} size={16} color={colors.primary} />
            <Text style={teamStyles.editBtnText}>{displayName ? 'Edit' : 'Add'}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={teamStyles.editWrap}>
          <TextInput
            style={teamStyles.input}
            value={value}
            onChangeText={setValue}
            placeholder="e.g. The Alphas"
            placeholderTextColor={colors.textMuted}
            maxLength={40}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={save}
          />
          <View style={teamStyles.editActions}>
            <TouchableOpacity
              style={[teamStyles.cancelBtn]}
              onPress={() => {
                setValue(user?.team_name || '');
                setEditing(false);
              }}
              disabled={saving}
            >
              <Text style={teamStyles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[teamStyles.saveBtn, saving && { opacity: 0.6 }]} onPress={save} disabled={saving}>
              {saving ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={teamStyles.saveBtnText}>Save</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      )}
    </DepthCard>
  );
}

const createTeamStyles = (colors: any) => StyleSheet.create({
  card: { borderRadius: 16, marginBottom: 16, padding: 16 },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 12 },
  label: { fontSize: 15, fontWeight: '600', color: colors.text },
  helper: { fontSize: 11, color: colors.textMuted, marginTop: 2, lineHeight: 15 },
  valueRow: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.surfaceAlt, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  valueText: { flex: 1, fontSize: 15, fontWeight: '700', color: colors.text },
  editBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: colors.primary, backgroundColor: 'rgba(58, 122, 86, 0.06)' },
  editBtnText: { color: colors.primary, fontSize: 13, fontWeight: '700' },
  editWrap: { gap: 10 },
  input: { backgroundColor: colors.surfaceAlt, borderRadius: 10, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: colors.text },
  editActions: { flexDirection: 'row', gap: 8 },
  cancelBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border, alignItems: 'center', backgroundColor: colors.surfaceAlt },
  cancelBtnText: { fontSize: 14, fontWeight: '600', color: colors.text },
  saveBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center', backgroundColor: colors.primary },
  saveBtnText: { fontSize: 14, fontWeight: '700', color: colors.onPrimary },
});

const createStyles3 = (colors: any) => StyleSheet.create({
  container: { flex: 1 },
  scrollContent: { padding: 16 },
  // ── Ink hero ─────────────────────────────────────────────────────────
  // No card to ride the overlap (non-super-admins) → plain 16px gap instead.
  heroNoOverlap: { marginBottom: 16 },
  heroBody: { alignItems: 'center' },
  avatarContainer: { position: 'relative', marginBottom: 18 },
  avatarImage: { width: AVATAR_SIZE, height: AVATAR_SIZE, borderRadius: AVATAR_SIZE / 2, backgroundColor: colors.surfaceAlt },
  avatarFallback: { width: AVATAR_SIZE, height: AVATAR_SIZE, borderRadius: AVATAR_SIZE / 2, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  // Upload button bottom-left, role coin bottom-right. Border stays colors.background (knockout ring).
  cameraIcon: { position: 'absolute', bottom: 0, left: -2, width: 30, height: 30, borderRadius: 15, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: colors.background },
  roleCoin: { position: 'absolute', bottom: -3, right: -5 },
  // Unbounded-Black: never add fontWeight (faux-bold on web).
  name: { fontFamily: fonts.displayBlack, fontSize: 30, lineHeight: 36, letterSpacing: -0.8, color: colors.inkText, textAlign: 'center', flexShrink: 1 },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    maxWidth: '100%',
    paddingVertical: 4,
    paddingHorizontal: 8,
    marginBottom: 4,
  },
  // Inline (nested in the name Text) so it trails the LAST wrapped line instead
  // of parking at the right edge of the wrapped block. The phone row below keeps
  // a sibling pencil — that value is always one line.
  namePencil: { marginLeft: 10 },
  email: { fontSize: 15, color: colors.inkMuted, marginBottom: 10, textAlign: 'center' },
  roleRibbon: { alignSelf: 'center', marginTop: 6 },
  // ── Edit-name modal ──────────────────────────────────────────────────
  editNameBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  editNameCard: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 22,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  editNameTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.text,
    marginBottom: 6,
  },
  editNameSub: {
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 18,
    marginBottom: 16,
  },
  editNameInput: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    color: colors.text,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    marginBottom: 18,
  },
  editNameRowBtns: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
  },
  editNameBtn: {
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 10,
    minWidth: 88,
    alignItems: 'center',
    justifyContent: 'center',
  },
  editNameBtnGhost: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.border,
  },
  editNameBtnGhostText: {
    color: colors.text,
    fontWeight: '700',
    fontSize: 15,
  },
  editNameBtnPrimary: {
    backgroundColor: colors.primary,
  },
  editNameBtnPrimaryText: {
    color: colors.onPrimary,
    fontWeight: '800',
    fontSize: 15,
  },
  // DepthCard owns fill + shadow; no overflow:hidden so the shadow is never clipped.
  section: { borderRadius: 16, marginBottom: 16 },
  // 38px icon well per row → slightly tighter vertical padding keeps the row ~64px.
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 13 },
  menuItemText: { flex: 1, fontSize: 16, fontWeight: '500', color: colors.text },
  // Chips read on the card in both themes (primary/surfaceAlt/border are hex tokens).
  betaBadge: { backgroundColor: colors.primary + '1F', borderWidth: 1, borderColor: colors.primary + '40', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, marginRight: 6 },
  // Unbounded is confined to ≥11px uppercase (§2.4) — its wide forms smear below that.
  betaBadgeText: { fontFamily: fonts.displayWide, fontSize: 11, color: colors.primary, letterSpacing: 0.6, textTransform: 'uppercase' },
  lockBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 3, backgroundColor: colors.surfaceAlt, borderRadius: 999, borderWidth: 1, borderColor: colors.border },
  lockBadgeText: { fontSize: 10, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.3 },
  passwordForm: { padding: 16, paddingTop: 0, gap: 12 },
  passwordField: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surfaceAlt, borderRadius: 10, borderWidth: 1, borderColor: colors.border },
  passwordInput: { flex: 1, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: colors.text },
  eyeBtn: { paddingHorizontal: 12 },
  inputField: { backgroundColor: colors.surfaceAlt, borderRadius: 10, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: colors.text },
  savePasswordBtn: { backgroundColor: colors.primary, borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 4 },
  savePasswordText: { color: colors.onPrimary, fontSize: 16, fontWeight: '600' },
  logoutBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 16 },
  logoutText: { fontSize: 16, fontWeight: '600', color: colors.red },
});

// ── Appearance section — System / Light / Dark theme picker ────────────────
function AppearanceSection() {
  const colors = useColors();
  const styles = useMemo(() => createAppearanceStyles(colors), [colors]);
  const { mode, effective, setMode } = useTheme();

  const options: Array<{ key: ThemeMode; label: string; icon: keyof typeof Ionicons.glyphMap; hint: string }> = [
    { key: 'system', label: 'System', icon: 'phone-portrait-outline', hint: 'Match phone setting' },
    { key: 'light',  label: 'Light',  icon: 'sunny-outline',          hint: 'Always light' },
    { key: 'dark',   label: 'Dark',   icon: 'moon-outline',           hint: 'Soft charcoal' },
  ];

  return (
    <DepthCard style={styles.section}>
      <SectionHead size={22} style={styles.sectionHead}>Appearance</SectionHead>
      <View style={styles.row}>
        {options.map((opt) => {
          const active = mode === opt.key;
          return (
            <TouchableOpacity
              key={opt.key}
              style={[styles.option, active && styles.optionActive]}
              onPress={() => setMode(opt.key)}
              testID={`theme-${opt.key}`}
              accessibilityLabel={`${opt.label} theme`}
            >
              <Ionicons
                name={opt.icon}
                size={20}
                color={active ? colors.primary : colors.textMuted}
              />
              <Text style={[styles.optionLabel, active && styles.optionLabelActive]}>{opt.label}</Text>
              {/* Two lines: "Match phone setting" is wider than a third of the card and
                  used to ellipsise. The options are flex:1 in a stretch row, so the
                  taller one sets the height for all three and the tiles stay level. */}
              <Text style={styles.optionHint} numberOfLines={2}>{opt.hint}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      {mode === 'system' && (
        <Text style={styles.statusHint}>
          Currently following your phone — looks {effective === 'dark' ? 'dark' : 'light'} now.
        </Text>
      )}
    </DepthCard>
  );
}

const createAppearanceStyles = (colors: any) => StyleSheet.create({
  section: {
    marginBottom: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 16,
  },
  sectionHead: { marginBottom: 12 },
  row: { flexDirection: 'row', gap: 8 },
  option: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 12,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1.5,
    borderColor: 'transparent',
    alignItems: 'center',
    gap: 4,
  },
  optionActive: {
    borderColor: colors.primary,
    backgroundColor: colors.background,
  },
  optionLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.textSecondary,
    marginTop: 2,
  },
  optionLabelActive: { color: colors.primary },
  optionHint: { fontSize: 10, lineHeight: 13, color: colors.textMuted, fontWeight: '500', textAlign: 'center' },
  statusHint: {
    marginTop: 10,
    fontSize: 11,
    color: colors.textMuted,
    fontStyle: 'italic',
    textAlign: 'center',
  },
});

/* __theme_static_fallback__ */
// Fallback static styles (used if a sub-component didn't pick up the
// useColors hook). Always light-mode — won't react to theme changes.
const notifStyles = createNotifStyles(lightColors);
const teamStyles = createTeamStyles(lightColors);
const appearanceStyles = createAppearanceStyles(lightColors);
const styles = createStyles3(lightColors);

