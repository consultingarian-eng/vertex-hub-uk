import React, { createElement, useEffect, useMemo, useState } from 'react';
import { showAlert } from '../../utils/showAlert';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Image, TextInput, ActivityIndicator, Modal, Pressable, Platform, useWindowDimensions,  } from 'react-native';
import Slider from '@react-native-community/slider';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTabBarClearance } from '../../customization/CustomTabBar';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Print from 'expo-print';
import { Asset } from 'expo-asset';
import * as Sharing from 'expo-sharing';
import { exportPdfFromHtml, openBlankPrintWindow } from '../../utils/deliverPdf';
import { colors } from '../../theme/colors';
import { lightColors } from '../../theme/ThemeContext';
import { useColors } from '../../theme/ThemeContext';
import { apiService } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { convertHeicIfNeeded } from '../../utils/heicConvert';
import { ChoiceSheet } from '../../components/ChoiceSheet';
import { BrandLoader } from '../../components/ui/BrandLoader';
import { useActiveOffice } from '../../office/ActiveOfficeContext';
import OfficeToggle from '../../components/ui/OfficeToggle';
import { LinearGradient } from 'expo-linear-gradient';
import { GRADIENT } from '../../theme/ThemeContext';
import { GlowButton } from '../../components/ui/GlowButton';
import { SectionHead } from '../../components/ui/SectionHead';
import { DepthCard } from '../../components/ui/DepthCard';
import { useParallaxScroll } from '../../components/ui/Parallax';
import { APP_SHORT_NAME } from '../../theme/brand';
import { seesWholeOffice } from '../../utils/roleTitle';

// Badge numbers: 2–24 letters, numbers or dashes (matches the backend rule).
const BADGE_NUMBER_RE = /^[A-Z0-9][A-Z0-9-]{1,23}$/;
// ── The ID badge template ───────────────────────────────────────────────────
// assets/badges/badge-template.png is a neutral strip (drawn by
// scripts/badge_template.py): front on the left, back on the right, fold down
// the middle. It carries no charity, agency or regulator artwork. The app
// places the photo, name, ID number and expiry date on it, plus the
// organisation's name, its verification phone number and the badge's own QR
// code (from GET /badges/template: BADGE_ORG_NAME, BADGE_VERIFY_PHONE).
// Measured in millimetres on the strip.
const TEMPLATE_IMG = require('../../../assets/badges/badge-template.png');
// Where the bundled template lives (web: a served URL; native: the local asset).
// expo-asset, because react-native-web's Image has no resolveAssetSource.
const templateUri = () => Asset.fromModule(TEMPLATE_IMG).uri;
const STRIP_W_MM = 192.45;
const STRIP_H_MM = 60.16;
const MM_PER_IN = 25.4;
const BADGE_W_IN = STRIP_W_MM / MM_PER_IN; // about 7.58 in
const BADGE_H_IN = STRIP_H_MM / MM_PER_IN; // about 2.37 in
const FIELD = {
  photo: { x: 5.11, y: 3.48, w: 30.1, h: 37.4 },
  name: { x: 53.6, y: 20.2, w: 38.4 },
  id: { x: 62.7, y: 28.9, w: 29.4 },
  expiry: { x: 65.6, y: 37.9, w: 26.5 },
  // Organisation details (not on the bitmap, so every owner prints their own).
  orgSmall: { x: 3.0, y: 47.0, w: 20.5 },
  orgBig: { x: 43.5, y: 51.0, w: 49.5 },
  phone: { x: 99.2, y: 21.5, w: 90.0 },
  qr: { x: 24.5, y: 43.0, w: 13.5 },
} as const;
const FIELD_PT = 9.5;   // matches the template's own filled-in text
/** A new badge's expiry: generation date + 1 year, DD/MM/YYYY (the server sets the same). */
function defaultExpiry(): string {
  const d = new Date();
  const next = new Date(d.getFullYear() + 1, d.getMonth(), d.getDate());
  if (next.getMonth() !== d.getMonth()) next.setDate(0); // 29 Feb -> 28 Feb
  return next.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
/** Font size (pt) that fits `text` in `widthMm`, from the template's 9.5pt down to 6pt. */
function fitPt(text: string, widthMm: number): number {
  const perCharMm = 0.19; // average italic glyph width per pt, in mm
  return Math.max(6, Math.min(FIELD_PT, widthMm / (Math.max(1, text.length) * perCharMm)));
}

// Who the badge says the holder works for, and the number the public calls to
// check it. Read from the server (GET /badges/template); kept in a module
// variable too so the print HTML (built outside React) can use it.
type BadgeOrg = { authorized_by: string; verify_phone: string };
let _badgeOrg: BadgeOrg = { authorized_by: '', verify_phone: '' };
function useBadgeOrg(): BadgeOrg {
  const q = useQuery({
    queryKey: ['badge-template'],
    queryFn: async () => (await apiService.getBadgeTemplate()).data,
    staleTime: 10 * 60_000,
  });
  if (q.data) _badgeOrg = q.data;
  return q.data || _badgeOrg;
}
async function primeBadgeOrg(): Promise<void> {
  try { _badgeOrg = (await apiService.getBadgeTemplate()).data; } catch { /* print without it */ }
}

// The PDF renderer needs the template inline (a data URI), like the logo did.
let _templateDataUri: string | null = null;
async function primeTemplateDataUri(): Promise<string> {
  if (_templateDataUri) return _templateDataUri;
  const uri = templateUri();
  try {
    const blob = await (await fetch(uri)).blob();
    _templateDataUri = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onloadend = () => resolve(reader.result as string);
      reader.readAsDataURL(blob);
    });
  } catch {
    _templateDataUri = uri;
  }
  return _templateDataUri;
}

// ============================================================================
type BadgeRow = {
  id: string; full_name: string; badge_number: string; user_id?: string | null;
  office_id?: string | null;
  created_at: string; created_by_name: string; expiry_date: string;
};
export type BadgeFull = BadgeRow & {
  photo_base64: string; qr_base64: string; qr_url: string;
  photo_zoom?: number; photo_position_y?: number;
};

