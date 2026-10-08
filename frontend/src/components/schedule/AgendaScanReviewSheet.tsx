import React, { useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Modal, TouchableOpacity,
  ActivityIndicator, Pressable, Image,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../../theme/colors';
import { lightColors } from '../../theme/ThemeContext';
import { useColors } from '../../theme/ThemeContext';

// ──────────────────────────────────────────────────────────────────────────
// AgendaScanReviewSheet
// Shown after a successful /agenda/scan. Lets the admin review every field
// the AI extracted side-by-side with the current draft, tick the ones they
// want to apply, then hit "Apply selected". Each field is independently
// togglable (per user's "review individual things that override" request).
// ──────────────────────────────────────────────────────────────────────────

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const THEME_FIELDS: { key: string; label: string }[] = [
  { key: 'expectations_1',         label: 'Expectations · Person 1' },
  { key: 'expectations_2',         label: 'Expectations · Person 2' },
  { key: 'leaders',                label: 'Coaches Theme' },
  { key: 'topic_theme',            label: 'Topic Theme' },
  { key: 'customer_service_theme', label: 'Customer Service Theme' },
  { key: 'competition',            label: 'Competition This Week' },
  { key: 'concentration',          label: 'Concentration' },
  { key: 'news',                   label: 'News' },
  { key: 'social',                 label: 'Social' },
];

const STATS_FIELDS: { key: string; label: string }[] = [
  { key: 'weekly_goal',       label: 'Weekly Goal' },
  { key: 'promotions',        label: 'Advancements' },
  { key: 'personal_recruits', label: 'Personal Recruits' },
];

type Cell = { day: number; topic: string; presenter: string };
type ScannedRow = {
  // New (server returns these). `label` is kept for backward compat and
  // equals suggested_label when present, else raw_label.
  raw_label?: string;
  suggested_label?: string | null;
  score?: number;          // 0..100, 0 = no idea
  // Backward-compat
  label: string;
  cells: Cell[];
};

export type ScanPayload = {
  themes: Record<string, string>;
  stats: Record<string, string>;
  rows: ScannedRow[];
  allowed_labels?: string[];
};

export type DraftRow = { id: string; label: string; cells: Cell[] };

export type ApplyResult = {
  themes: Record<string, string>;
  stats: Record<string, string>;
  // Each entry tells the parent: take these scanned cells and apply them
  // to the draft row whose label === rowLabel. If rowLabel is empty, the
  // admin chose to skip this scanned row.
  rowCells: { rowLabel: string; cellsToApply: Record<number, Cell> }[];
  // raw_label → target_label mappings the admin confirmed; empty target
  // means "Skip", which the backend will use to delete a saved mapping.
  mappings: Record<string, string>;
};

export default function AgendaScanReviewSheet({
  visible, scan, draftThemes, draftStats, draftRows, onCancel, onApply, imageUri,
}: {
  visible: boolean;
  scan: ScanPayload | null;
  draftThemes: Record<string, string>;
  draftStats: Record<string, string>;
  draftRows: DraftRow[];
  imageUri?: string | null;
  onCancel: () => void;
  onApply: (r: ApplyResult) => void;
}) {
  // ── Per-scanned-row mapping state ─────────────────────────────────────
  // Each scanned row's `raw_label` (case-preserving) → the target draft-row
  // label the admin wants to apply this content into. Empty string means
  // "Skip this row" (no draft row will be touched).
  const allowedLabels = useMemo<string[]>(() => {
    const fromScan = (scan?.allowed_labels || []) as string[];
    const fromDraft = draftRows.map((d) => d.label);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const l of [...fromScan, ...fromDraft]) {
      const k = (l || '').trim().toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push((l || '').trim());
    }
    return out;
  }, [scan?.allowed_labels, draftRows]);

  const initialMappings = useMemo(() => {
    const m: Record<string, string> = {};
    if (!scan) return m;
    for (const r of scan.rows || []) {
      const raw = (r.raw_label || r.label || '').trim();
      if (!raw) continue;
      // Use server's suggestion if it exists IN allowed (server already
      // ensures this), otherwise fall back to "" (Skip / unmapped).
      const suggested = (r.suggested_label || '').trim();
      if (suggested && allowedLabels.some((l) => l.toLowerCase() === suggested.toLowerCase())) {
        m[raw] = suggested;
      } else {
        m[raw] = '';
      }
    }
    return m;
  }, [scan, allowedLabels]);

  const [rowMappings, setRowMappings] = useState<Record<string, string>>(initialMappings);
  React.useEffect(() => { setRowMappings(initialMappings); }, [initialMappings]);

  const [pickerForRaw, setPickerForRaw] = useState<string | null>(null);

  // selection state — keyed by "themes.<key>", "stats.<key>", "row.<rawLabel>.<dayIdx>"
  const initial = useMemo(() => {
    if (!scan) return {} as Record<string, boolean>;
    const sel: Record<string, boolean> = {};
    for (const f of THEME_FIELDS) {
      const v = (scan.themes?.[f.key] || '').trim();
      // Auto-select scanned values that differ from current draft
      sel[`themes.${f.key}`] = !!v && v !== (draftThemes?.[f.key] || '').trim();
    }
    for (const f of STATS_FIELDS) {
      const v = (scan.stats?.[f.key] || '').trim();
      sel[`stats.${f.key}`] = !!v && v !== (draftStats?.[f.key] || '').trim();
    }
    for (const r of scan.rows || []) {
      const rawLbl = (r.raw_label || r.label || '').trim();
      const target = (initialMappings[rawLbl] || '').trim();
      const draftRow = target ? draftRows.find((dr) => dr.label.toLowerCase() === target.toLowerCase()) : null;
      r.cells.forEach((c) => {
        const cur = draftRow?.cells.find((dc) => dc.day === c.day);
        const has = !!(c.topic || '').trim() || !!(c.presenter || '').trim();
        const same = cur && (cur.topic || '') === (c.topic || '') && (cur.presenter || '') === (c.presenter || '');
        sel[`row.${rawLbl}.${c.day}`] = !!target && has && !same;
      });
    }
    return sel;
  }, [scan, draftThemes, draftStats, draftRows, initialMappings]);

  const [selected, setSelected] = useState<Record<string, boolean>>(initial);
  React.useEffect(() => { setSelected(initial); }, [initial]);

  const toggle = (k: string) => setSelected((p) => ({ ...p, [k]: !p[k] }));

  const counts = useMemo(() => {
    let total = 0, on = 0;
    Object.keys(selected).forEach((k) => {
      // Only count keys that have a scanned value (not blank ones)
      if (k.startsWith('themes.')) {
        const fk = k.split('.')[1];
        if ((scan?.themes?.[fk] || '').trim()) { total++; if (selected[k]) on++; }
      } else if (k.startsWith('stats.')) {
        const fk = k.split('.')[1];
        if ((scan?.stats?.[fk] || '').trim()) { total++; if (selected[k]) on++; }
      } else if (k.startsWith('row.')) {
        const parts = k.split('.');
        const rl = parts[1];
        const di = parts[2];
        const r = scan?.rows.find((rr) => (rr.raw_label || rr.label) === rl);
        const c = r?.cells.find((cc) => cc.day === Number(di));
        if (c && ((c.topic || '').trim() || (c.presenter || '').trim())) {
          total++; if (selected[k]) on++;
        }
      }
    });
    return { total, on };
  }, [selected, scan]);

  const setAll = (val: boolean) => {
    const next: Record<string, boolean> = {};
    Object.keys(selected).forEach((k) => { next[k] = val; });
    setSelected(next);
  };

  const handleApply = () => {
    if (!scan) return;
    const themes: Record<string, string> = {};
    THEME_FIELDS.forEach((f) => {
      if (selected[`themes.${f.key}`]) themes[f.key] = (scan.themes?.[f.key] || '').trim();
    });
    const stats: Record<string, string> = {};
    STATS_FIELDS.forEach((f) => {
      if (selected[`stats.${f.key}`]) stats[f.key] = (scan.stats?.[f.key] || '').trim();
    });
    const rowCells: ApplyResult['rowCells'] = [];
    const mappings: Record<string, string> = {};
    for (const r of scan.rows || []) {
      const rawLbl = (r.raw_label || r.label || '').trim();
      if (!rawLbl) continue;
      const target = (rowMappings[rawLbl] || '').trim();
      // Capture admin's mapping decision for persistence — empty target
      // means "Skip" / forget any saved mapping.
      mappings[rawLbl] = target;
      if (!target) continue;
      const cellsToApply: Record<number, Cell> = {};
      r.cells.forEach((c) => {
        if (selected[`row.${rawLbl}.${c.day}`]) {
          cellsToApply[c.day] = { day: c.day, topic: (c.topic || '').trim(), presenter: (c.presenter || '').trim() };
        }
      });
      if (Object.keys(cellsToApply).length > 0) {
        rowCells.push({ rowLabel: target, cellsToApply });
      }
    }
    onApply({ themes, stats, rowCells, mappings });
  };

  if (!scan) return null;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel}>
      <View style={styles.wrap}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={onCancel} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="close" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Review Scanned Plan</Text>
          <View style={{ width: 24 }} />
        </View>

        {/* Toolbar */}
        <View style={styles.toolbar}>
          <Text style={styles.toolbarText}>
            <Text style={{ fontWeight: '900' }}>{counts.on}</Text>
            <Text> / {counts.total} fields selected</Text>
          </Text>
          <View style={{ flex: 1 }} />
          <TouchableOpacity style={styles.toolBtn} onPress={() => setAll(true)}>
            <Text style={styles.toolBtnText}>All</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.toolBtn} onPress={() => setAll(false)}>
            <Text style={styles.toolBtnText}>None</Text>
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 30 }}>
          {/* Optional thumbnail of the captured photo */}
          {imageUri ? (
            <View style={styles.thumbWrap}>
              <Image source={{ uri: imageUri }} style={styles.thumb} resizeMode="cover" />
            </View>
          ) : null}

          {/* Themes */}
          <SectionTitle icon="bookmark-outline" label="Themes" />
          {THEME_FIELDS.map((f) => {
            const v = (scan.themes?.[f.key] || '').trim();
            const cur = (draftThemes?.[f.key] || '').trim();
            return (
              <ReviewRow
                key={`t-${f.key}`}
                label={f.label}
                current={cur}
                scanned={v}
                checked={!!selected[`themes.${f.key}`]}
                onToggle={() => toggle(`themes.${f.key}`)}
              />
            );
          })}

          {/* Stats */}
          <SectionTitle icon="speedometer-outline" label="Weekly Stats" />
          {STATS_FIELDS.map((f) => {
            const v = (scan.stats?.[f.key] || '').trim();
            const cur = (draftStats?.[f.key] || '').trim();
            return (
              <ReviewRow
                key={`s-${f.key}`}
                label={f.label}
                current={cur}
                scanned={v}
                checked={!!selected[`stats.${f.key}`]}
                onToggle={() => toggle(`stats.${f.key}`)}
              />
            );
          })}

          {/* Rows */}
          <SectionTitle icon="grid-outline" label="Daily Plan" />
          {scan.rows.map((r) => {
            const rawLbl = (r.raw_label || r.label || '').trim();
            const target = (rowMappings[rawLbl] || '').trim();
            const draftRow = target ? draftRows.find((dr) => dr.label.toLowerCase() === target.toLowerCase()) : null;
            const anyHas = r.cells.some((c) => (c.topic || '').trim() || (c.presenter || '').trim());
            if (!anyHas) return null;
            const isUnmapped = !target;
            const score = Number(r.score || 0);
            return (
              <View key={`scan-${rawLbl}`} style={[styles.rowCard, isUnmapped && { borderColor: '#fde68a', borderWidth: 1, backgroundColor: '#fffbeb' }]}>
                {/* Mapping header — raw label, suggestion confidence, picker */}
                <View style={mapStyles.headerRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowCardTitle}>{rawLbl}</Text>
                    {isUnmapped ? (
                      <View style={mapStyles.badgeUnmapped}>
                        <Ionicons name="alert-circle" size={11} color="#92400e" />
                        <Text style={mapStyles.badgeUnmappedText}>Unmapped — pick a target row to import</Text>
                      </View>
                    ) : (
                      <View style={mapStyles.badgeMapped}>
                        <Ionicons name="link" size={11} color="#0f766e" />
                        <Text style={mapStyles.badgeMappedText}>
                          Maps to: <Text style={{ fontWeight: '900' }}>{target}</Text>
                          {score >= 95 ? '  · Saved match' : score >= 90 ? '  · Exact name match' : score >= 60 ? '  · Best guess' : score > 0 ? '  · Loose match' : ''}
                        </Text>
                      </View>
                    )}
                  </View>
                  <TouchableOpacity
                    onPress={() => setPickerForRaw(rawLbl)}
                    style={mapStyles.pickBtn}
                  >
                    <Ionicons name="swap-horizontal" size={13} color={colors.primary} />
                    <Text style={mapStyles.pickBtnText}>Change</Text>
                  </TouchableOpacity>
                </View>
                {r.cells.map((c) => {
                  const has = (c.topic || '').trim() || (c.presenter || '').trim();
                  if (!has) return null;
                  const cur = draftRow?.cells.find((dc) => dc.day === c.day);
                  const curStr = cur ? formatCell(cur) : '';
                  const newStr = formatCell(c);
                  const same = curStr === newStr;
                  return (
                    <ReviewRow
                      key={`${rawLbl}-${c.day}`}
                      label={DAY_LABELS[c.day]}
                      current={curStr}
                      scanned={newStr}
                      checked={!!selected[`row.${rawLbl}.${c.day}`] && !isUnmapped}
                      onToggle={() => isUnmapped ? setPickerForRaw(rawLbl) : toggle(`row.${rawLbl}.${c.day}`)}
                      noChange={same}
                    />
                  );
                })}
              </View>
            );
          })}
        </ScrollView>

        {/* Footer actions */}
        <View style={styles.footer}>
          <TouchableOpacity style={styles.btnGhost} onPress={onCancel}>
            <Text style={styles.btnGhostText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btnPrimary, counts.on === 0 && { opacity: 0.5 }]}
            onPress={handleApply}
            disabled={counts.on === 0}
          >
            <Ionicons name="checkmark-circle" size={16} color={colors.onPrimary} />
            <Text style={styles.btnPrimaryText}>Apply {counts.on} change{counts.on === 1 ? '' : 's'}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Mapping picker modal — pick which Plan/Schedule row this scanned
          row should fill into. Includes a "Skip this row" option and a
          search box for offices with many block titles. */}
      {pickerForRaw && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setPickerForRaw(null)}>
          <Pressable style={mapStyles.pickerBackdrop} onPress={() => setPickerForRaw(null)}>
            <Pressable style={mapStyles.pickerCard} onPress={(e) => e.stopPropagation?.()}>
              <View style={mapStyles.pickerHeader}>
                <Text style={mapStyles.pickerTitle}>Map "{pickerForRaw}" to:</Text>
                <TouchableOpacity onPress={() => setPickerForRaw(null)}>
                  <Ionicons name="close" size={20} color={colors.textMuted} />
                </TouchableOpacity>
              </View>
              <ScrollView style={{ maxHeight: 360 }}>
                <TouchableOpacity
                  style={[mapStyles.pickerOption, !rowMappings[pickerForRaw] && mapStyles.pickerOptionActive]}
                  onPress={() => {
                    setRowMappings((p) => ({ ...p, [pickerForRaw!]: '' }));
                    setPickerForRaw(null);
                  }}
                >
                  <Ionicons name="close-circle-outline" size={16} color={colors.textMuted} />
                  <Text style={mapStyles.pickerOptionText}>Skip — don't import this row</Text>
                </TouchableOpacity>
                {allowedLabels.map((lbl) => {
                  const sel = (rowMappings[pickerForRaw] || '').toLowerCase() === lbl.toLowerCase();
                  return (
                    <TouchableOpacity
                      key={lbl}
                      style={[mapStyles.pickerOption, sel && mapStyles.pickerOptionActive]}
                      onPress={() => {
                        setRowMappings((p) => ({ ...p, [pickerForRaw!]: lbl }));
                        setPickerForRaw(null);
                      }}
                    >
                      <Ionicons name={sel ? 'radio-button-on' : 'radio-button-off'} size={16} color={sel ? colors.primary : colors.textMuted} />
                      <Text style={[mapStyles.pickerOptionText, sel && { fontWeight: '900', color: colors.primary }]}>{lbl}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
              <Text style={mapStyles.pickerHint}>Your choice is remembered for next scan.</Text>
            </Pressable>
          </Pressable>
        </Modal>
      )}
    </Modal>
  );
}