export default function BadgesScreen() {
  const colors = useColors();
  const styles = useMemo(() => createStyles3(colors), [colors]);

  const tabBarClearance = useTabBarClearance();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const canUse = seesWholeOffice(user);   // Admins and Coach+ only

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<BadgeFull | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  // Multi-select state: Set of badge IDs; max 4
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchExporting, setBatchExporting] = useState(false);
  const [batchProgress, setBatchProgress] = useState<string>('');
  // Export options modal: set when user taps Export → opens sliders; null when closed
  const [exportBadges, setExportBadges] = useState<BadgeFull[] | null>(null);
  // Feeds the global page scroll phase (masthead condense, card sheens).
  const { onScroll } = useParallaxScroll();

  const list = useQuery<BadgeRow[]>({
    queryKey: ['badges-list'],
    queryFn: () => apiService.listBadges().then((r) => r.data),
    staleTime: 1000 * 15,
  });

  // Office scoping — mirrors Bells/Team/etc. Super admins get the shared
  // OfficeToggle bubble selector (below) and view one office at a time; regular
  // leaders/admins are pinned to their single office (canSwitch=false) and the
  // backend already scopes their list, so no client-side filter is needed.
  const { officeId, canSwitch } = useActiveOffice();
  const visibleBadges = useMemo(() => {
    const rows = list.data || [];
    if (!canSwitch) return rows;
    return rows.filter((b) => (b.office_id || '') === (officeId || ''));
  }, [list.data, canSwitch, officeId]);

  const delMut = useMutation({
    mutationFn: (id: string) => apiService.deleteBadge(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['badges-list'] }),
  });

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        if (next.size >= 4) {
          showAlert('Max 4 badges', 'You can export up to 4 badges at a time.');
          return prev;
        }
        next.add(id);
      }
      return next;
    });
  };

  const clearSelection = () => setSelected(new Set());

  const exportSelected = async () => {
    if (selected.size === 0 || batchExporting) return;
    try {
      setBatchExporting(true);
      const ids = Array.from(selected);
      setBatchProgress(`Loading ${ids.length} badge${ids.length > 1 ? 's' : ''}…`);
      // Fetch full badge data sequentially for accurate progress + lower memory pressure
      const fulls: BadgeFull[] = [];
      for (let i = 0; i < ids.length; i++) {
        setBatchProgress(`Loading ${i + 1} of ${ids.length}…`);
        const r = await apiService.getBadge(ids[i]);
        fulls.push(r.data as BadgeFull);
      }
      // Hand off to the Export Options modal — user picks scale + margin, then generates PDF
      setExportBadges(fulls);
    } catch (e: any) {
      showAlert('Export failed', e?.message || 'Could not load badges');
    } finally {
      setBatchExporting(false);
      setBatchProgress('');
    }
  };

  if (!canUse) {
    return (
      <View style={[styles.container, { padding: 40 }]}>
        <Text style={{ color: colors.text, fontSize: 16 }}>Badges are for Admins and Coach+ only.</Text>
      </View>
    );
  }

  const selectionCount = selected.size;
  const inSelectMode = selectionCount > 0;

  const renderCard = (b: BadgeRow, i: number) => {
    const isSelected = selected.has(b.id);
    return (
      <DepthCard
        key={b.id}
        index={i}
        sheen={false}
        edge={isSelected ? 'gradient' : 'none'}
        style={[styles.card, isSelected && styles.cardSelected]}
      >
        {/* Checkbox on far left — gradient rim once selected */}
        <TouchableOpacity
          onPress={() => toggleSelect(b.id)}
          style={styles.checkboxHit}
          testID={`badge-select-${b.badge_number}`}
          accessibilityLabel={isSelected ? 'Deselect badge' : 'Select badge'}
        >
          {isSelected ? (
            <LinearGradient
              colors={GRADIENT}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.checkboxRim}
            >
              <View style={[styles.checkbox, styles.checkboxChecked]}>
                <Ionicons name="checkmark" size={16} color="#fff" />
              </View>
            </LinearGradient>
          ) : (
            <View style={styles.checkboxRimOff}>
              <View style={styles.checkbox} />
            </View>
          )}
        </TouchableOpacity>
        <TouchableOpacity style={{ flex: 1 }} onPress={() => setViewing(b.id)} testID={`badge-card-${b.badge_number}`}>
          <Text style={styles.cardName}>{b.full_name}</Text>
          <Text style={styles.cardBadge}>{b.badge_number}</Text>
          <Text style={styles.cardMeta}>Created by {b.created_by_name} · Expires {b.expiry_date}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setViewing(b.id)} style={styles.iconBtn}>
          <Ionicons name="document-text-outline" size={20} color={colors.primary} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={async () => {
            try {
              const r = await apiService.getBadge(b.id);
              setEditing(r.data as BadgeFull);
            } catch (e: any) {
              showAlert('Error', e?.response?.data?.detail || 'Could not load badge');
            }
          }}
          style={styles.iconBtn}
          accessibilityLabel={`Edit ${b.full_name}'s badge`}
        >
          <Ionicons name="create-outline" size={18} color={colors.primary} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => showAlert('Delete badge?', `Permanently remove ${b.full_name}'s badge?`, [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Delete', style: 'destructive', onPress: () => delMut.mutate(b.id) },
          ])}
          style={styles.iconBtn}
        >
          <Ionicons name="trash-outline" size={18} color={colors.textMuted} />
        </TouchableOpacity>
      </DepthCard>
    );
  };

  return (
    <View style={styles.container}>
      <ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentContainerStyle={{ padding: 16, paddingBottom: 120 + tabBarClearance }}
      >
        {/* Primary CTA — gradient face, lit bevel, slow breathe (spec §3.15) */}
        <GlowButton breathe onPress={() => setCreating(true)} testID="create-badge-btn">
          <Ionicons name="add-circle" size={22} color="#fff" />
          <Text style={styles.createBtnText}>Create New Badge</Text>
        </GlowButton>

        {/* Office bubble selector (super admins only — auto-hides for single-office users) */}
        <OfficeToggle style={{ marginTop: 16 }} />

        <View style={styles.headBlock}>
          <SectionHead size={22}>{`Saved Badges (${visibleBadges.length})`}</SectionHead>
          {visibleBadges.length > 0 && !inSelectMode && (
            <Text style={[styles.hintText, styles.hintRight]}>Tap ⬜ to select up to 4</Text>
          )}
        </View>

        {list.isLoading ? <ActivityIndicator color={colors.primary} /> : null}
        {!list.isLoading && visibleBadges.length === 0 ? (
          <DepthCard style={styles.emptyBox}>
            <Ionicons name="qr-code-outline" size={48} color={colors.textMuted} />
            <Text style={styles.emptyText}>No badges yet. Create your first one above.</Text>
          </DepthCard>
        ) : null}

        {visibleBadges.map((b, i) => renderCard(b, i))}
      </ScrollView>

      {/* Sticky bottom bar when 1+ badges selected */}
      {inSelectMode && (
        <View style={[styles.batchBar, { bottom: tabBarClearance, paddingBottom: 12 }]}>
          <TouchableOpacity onPress={clearSelection} style={styles.batchBarClear} testID="batch-clear">
            <Ionicons name="close" size={18} color={colors.text} />
            <Text style={styles.batchBarClearText}>Clear</Text>
          </TouchableOpacity>
          <Text style={styles.batchBarCount}>
            {batchExporting && batchProgress ? batchProgress : `${selectionCount} / 4 selected`}
          </Text>
          <TouchableOpacity
            style={[styles.batchBarExport, batchExporting && { opacity: 0.6 }]}
            onPress={exportSelected}
            disabled={batchExporting}
            testID="batch-export"
          >
            {batchExporting ? <ActivityIndicator color={colors.onPrimary} /> : <Ionicons name="print-outline" size={18} color={colors.onPrimary} />}
            <Text style={styles.batchBarExportText}>
              {batchExporting ? 'Please wait' : `Export`}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {creating && (
        <CreateBadgeModal
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            queryClient.invalidateQueries({ queryKey: ['badges-list'] });
            setViewing(id);
          }}
        />
      )}

      {editing && (
        <CreateBadgeModal
          editBadge={editing}
          onClose={() => setEditing(null)}
          onCreated={(id) => {
            setEditing(null);
            queryClient.invalidateQueries({ queryKey: ['badges-list'] });
            queryClient.invalidateQueries({ queryKey: ['badge', id] });
            setViewing(id);
          }}
        />
      )}

      {viewing && (
        <ViewBadgeModal
          badgeId={viewing}
          onClose={() => setViewing(null)}
          onExport={(badge) => setExportBadges([badge])}
          onEdit={(badge) => {
            setViewing(null);
            setEditing(badge);
          }}
        />
      )}

      {exportBadges && (
        <ExportOptionsModal
          badges={exportBadges}
          onClose={() => setExportBadges(null)}
          onDone={() => {
            setExportBadges(null);
            clearSelection();
          }}
        />
      )}
    </View>
  );
}