const createMapStyles = (colors: any) => StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 8 },
  badgeUnmapped: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 3, paddingHorizontal: 6, borderRadius: 6, backgroundColor: '#fef3c7', alignSelf: 'flex-start', marginTop: 4 },
  badgeUnmappedText: { fontSize: 10, fontWeight: '700', color: '#92400e' },
  badgeMapped: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 3, paddingHorizontal: 6, borderRadius: 6, backgroundColor: '#ccfbf1', alignSelf: 'flex-start', marginTop: 4 },
  badgeMappedText: { fontSize: 10, fontWeight: '600', color: '#0f766e' },
  pickBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(58, 122, 86,0.3)', backgroundColor: 'rgba(58, 122, 86,0.06)' },
  pickBtnText: { fontSize: 11, fontWeight: '700', color: colors.primary },
  pickerBackdrop: { flex: 1, backgroundColor: 'rgba(5, 15, 11,0.55)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  pickerCard: { width: '100%', maxWidth: 380, backgroundColor: colors.surface, borderRadius: 14, padding: 14, gap: 8, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 24, shadowOffset: { width: 0, height: 8 } },
  pickerHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pickerTitle: { fontSize: 14, fontWeight: '900', color: colors.text, flex: 1 },
  pickerOption: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 8, borderRadius: 8 },
  pickerOptionActive: { backgroundColor: 'rgba(58, 122, 86,0.08)' },
  pickerOptionText: { fontSize: 13, color: colors.text, flex: 1 },
  pickerHint: { fontSize: 11, color: colors.textMuted, fontStyle: 'italic', marginTop: 4, textAlign: 'center' },
});