// ============================================================================
// PersonBadgeFlow — one person's badge, from their own page: preview and print
// the badge they have, or make one with their name and badge number filled in.
// ============================================================================
export function PersonBadgeFlow({ badgeId, prefill, onClose, onChanged }: {
  /** Their saved badge, if they have one. Without it the flow starts at Create. */
  badgeId?: string | null; prefill: BadgePrefill; onClose: () => void; onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [viewing, setViewing] = useState<string | null>(badgeId || null);
  const [creating, setCreating] = useState(!badgeId);
  const [editing, setEditing] = useState<BadgeFull | null>(null);
  const [exporting, setExporting] = useState<BadgeFull[] | null>(null);
  const saved = (id: string) => {
    queryClient.invalidateQueries({ queryKey: ['badges-list'] });
    queryClient.invalidateQueries({ queryKey: ['badge', id] });
    onChanged();
    setCreating(false); setEditing(null); setViewing(id);
  };
  return (
    <>
      {creating && <CreateBadgeModal prefill={prefill} onClose={onClose} onCreated={saved} />}
      {editing && <CreateBadgeModal editBadge={editing} onClose={() => setEditing(null)} onCreated={saved} />}
      {viewing && !editing && (
        <ViewBadgeModal
          badgeId={viewing}
          onClose={onClose}
          onExport={(badge) => setExporting([badge])}
          onEdit={(badge) => setEditing(badge)}
        />
      )}
      {exporting && <ExportOptionsModal badges={exporting} onClose={() => setExporting(null)} onDone={() => setExporting(null)} />}
    </>
  );
}

// ============================================================================
// BadgeCard — in-app preview that mirrors BadgePreview.jsx (7"×2" unfolded)
// ============================================================================
function BadgeCard({
  photoUri, name, badgeNumber, qrUri, expiry,
  photoZoom = 1.18, photoPositionY = 30, width,
}: {
  photoUri: string | null; name: string; badgeNumber: string; qrUri?: string | null;
  expiry?: string | null; photoZoom?: number; photoPositionY?: number; width: number;
}) {
  // mm on the template -> px on screen
  const k = width / STRIP_W_MM;
  const H = STRIP_H_MM * k;
  const displayName = (name || 'Full Name').trim();
  const displayNumber = badgeNumber || 'XXXXXX';
  const displayExpiry = (expiry || '').trim() || 'DD/MM/YYYY';
  const org = useBadgeOrg();
  const text = (value: string, f: { x: number; y: number; w: number }, bold = false, center = false) => (
    <Text
      numberOfLines={1}
      style={{
        position: 'absolute', left: f.x * k, top: f.y * k, width: f.w * k,
        fontSize: fitPt(value, f.w) * 0.3528 * k, fontStyle: 'italic',
        fontWeight: bold ? '700' : '400', color: '#111',
        textAlign: center ? 'center' : 'left',
      }}
    >
      {value}
    </Text>
  );
  const P = FIELD.photo;
  return (
    <View style={{ width, height: H, backgroundColor: '#fff' }}>
      <Image source={TEMPLATE_IMG} style={{ position: 'absolute', width, height: H }} resizeMode="stretch" />
      <View style={{ position: 'absolute', left: P.x * k, top: P.y * k, width: P.w * k, height: P.h * k,
        overflow: 'hidden', backgroundColor: '#fff' }}>
        {photoUri ? (
          <Image
            source={{ uri: photoUri }}
            style={{
              width: '100%', height: '100%',
              transform: [
                { scale: photoZoom },
                // positionY 0 -> align top, 100 -> align bottom
                { translateY: ((50 - photoPositionY) / 100) * P.h * k * (photoZoom - 1) * 1.2 },
              ],
            }}
            resizeMode="cover"
          />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#e5e5e5' }}>
            <Ionicons name="person-outline" size={P.w * k * 0.4} color="#8a8a8a" />
          </View>
        )}
      </View>
      {text(displayName, FIELD.name)}
      {text(displayNumber, FIELD.id)}
      {text(displayExpiry, FIELD.expiry, true)}
      {org.authorized_by ? text(org.authorized_by, FIELD.orgSmall, true) : null}
      {org.authorized_by ? text(org.authorized_by, FIELD.orgBig, true) : null}
      {org.verify_phone ? text(org.verify_phone, FIELD.phone, true, true) : null}
      {qrUri ? (
        <Image source={{ uri: qrUri }} resizeMode="contain" style={{ position: 'absolute',
          left: FIELD.qr.x * k, top: FIELD.qr.y * k, width: FIELD.qr.w * k, height: FIELD.qr.w * k }} />
      ) : null}
    </View>
  );
}

// ============================================================================
// FitSlider — on web this is a REAL <input type="range">, not the community
// Slider: RN-web's press-responder slider is barely draggable in the iOS PWA
// (micro-drags read as scrolls, the thumb loses pointer capture), while the
// native range input tracks the finger perfectly. touch-action:none keeps a
// slider drag from scrolling the sheet. Native keeps the community Slider.
// ============================================================================
function FitSlider({ value, min, max, step, height = 32, onChange }: {
  value: number; min: number; max: number; step: number; height?: number; onChange: (v: number) => void;
}) {
  if (Platform.OS === 'web') {
    return (
      <View style={{ width: '100%', height, justifyContent: 'center' }}>
        {createElement('input', {
          type: 'range',
          min, max, step, value,
          onChange: (e: any) => onChange(parseFloat(e.target.value)),
          style: {
            width: '100%', height, margin: 0, padding: 0,
            accentColor: colors.primary, touchAction: 'none', cursor: 'pointer',
          },
        })}
      </View>
    );
  }
  return (
    <Slider
      style={{ width: '100%', height }}
      minimumValue={min}
      maximumValue={max}
      step={step}
      value={value}
      onValueChange={onChange}
      minimumTrackTintColor={colors.primary}
      maximumTrackTintColor="#BED393"
      thumbTintColor={colors.primary}
    />
  );
}

// ============================================================================
// Create / Edit Modal — pass `editBadge` to edit an existing badge in place
// (wrong name, wrong badge number → QR regenerates server-side; photo kept
// unless replaced) instead of recreating it from scratch.
// ============================================================================
/** Who a new badge is for, when it is started from that person's page. */
export type BadgePrefill = { full_name?: string; badge_number?: string; user_id?: string };

export function CreateBadgeModal({ onClose, onCreated, editBadge, prefill }: {
  onClose: () => void; onCreated: (id: string) => void; editBadge?: BadgeFull; prefill?: BadgePrefill;
}) {
  const insets = useSafeAreaInsets();
  const { width: windowW } = useWindowDimensions();
  const [fullName, setFullName] = useState(editBadge?.full_name ?? prefill?.full_name ?? '');
  const [badgeNumber, setBadgeNumber] = useState(editBadge?.badge_number ?? (prefill?.badge_number || '').toUpperCase());
  const [photoRaw, setPhotoRaw] = useState<string | null>(null);
  // Editing starts from the saved photo (already background-removed PNG).
  const [photoProcessed, setPhotoProcessed] = useState<string | null>(editBadge?.photo_base64 ?? null);
  const [processing, setProcessing] = useState(false);

  // Photo fit controls (mirror original PhotoFitControls defaults)
  const [photoZoom, setPhotoZoom] = useState(editBadge?.photo_zoom ?? 1.18);
  const [photoPositionY, setPhotoPositionY] = useState(editBadge?.photo_position_y ?? 30);

  const activePhotoUri = photoProcessed
    ? `data:image/png;base64,${photoProcessed}`
    : photoRaw
      ? `data:image/jpeg;base64,${photoRaw}`
      : null;

  // Handle a picked asset (shared code path for camera + library).
  const processPickedAsset = async (asset: ImagePicker.ImagePickerAsset) => {
    if (!asset?.base64 && !asset?.uri) {
      showAlert('Error', 'Could not load photo.');
      return;
    }
    try {
      const manipulated = await ImageManipulator.manipulateAsync(
        asset.uri,
        [{ resize: { width: 1200 } }],
        { compress: 0.92, format: ImageManipulator.SaveFormat.JPEG, base64: true }
      );
      setPhotoRaw(manipulated.base64 || asset.base64 || null);
      setPhotoProcessed(null);
    } catch (err: any) {
      showAlert('Error', err?.message || 'Could not process that photo.');
    }
  };

  // Web: read a File the browser handed us straight into state. Shared by the
  // real <input type="file"> that sits over the Pick-photo button (see JSX).
  const ingestWebFile = async (file: File) => {
    try {
      const blob: Blob = await convertHeicIfNeeded(file);
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const b64 = result.includes(',') ? result.split(',')[1] : result;
        setPhotoRaw(b64);
        setPhotoProcessed(null);
      };
      reader.onerror = () => showAlert('Error', 'Could not read that image.');
      reader.readAsDataURL(blob);
    } catch (err: any) {
      showAlert('Error', err?.message || 'Could not load that image. Try a JPEG or PNG.');
    }
  };

  const pickFromGallery = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (perm.status !== 'granted') {
        showAlert('Permission needed', 'Please allow photo access.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.92,
        base64: true,
      });
      if (result.canceled) return;
      const asset = result.assets?.[0];
      if (asset) await processPickedAsset(asset);
    } catch (err: any) {
      // Never fail silently — an unhandled rejection here looked exactly like
      // "the button does nothing".
      showAlert('Could not open photos', err?.message || 'Please try again.');
    }
  };

  const takePhoto = async () => {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (perm.status !== 'granted') {
        showAlert('Camera permission needed', 'Please allow camera access in Settings to take photos.');
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.92,
        base64: true,
        cameraType: ImagePicker.CameraType.front,
      });
      if (result.canceled) return;
      const asset = result.assets?.[0];
      if (asset) await processPickedAsset(asset);
    } catch (err: any) {
      showAlert('Could not open the camera', err?.message || 'Please try again.');
    }
  };

  // Photo source picker
  // We use a native system Alert (system dialog, NOT a React Native <Modal>)
  // because the badge editor is already inside a Modal — and iOS will not
  // reliably present the system camera/photo picker if a JS-managed Modal
  // is mid-dismissing on top. The Alert opens, the user taps an option, the
  // alert dismisses, and the picker opens — clean, no timing race.
  const pickImage = () => {
    showAlert(
      'Add Badge Photo',
      'How would you like to add the photo?',
      [
        { text: 'Take Photo', onPress: () => takePhoto() },
        { text: 'Choose from Gallery', onPress: () => pickFromGallery() },
        { text: 'Cancel', style: 'cancel' },
      ],
      { cancelable: true }
    );
  };
  // Kept for backward compat — no longer used, but referenced elsewhere in JSX.
  const [photoSourcePickerVisible, setPhotoSourcePickerVisible] = useState(false);
  const handlePhotoSourcePick = (source: 'camera' | 'gallery') => {
    setPhotoSourcePickerVisible(false);
    setTimeout(() => {
      if (source === 'camera') takePhoto();
      else pickFromGallery();
    }, 350);
  };

  const removeBgMut = useMutation({
    mutationFn: async () => {
      if (!photoRaw) throw new Error('No photo');
      setProcessing(true);
      try {
        const r = await apiService.removeBadgeBackground(photoRaw);
        return r.data.image_base64 as string;
      } finally {
        setProcessing(false);
      }
    },
    onSuccess: (processed) => setPhotoProcessed(processed),
    onError: (err: any) => {
      const msg = err?.response?.data?.detail || 'Background removal failed — try a clearer, well-lit photo.';
      showAlert('Error', typeof msg === 'string' ? msg : 'Background removal failed');
    },
  });

  const createMut = useMutation({
    mutationFn: () => {
      const payload = {
        full_name: fullName.trim(),
        badge_number: badgeNumber.trim().toUpperCase(),
        photo_base64: photoProcessed || photoRaw || '',
        photo_zoom: photoZoom,
        photo_position_y: photoPositionY,
      };
      return (editBadge
        ? apiService.updateBadge(editBadge.id, payload)
        : apiService.createBadge({ ...payload, user_id: prefill?.user_id || null })
      ).then((r) => r.data);
    },
    onSuccess: (badge: any) => onCreated(badge.id),
    onError: (err: any) => {
      const verb = editBadge ? 'update' : 'create';
      const msg = err?.response?.data?.detail || `Could not ${verb} badge`;
      showAlert('Error', typeof msg === 'string' ? msg : `Could not ${verb} badge`);
    },
  });

  const canCreate = useMemo(() => {
    const ok = fullName.trim().length > 1
      && BADGE_NUMBER_RE.test(badgeNumber.trim().toUpperCase())
      && (photoProcessed || photoRaw);
    return !!ok;
  }, [fullName, badgeNumber, photoRaw, photoProcessed]);

  const previewWidth = Math.min(windowW - 32, 560);

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: insets.top }}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalHeaderTitle}>{editBadge ? 'Edit Badge' : 'Create Badge'}</Text>
          <Pressable onPress={onClose}><Ionicons name="close" size={26} color={colors.text} /></Pressable>
        </View>
        {/* keyboardShouldPersistTaps: with the keyboard up from the name field,
            the first tap on any button only dismissed the keyboard. */}
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }} keyboardShouldPersistTaps="handled">

          {/* Live preview at top — always visible */}
          <View style={{ alignItems: 'center', marginBottom: 16 }}>
            <BadgeCard
              photoUri={activePhotoUri}
              name={fullName}
              badgeNumber={badgeNumber}
              // While editing, the saved QR is only valid as long as the number
              // hasn't been touched — a changed number regenerates server-side.
              qrUri={editBadge && badgeNumber === editBadge.badge_number ? `data:image/png;base64,${editBadge.qr_base64}` : null}
              expiry={editBadge?.expiry_date || defaultExpiry()}
              photoZoom={photoZoom}
              photoPositionY={photoPositionY}
              width={previewWidth}
            />
            <Text style={styles.previewCaption}>Live preview (unfolded, front left, back right)</Text>
          </View>

          <Text style={styles.label}>Full Name *</Text>
          <TextInput value={fullName} onChangeText={setFullName} style={styles.input}
            autoCapitalize="words" placeholder="Jane Doe" placeholderTextColor={colors.textMuted} />

          <Text style={styles.label}>Badge Number *</Text>
          <TextInput
            value={badgeNumber}
            onChangeText={(v) => {
              setBadgeNumber(v.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24));
            }}
            style={styles.input}
            autoCapitalize="characters"
            placeholder="B1234"
            placeholderTextColor={colors.textMuted}
          />

          <Text style={styles.label}>Photo *</Text>
          <View style={styles.photoBox}>
            <View style={[styles.photoPreview, { overflow: 'hidden' }]}>
              {activePhotoUri ? (
                <Image source={{ uri: activePhotoUri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
              ) : (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EDF3E4' }}>
                  <Ionicons name="person-outline" size={48} color={colors.textMuted} />
                </View>
              )}
            </View>
            <View style={{ flex: 1, gap: 8 }}>
              {/* Web: a REAL <input type="file"> stretched invisibly over the
                  button. Opening a file dialog needs transient user
                  activation, and react-native-web's Touchable dispatches
                  onPress from its press-responder — often outside the original
                  gesture — so document.createElement('input').click() was
                  being swallowed by the browser and the button did nothing.
                  Letting the tap land on the input itself always works, and
                  iOS's own sheet already offers Photo Library / Take Photo /
                  Choose File, so the extra in-app chooser isn't needed here. */}
              {Platform.OS === 'web' ? (
                <View style={{ position: 'relative' }}>
                  <View style={styles.secondaryBtn} pointerEvents="none">
                    <Ionicons name="image-outline" size={18} color={colors.primary} />
                    <Text style={styles.secondaryBtnText}>{activePhotoUri ? 'Change photo' : 'Pick photo'}</Text>
                  </View>
                  {createElement('input', {
                    type: 'file',
                    accept: 'image/*,.heic,.heif',
                    'aria-label': activePhotoUri ? 'Change photo' : 'Pick photo',
                    onChange: (e: any) => {
                      const file = e.target.files?.[0];
                      // Clear so re-picking the SAME file still fires onChange.
                      if (file) ingestWebFile(file);
                      e.target.value = '';
                    },
                    style: {
                      position: 'absolute',
                      top: 0, left: 0, width: '100%', height: '100%',
                      opacity: 0, border: 'none', margin: 0, padding: 0,
                      cursor: 'pointer', fontSize: 16,
                    },
                  })}
                </View>
              ) : (
                <TouchableOpacity style={styles.secondaryBtn} onPress={pickImage}>
                  <Ionicons name="image-outline" size={18} color={colors.primary} />
                  <Text style={styles.secondaryBtnText}>{activePhotoUri ? 'Change photo' : 'Pick photo'}</Text>
                </TouchableOpacity>
              )}
              {photoRaw && (
                Platform.OS === 'web' ? (
                  // Same trick as the file input above: a REAL <button> takes
                  // the tap. RN-web's press responder was treating the tiny
                  // finger movement of a PWA tap as a scroll and cancelling
                  // the press — "remove background needs a few taps".
                  <View style={{ position: 'relative' }}>
                    <View style={[styles.secondaryBtn, processing && { opacity: 0.6 }]} pointerEvents="none">
                      {processing ? <ActivityIndicator color={colors.primary} /> : <Ionicons name="sparkles-outline" size={18} color={colors.primary} />}
                      <Text style={styles.secondaryBtnText}>
                        {processing ? 'Removing…' : photoProcessed ? 'Re-run BG removal' : 'Remove background'}
                      </Text>
                    </View>
                    {createElement('button', {
                      type: 'button',
                      'aria-label': 'Remove background',
                      disabled: processing,
                      onClick: () => removeBgMut.mutate(),
                      style: {
                        position: 'absolute',
                        top: 0, left: 0, width: '100%', height: '100%',
                        opacity: 0, border: 'none', margin: 0, padding: 0,
                        background: 'transparent', cursor: 'pointer',
                      },
                    })}
                  </View>
                ) : (
                  <TouchableOpacity
                    style={[styles.secondaryBtn, processing && { opacity: 0.6 }]}
                    onPress={() => removeBgMut.mutate()}
                    disabled={processing}
                  >
                    {processing ? <ActivityIndicator color={colors.primary} /> : <Ionicons name="sparkles-outline" size={18} color={colors.primary} />}
                    <Text style={styles.secondaryBtnText}>
                      {processing ? 'Removing…' : photoProcessed ? 'Re-run BG removal' : 'Remove background'}
                    </Text>
                  </TouchableOpacity>
                )
              )}
            </View>
          </View>
          <Text style={styles.helpText}> </Text>

          {/* Photo Fit Controls (Zoom + Vertical position sliders) */}
          {activePhotoUri && (
            <View style={styles.fitBox}>
              <View style={styles.fitHeader}>
                <Text style={styles.fitHeaderText}>PHOTO FIT</Text>
                <TouchableOpacity onPress={() => { setPhotoZoom(1.18); setPhotoPositionY(30); }}>
                  <Text style={styles.fitReset}>Reset</Text>
                </TouchableOpacity>
              </View>

              <View style={styles.sliderRow}>
                <View style={styles.sliderLabelRow}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Ionicons name="search" size={13} color={colors.textMuted} />
                    <Text style={styles.sliderLabel}>Zoom</Text>
                  </View>
                  <Text style={styles.sliderValue}>{photoZoom.toFixed(2)}×</Text>
                </View>
                <FitSlider value={photoZoom} min={1} max={1.8} step={0.02} onChange={setPhotoZoom} />
              </View>

              <View style={styles.sliderRow}>
                <View style={styles.sliderLabelRow}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Ionicons name="swap-vertical" size={13} color={colors.textMuted} />
                    <Text style={styles.sliderLabel}>Vertical</Text>
                  </View>
                  <Text style={styles.sliderValue}>{photoPositionY}%</Text>
                </View>
                <FitSlider value={photoPositionY} min={0} max={100} step={1} onChange={(v) => setPhotoPositionY(Math.round(v))} />
                <View style={styles.sliderCaptions}>
                  <Text style={styles.sliderCaption}>HEAD TOP</Text>
                  <Text style={styles.sliderCaption}>SHOULDERS</Text>
                </View>
              </View>
            </View>
          )}

          <TouchableOpacity
            style={[styles.primaryBtn, { marginTop: 24 }, (!canCreate || createMut.isPending) && { opacity: 0.5 }]}
            onPress={() => createMut.mutate()}
            disabled={!canCreate || createMut.isPending}
          >
            {createMut.isPending ? <ActivityIndicator color={colors.onPrimary} /> : (
              <>
                <Ionicons name="save-outline" size={18} color={colors.onPrimary} />
                <Text style={styles.primaryBtnText}>{editBadge ? 'Save Changes' : 'Save Badge'}</Text>
              </>
            )}
          </TouchableOpacity>
        </ScrollView>
      </View>

      {/* Bottom-sheet picker — where should the badge photo come from? */}
      <ChoiceSheet
        visible={photoSourcePickerVisible}
        title="Add Badge Photo"
        subtitle="How would you like to add the photo?"
        options={[
          { label: 'Take Photo', subtitle: 'Use the camera', value: 'camera', icon: 'camera' },
          { label: 'Choose from Gallery', subtitle: 'Pick an existing image', value: 'gallery', icon: 'images' },
        ]}
        onSelect={(v) => handlePhotoSourcePick(v as 'camera' | 'gallery')}
        onClose={() => setPhotoSourcePickerVisible(false)}
      />
    </Modal>
  );
}
// ============================================================================
export function ViewBadgeModal({ badgeId, onClose, onExport, onEdit }: { badgeId: string; onClose: () => void; onExport: (b: BadgeFull) => void; onEdit: (b: BadgeFull) => void }) {
  const insets = useSafeAreaInsets();
  const { width: windowW } = useWindowDimensions();
  const q = useQuery<BadgeFull>({
    queryKey: ['badge', badgeId],
    queryFn: () => apiService.getBadge(badgeId).then((r) => r.data),
  });

  const previewWidth = Math.min(windowW - 32, 560);

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: insets.top }}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalHeaderTitle}>Badge Preview</Text>
          <Pressable onPress={onClose}><Ionicons name="close" size={26} color={colors.text} /></Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}>
          {q.isLoading || !q.data ? (
            <BrandLoader size={52} />
          ) : (
            <>
              <Text style={styles.cardName}>{q.data.full_name}</Text>
              <Text style={styles.cardBadge}>{q.data.badge_number}</Text>
              <Text style={styles.cardMeta}>Expires {q.data.expiry_date}</Text>

              <View style={{ alignItems: 'center', marginTop: 16 }}>
                <BadgeCard
                  photoUri={`data:image/png;base64,${q.data.photo_base64}`}
                  name={q.data.full_name}
                  badgeNumber={q.data.badge_number}
                  qrUri={`data:image/png;base64,${q.data.qr_base64}`}
                  expiry={q.data.expiry_date}
                  photoZoom={q.data.photo_zoom ?? 1.18}
                  photoPositionY={q.data.photo_position_y ?? 30}
                  width={previewWidth}
                />
                <Text style={styles.previewCaption}>Unfolded. Left = front, right = back. Fold down the middle.</Text>
              </View>

              <TouchableOpacity style={[styles.primaryBtn, { marginTop: 16 }]} onPress={() => q.data && onExport(q.data)}>
                <Ionicons name="print-outline" size={18} color={colors.onPrimary} />
                <Text style={styles.primaryBtnText}>Export…</Text>
              </TouchableOpacity>

              <TouchableOpacity style={[styles.secondaryBtn, { marginTop: 10 }]} onPress={() => q.data && onEdit(q.data)}>
                <Ionicons name="create-outline" size={18} color={colors.primary} />
                <Text style={styles.secondaryBtnText}>Edit badge (name, number, photo…)</Text>
              </TouchableOpacity>
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

// ============================================================================
// buildBadgeHtml — print-ready multi-badge PDF with customizable scale + margin
// ============================================================================
type ExportOpts = { scale: number; sideMargin: number; topMargin: number };

// Native prints via iOS's share/print flow, which adds its own page scaling —
// 92% keeps the badge safely inside the printable area there. The PWA prints
// through the browser at true size, so it gets the full 100%.
const DEFAULT_SCALE = Platform.OS === 'web' ? 1.0 : 0.92;

function buildBadgeRowHtml(b: BadgeFull, scale: number): string {
  const photo = `data:image/png;base64,${b.photo_base64}`;
  const tpl = _templateDataUri || templateUri();
  const zoom = b.photo_zoom ?? 1.18;
  const positionY = b.photo_position_y ?? 30;
  const name = (b.full_name || 'Full Name').trim();
  const num = b.badge_number || 'XXXXXX';
  const expiry = (b.expiry_date || '').trim() || 'DD/MM/YYYY';
  const field = (value: string, f: { x: number; y: number; w: number }, bold = false, center = false) =>
    `<div class="field" style="left:${f.x}mm; top:${f.y}mm; width:${f.w}mm; font-size:${fitPt(value, f.w).toFixed(2)}pt;${bold ? ' font-weight:700;' : ''}${center ? ' text-align:center;' : ''}">${escapeHtml(value)}</div>`;
  const org = _badgeOrg;
  const Q = FIELD.qr;
  const P = FIELD.photo;
  return `
    <div class="row">
      <div class="badge-scale" style="width:${(STRIP_W_MM * scale).toFixed(2)}mm; height:${(STRIP_H_MM * scale).toFixed(2)}mm;">
        <div class="badge" style="transform: scale(${scale}); transform-origin: top left;">
          <img class="tpl" src="${tpl}" alt=""/>
          <div class="photo-box" style="left:${P.x}mm; top:${P.y}mm; width:${P.w}mm; height:${P.h}mm;">
            <img class="photo" src="${photo}" alt="photo" style="
              object-fit: cover;
              object-position: center ${positionY}%;
              transform: scale(${zoom});
              transform-origin: center ${positionY}%;
            "/>
          </div>
          ${field(name, FIELD.name)}
          ${field(num, FIELD.id)}
          ${field(expiry, FIELD.expiry, true)}
          ${org.authorized_by ? field(org.authorized_by, FIELD.orgSmall, true) : ''}
          ${org.authorized_by ? field(org.authorized_by, FIELD.orgBig, true) : ''}
          ${org.verify_phone ? field(org.verify_phone, FIELD.phone, true, true) : ''}
          ${b.qr_base64 ? `<img class="qr" src="data:image/png;base64,${b.qr_base64}" alt="" style="left:${Q.x}mm; top:${Q.y}mm; width:${Q.w}mm; height:${Q.w}mm;"/>` : ''}
        </div>
      </div>
    </div>`;
}

function wrapBadgeHtml(rowsHtml: string, opts: ExportOpts): string {
  const { sideMargin, topMargin } = opts;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>
  @page { size: A4; margin: 0; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: Arial, 'Helvetica Neue', Helvetica, sans-serif;
    color: #111;
    padding: ${topMargin}in ${sideMargin}in ${sideMargin}in ${sideMargin}in;
    box-sizing: border-box;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .row { display: flex; justify-content: center; margin: 0 0 6mm 0; page-break-inside: avoid; }
  .row:last-child { margin-bottom: 0; }
  .badge-scale { overflow: visible; }
  .badge { position: relative; width: ${STRIP_W_MM}mm; height: ${STRIP_H_MM}mm; }
  .badge .tpl { position: absolute; left: 0; top: 0; width: 100%; height: 100%; display: block; }
  .photo-box { position: absolute; overflow: hidden; background: #fff; }
  .photo-box .photo { width: 100%; height: 100%; display: block; }
  .badge .qr { position: absolute; display: block; }
  .field { position: absolute; font-style: italic; line-height: 1.15; white-space: nowrap; overflow: hidden; }
  .cuthelp { font-size: 7px; color: #999; text-align: center; margin: 3mm 0 0 0; }
</style>
</head>
<body>
  ${rowsHtml}
  <div class="cuthelp">Cut around each badge's outer border, then fold the front (left) behind the back (right) down the middle.</div>
</body>
</html>`;
}

function buildBadgeHtmlForExport(badges: BadgeFull[], opts: ExportOpts): string {
  // 1 badge per row, up to the number provided (user selects 1-4 via checkboxes)
  const rows = badges.slice(0, 4).map((b) => buildBadgeRowHtml(b, opts.scale)).join('');
  return wrapBadgeHtml(rows, opts);
}

function escapeHtml(s: string) {
  return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]);
}

// ============================================================================
// ExportOptionsModal — scale + margin sliders with live preview, then export
// ============================================================================
export function ExportOptionsModal({ badges, onClose, onDone }: {
  badges: BadgeFull[]; onClose: () => void; onDone: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { width: windowW } = useWindowDimensions();
  const [scale, setScale] = useState(DEFAULT_SCALE);
  // 0.3" a side: the 7.58" template badge fits an A4 page (8.27") at true size.
  const [sideMargin, setSideMargin] = useState(0.3);
  const [topMargin, setTopMargin] = useState(0.5);
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState('');

  // Physical dimensions based on current sliders
  const badgeWidthIn = BADGE_W_IN * scale;
  const badgeHeightIn = BADGE_H_IN * scale;
  const pageContentWidthIn = 8.27 - 2 * sideMargin; // A4 is 8.27in wide
  const fits = badgeWidthIn <= pageContentWidthIn;
  // Derived page-edge-to-badge margin (when centered horizontally inside content area)
  const physicalSideMarginIn = sideMargin + (pageContentWidthIn - badgeWidthIn) / 2;

  const previewWidth = Math.min(windowW - 64, 520);
  const firstBadge = badges[0];

  const doExport = async () => {
    if (working) return;
    // Pre-open the print tab synchronously so iOS Safari's popup blocker trusts
    // it (must run in the same tick as the tap, before any await).
    const printWin = openBlankPrintWindow();
    try {
      setWorking(true);
      setProgress('Generating…');
      await primeTemplateDataUri(); // inline the badge template so it prints (not a broken image)
      await primeBadgeOrg();        // organisation name + verification number for the print
      const html = buildBadgeHtmlForExport(badges, { scale, sideMargin, topMargin });
      setProgress('Opening…');
      // PWA/mobile web: a PNG of a PORTRAIT A4 page with the badge(s) at
      // true physical scale on it — same image-file delivery as the bulletins.
      // A content-sized capture was tried (2026-08-19) and rolled back the
      // same day: a lone 7"×2" badge image prints as a landscape full-page
      // blow-up, while the A4-page image keeps 1–2 badges at their real
      // size on a vertical sheet. Desktop web keeps the real print dialog;
      // native keeps PDF → share.
      await exportPdfFromHtml(
        html,
        { dialogTitle: `${badges.length} ${APP_SHORT_NAME} Badge${badges.length > 1 ? 's' : ''}`, filename: 'vertex-badges.pdf' },
        printWin,
      );
      setWorking(false); setProgress('');
      // Native: the share sheet is presented ON TOP of this modal's view
      // controller — unmounting the modal now (onDone → setExportBadges(null))
      // would dismiss the sheet along with it. Leave the modal open; the user
      // closes it with the X after saving/sharing.
      if (Platform.OS === 'web') onDone();
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error('[BadgeExport] failed:', e);
      if (printWin && !printWin.closed) { try { printWin.close(); } catch { /* ignore */ } }
      showAlert('Export failed', e?.message || String(e) || 'Could not export PDF');
    } finally {
      setWorking(false);
      setProgress('');
    }
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} transparent={false}>
      <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: insets.top }}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalHeaderTitle}>Export Options</Text>
          {/* Never disabled: this X is the modal's only exit, and a hung export
              step must not be able to trap the user in a full-screen modal. */}
          <Pressable onPress={onClose}>
            <Ionicons name="close" size={26} color={colors.text} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}>

          <View style={eoStyles.summaryCard}>
            <Text style={eoStyles.summaryHeading}>
              Ready to export {badges.length} badge{badges.length > 1 ? 's' : ''}
            </Text>
            <Text style={eoStyles.summaryRow}>
              Badge size: <Text style={eoStyles.summaryValue}>{badgeWidthIn.toFixed(2)}" × {badgeHeightIn.toFixed(2)}"</Text>
            </Text>
            <Text style={eoStyles.summaryRow}>
              Physical side margin: <Text style={eoStyles.summaryValue}>{physicalSideMarginIn.toFixed(2)}"</Text>  ·  Top: <Text style={eoStyles.summaryValue}>{topMargin.toFixed(2)}"</Text>
            </Text>
            {!fits && (
              <Text style={eoStyles.warnText}>
                ⚠️ Badge is wider than the page area — reduce scale or side margin.
              </Text>
            )}
          </View>

          {/* Live preview at current settings */}
          {firstBadge && (
            <View style={{ alignItems: 'center', marginTop: 8 }}>
              <View
                style={{
                  width: previewWidth,
                  padding: 10,
                  backgroundColor: '#F7FAF1',
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: colors.border,
                }}
              >
                <BadgeCard
                  photoUri={`data:image/png;base64,${firstBadge.photo_base64}`}
                  name={firstBadge.full_name}
                  badgeNumber={firstBadge.badge_number}
                  qrUri={`data:image/png;base64,${firstBadge.qr_base64}`}
                  expiry={firstBadge.expiry_date}
                  photoZoom={firstBadge.photo_zoom ?? 1.18}
                  photoPositionY={firstBadge.photo_position_y ?? 30}
                  width={(previewWidth - 20) * scale}
                />
                <Text style={eoStyles.previewCaption}>
                  Preview (first badge, at {Math.round(scale * 100)}% scale)
                </Text>
              </View>
            </View>
          )}

          {/* Scale slider */}
          <View style={eoStyles.sliderRow}>
            <View style={eoStyles.sliderLabelRow}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name="resize-outline" size={14} color={colors.textMuted} />
                <Text style={eoStyles.sliderLabel}>Badge Scale</Text>
              </View>
              <Text style={eoStyles.sliderValue}>{Math.round(scale * 100)}%</Text>
            </View>
            <FitSlider value={scale} min={0.60} max={1.00} step={0.01} height={40} onChange={setScale} />
            <View style={eoStyles.sliderCaptions}>
              <Text style={eoStyles.sliderCaption}>60%</Text>
              <Text style={eoStyles.sliderCaption}>100% (true size)</Text>
            </View>
          </View>

          {/* Side margin slider */}
          <View style={eoStyles.sliderRow}>
            <View style={eoStyles.sliderLabelRow}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name="swap-horizontal-outline" size={14} color={colors.textMuted} />
                <Text style={eoStyles.sliderLabel}>Side Margin</Text>
              </View>
              <Text style={eoStyles.sliderValue}>{sideMargin.toFixed(2)}"</Text>
            </View>
            <FitSlider value={sideMargin} min={0.25} max={1.50} step={0.05} height={40} onChange={setSideMargin} />
            <View style={eoStyles.sliderCaptions}>
              <Text style={eoStyles.sliderCaption}>0.25"</Text>
              <Text style={eoStyles.sliderCaption}>1.5"</Text>
            </View>
          </View>

          {/* Top margin slider */}
          <View style={eoStyles.sliderRow}>
            <View style={eoStyles.sliderLabelRow}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name="swap-vertical-outline" size={14} color={colors.textMuted} />
                <Text style={eoStyles.sliderLabel}>Top Margin</Text>
              </View>
              <Text style={eoStyles.sliderValue}>{topMargin.toFixed(2)}"</Text>
            </View>
            <FitSlider value={topMargin} min={0.25} max={1.50} step={0.05} height={40} onChange={setTopMargin} />
            <View style={eoStyles.sliderCaptions}>
              <Text style={eoStyles.sliderCaption}>0.25"</Text>
              <Text style={eoStyles.sliderCaption}>1.5"</Text>
            </View>
          </View>

          {/* Quick presets */}
          <View style={eoStyles.presetRow}>
            <Text style={eoStyles.presetLabel}>Presets:</Text>
            <TouchableOpacity
              style={eoStyles.presetBtn}
              onPress={() => { setScale(DEFAULT_SCALE); setSideMargin(0.3); setTopMargin(0.5); }}
            >
              <Text style={eoStyles.presetBtnText}>Default</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={eoStyles.presetBtn}
              onPress={() => { setScale(0.85); setSideMargin(0.75); setTopMargin(0.5); }}
            >
              <Text style={eoStyles.presetBtnText}>Narrow</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={eoStyles.presetBtn}
              onPress={() => { setScale(0.75); setSideMargin(1.0); setTopMargin(0.75); }}
            >
              <Text style={eoStyles.presetBtnText}>Extra narrow</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={[styles.primaryBtn, { marginTop: 24 }, (working || !fits) && { opacity: 0.5 }]}
            onPress={doExport}
            disabled={working || !fits}
          >
            {working ? <ActivityIndicator color={colors.onPrimary} /> : <Ionicons name="print-outline" size={18} color={colors.onPrimary} />}
            <Text style={styles.primaryBtnText}>
              {working ? (progress || 'Working…') : `Generate & Export`}
            </Text>
          </TouchableOpacity>

          <Text style={eoStyles.hint}>
            Tip: when printing the PDF on iPhone, tap Options → set “Scaling” to 100% (Actual Size) so iOS doesn't auto-resize your badges.
          </Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

const createEoStyles = (colors: any) => StyleSheet.create({
  summaryCard: { padding: 14, backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border, marginBottom: 8 },
  summaryHeading: { fontSize: 15, fontWeight: '700', color: colors.text, marginBottom: 6 },
  summaryRow: { fontSize: 13, color: colors.textMuted, marginTop: 3 },
  summaryValue: { color: colors.text, fontWeight: '700', fontVariant: ['tabular-nums'] as any },
  warnText: { marginTop: 8, fontSize: 12, color: '#b91c1c', fontWeight: '600' },
  previewCaption: { fontSize: 10, color: colors.textMuted, marginTop: 8, textAlign: 'center' },
  sliderRow: { marginTop: 18, gap: 4 },
  sliderLabelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sliderLabel: { fontSize: 13, fontWeight: '600', color: colors.text },
  sliderValue: { fontSize: 13, fontWeight: '700', color: colors.primary, fontVariant: ['tabular-nums'] as any },
  sliderCaptions: { flexDirection: 'row', justifyContent: 'space-between' },
  sliderCaption: { fontSize: 9, color: colors.textMuted, letterSpacing: 0.5 },
  presetRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 22, flexWrap: 'wrap' },
  presetLabel: { fontSize: 12, color: colors.textMuted, fontWeight: '600' },
  presetBtn: { paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1, borderColor: colors.border, borderRadius: 999, backgroundColor: colors.surface },
  presetBtnText: { fontSize: 12, fontWeight: '600', color: colors.text },
  hint: { fontSize: 11, color: colors.textMuted, marginTop: 16, fontStyle: 'italic', lineHeight: 16 },
});

// ============================================================================
// Styles
// ============================================================================

const createStyles3 = (colors: any) => StyleSheet.create({
  container: { flex: 1 },
  // The hint below the SectionHead is hidden the moment a badge is ticked, so
  // the block reserves its height (37 SectionHead + 6 marginTop + 18 hint line)
  // — otherwise every remaining checkbox jumps ~24 px up under the finger.
  headBlock: { marginTop: 24, marginBottom: 12, minHeight: 61 },
  createBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  card: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderRadius: 16, marginBottom: 10 },
  cardSelected: { borderColor: colors.primary },
  cardName: { fontSize: 15, fontWeight: '700', color: colors.text },
  cardBadge: { fontSize: 13, color: colors.primary, fontWeight: '600', marginTop: 2 },
  cardMeta: { fontSize: 11, color: colors.textMuted, marginTop: 4 },
  iconBtn: { padding: 6 },
  checkboxHit: { padding: 2, marginRight: 2 },
  checkbox: {
    width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: colors.borderDark,
    backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center',
  },
  // Deep violet face so the gradient rim around it stays legible.
  checkboxChecked: { backgroundColor: colors.primaryDark, borderColor: 'transparent' },
  // Gradient rim on the selected checkbox; the unselected twin keeps the box
  // in exactly the same place (same 2 px ring, transparent).
  checkboxRim: { padding: 2, borderRadius: 9 },
  checkboxRimOff: { padding: 2, borderRadius: 9 },
  hintText: { fontSize: 11, color: colors.textMuted, fontStyle: 'italic' },
  // lineHeight pinned so the reserved 61 px above is exact on native too.
  hintRight: { textAlign: 'right', marginTop: 6, lineHeight: 18 },
  batchBar: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingTop: 12,
    // Sticky chrome stays opaque in BOTH themes (spec §2.5).
    backgroundColor: colors.surface,
    borderTopWidth: 1, borderTopColor: colors.border,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 8, shadowOffset: { width: 0, height: -2 } },
      android: { elevation: 8 },
      // web: same upward shadow as iOS so the bar isn't flat on the PWA.
      default: { shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 8, shadowOffset: { width: 0, height: -2 } },
    }),
  },
  batchBarClear: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 10, paddingHorizontal: 10, borderRadius: 8 },
  batchBarClearText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  batchBarCount: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
  batchBarExport: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.primary, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 10,
  },
  batchBarExportText: { color: colors.onPrimary, fontWeight: '700', fontSize: 14 },
  emptyBox: { alignItems: 'center', padding: 40, gap: 12, borderRadius: 20 },
  emptyText: { color: colors.textMuted, fontSize: 13, textAlign: 'center' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border },
  modalHeaderTitle: { fontSize: 18, fontWeight: '700', color: colors.text },
  label: { fontSize: 13, color: colors.textMuted, marginTop: 12, marginBottom: 6, fontWeight: '600', letterSpacing: 0.3 },
  input: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: colors.text },
  photoBox: { flexDirection: 'row', gap: 14, alignItems: 'center', marginTop: 4 },
  photoPreview: { width: 110, height: 110, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: '#fff' },
  secondaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.primary, paddingVertical: 12, borderRadius: 10 },
  secondaryBtnText: { color: colors.primary, fontWeight: '700', fontSize: 13 },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: colors.primary, paddingVertical: 14, borderRadius: 12 },
  primaryBtnText: { color: colors.onPrimary, fontWeight: '700', fontSize: 15 },
  helpText: { fontSize: 11, color: colors.textMuted, marginTop: 8 },
  previewCaption: { fontSize: 11, color: colors.textMuted, marginTop: 8, textAlign: 'center' },
  fitBox: { marginTop: 20, padding: 14, borderWidth: 1, borderColor: colors.border, borderRadius: 12, backgroundColor: colors.surface, gap: 12 },
  fitHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  fitHeaderText: { fontSize: 11, fontWeight: '700', letterSpacing: 1, color: colors.textMuted },
  fitReset: { fontSize: 12, color: colors.primary, fontWeight: '600', textDecorationLine: 'underline' },
  sliderRow: { gap: 4 },
  sliderLabelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sliderLabel: { fontSize: 12, color: colors.textMuted, fontWeight: '500' },
  sliderValue: { fontSize: 12, fontWeight: '700', color: colors.text, fontVariant: ['tabular-nums'] },
  sliderCaptions: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 },
  sliderCaption: { fontSize: 9, color: colors.textMuted, letterSpacing: 1, fontWeight: '600' },
});

/* __theme_static_fallback__ */
// Fallback static styles (used if a sub-component didn't pick up the
// useColors hook). Always light-mode — won't react to theme changes.
const eoStyles = createEoStyles(lightColors);
const styles = createStyles3(lightColors);