function formatCell(c: Cell): string {
  const t = (c.topic || '').trim();
  const p = (c.presenter || '').trim();
  if (t && p) return `${p} — ${t}`;
  return p || t || '';
}

function SectionTitle({ icon, label }: { icon: any; label: string }) {
  const colors = useColors();
  const styles = useMemo(() => createStyles2(colors), [colors]);

  return (
    <View style={styles.sectionTitleRow}>
      <Ionicons name={icon} size={14} color={colors.primary} />
      <Text style={styles.sectionTitle}>{label}</Text>
    </View>
  );
}

function ReviewRow({
  label, current, scanned, checked, onToggle, noChange,
}: {
  label: string; current: string; scanned: string;
  checked: boolean; onToggle: () => void; noChange?: boolean;
}) {
  return (
    <Pressable style={[styles.reviewRow, checked && styles.reviewRowChecked]} onPress={onToggle}>
      <View style={[styles.checkbox, checked && styles.checkboxOn]}>
        {checked && <Ionicons name="checkmark" size={14} color={colors.onPrimary} />}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.reviewLabel}>{label}</Text>
        <View style={styles.compareRow}>
          <Text style={styles.compareCurrent} numberOfLines={2}>
            <Text style={styles.compareDim}>was: </Text>
            {current || <Text style={styles.compareDim}>—</Text>}
          </Text>
        </View>
        <View style={styles.compareRow}>
          <Text style={[styles.compareScanned, noChange && { color: colors.textMuted, fontStyle: 'italic' }]} numberOfLines={3}>
            <Text style={[styles.compareDim, { color: colors.primary }]}>scanned: </Text>
            {scanned || <Text style={styles.compareDim}>—</Text>}
            {noChange ? '   (no change)' : ''}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

const createStyles2 = (colors: any) => StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingTop: 50, paddingBottom: 12, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '900', color: colors.text, letterSpacing: 0.3 },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: colors.surfaceAlt, borderBottomWidth: 1, borderBottomColor: colors.border },
  toolbarText: { fontSize: 12, color: colors.text, fontWeight: '700' },
  toolBtn: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 7, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  toolBtnText: { fontSize: 11, fontWeight: '800', color: colors.text, letterSpacing: 0.3 },

  thumbWrap: { borderRadius: 12, overflow: 'hidden', marginBottom: 12, backgroundColor: '#000' },
  thumb: { width: '100%', height: 160 },

  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 14, marginBottom: 6 },
  sectionTitle: { fontSize: 12, fontWeight: '900', color: colors.text, letterSpacing: 0.6, textTransform: 'uppercase' },

  rowCard: { backgroundColor: colors.surface, borderRadius: 10, borderWidth: 1, borderColor: colors.border, padding: 8, marginBottom: 8 },
  rowCardTitle: { fontSize: 12, fontWeight: '900', color: colors.primary, letterSpacing: 0.4, textTransform: 'uppercase', marginBottom: 4, paddingHorizontal: 4 },

  reviewRow: { flexDirection: 'row', gap: 10, paddingHorizontal: 10, paddingVertical: 8, marginBottom: 4, borderRadius: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  reviewRowChecked: { backgroundColor: 'rgba(58, 122, 86, 0.06)', borderColor: colors.primary },
  checkbox: { width: 22, height: 22, borderRadius: 5, borderWidth: 2, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  checkboxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  reviewLabel: { fontSize: 11, fontWeight: '800', color: colors.text, letterSpacing: 0.3, marginBottom: 3 },
  compareRow: { marginBottom: 1 },
  compareCurrent: { fontSize: 12, color: colors.textMuted, lineHeight: 16 },
  compareScanned: { fontSize: 12, color: colors.text, lineHeight: 16, fontWeight: '600' },
  compareDim: { fontSize: 10, color: colors.textMuted, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3 },

  footer: { flexDirection: 'row', gap: 8, padding: 12, paddingBottom: 24, backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border },
  btnGhost: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center', backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
  btnGhostText: { color: colors.text, fontWeight: '800', fontSize: 13 },
  btnPrimary: { flex: 2, flexDirection: 'row', gap: 6, paddingVertical: 12, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary },
  btnPrimaryText: { color: colors.onPrimary, fontWeight: '900', fontSize: 13, letterSpacing: 0.3 },
});

// Loading spinner export — used by the parent while the scan is running
export function ScanInFlightOverlay({ visible }: { visible: boolean }) {
  const colors = useColors();
  const overlayStyles = useMemo(() => createOverlayStyles(colors), [colors]);

  if (!visible) return null;
  return (
    <View style={overlayStyles.wrap} pointerEvents="auto">
      <View style={overlayStyles.box}>
        <ActivityIndicator color={colors.primary} size="large" />
        <Text style={overlayStyles.title}>Reading your plan…</Text>
        <Text style={overlayStyles.sub}>This usually takes 10–30 seconds.</Text>
      </View>
    </View>
  );
}

const createOverlayStyles = (colors: any) => StyleSheet.create({
  wrap: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', zIndex: 50 },
  box: { backgroundColor: colors.surface, padding: 22, borderRadius: 14, alignItems: 'center', minWidth: 220, gap: 8 },
  title: { fontSize: 14, fontWeight: '900', color: colors.text },
  sub: { fontSize: 11, color: colors.textMuted, fontWeight: '600' },
});

/* __theme_static_fallback__ */
// Fallback static styles (used if a sub-component didn't pick up the
// useColors hook). Always light-mode — won't react to theme changes.
const mapStyles = createMapStyles(lightColors);
const overlayStyles = createOverlayStyles(lightColors);
const styles = createStyles2(lightColors);
