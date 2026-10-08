/**
 * QuickLogSheet — floating quick-log sheet for the Bells screen.
 *
 * Flow:
 *   1. Pick a rep (default = you, or first leader/admin in the list)
 *   2. Pick a day (default = today)
 *   3. Tap +1 on £15+ / £12 to increment that day's count
 *   4. Tap Save — fires upsertBell with the new totals
 *
 * Designed for one-handed use — thumb stays on the bottom half.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, ScrollView, Platform,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { apiService } from '../../api/client';
import { useColors, lightColors } from '../../theme/ThemeContext';
import { haptics } from '../../utils/haptics';
import { toast } from '../../utils/toast';
import { useBellsEditLock } from './BellsEditLockContext';
import { TIER, appDayIdx, signUps } from './types';
import { useDeviceInsets } from '../../nav/AppShell';

type Entry = {
  user_id?: string;
  user_name: string;
  days?: Array<{ over30: number | null; under30: number | null; memberships: number | null; status: string }>;
  weekly_goal?: number | null;
};

type Props = {
  visible: boolean;
  weekEnding: string;
  entries: Entry[];
  onClose: () => void;
  onSaved: () => void;
};

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function todayDayIdx(): number {
  // 0=Mon..6=Sun, in app (UK) time
  return appDayIdx();
}

export default function QuickLogSheet({ visible, weekEnding, entries, onClose, onSaved }: Props) {
  const insets = useDeviceInsets();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const editLock = useBellsEditLock();

  const [selectedKey, setSelectedKey] = useState<string>('');
  const [dayIdx, setDayIdx] = useState<number>(todayDayIdx());
  const [delta, setDelta] = useState<{ over30: number; under30: number }>({ over30: 0, under30: 0 });
  const [saving, setSaving] = useState(false);

  // Default-select first entry on open
  useEffect(() => {
    if (visible && entries.length > 0 && !selectedKey) {
      const first = entries[0];
      setSelectedKey(first.user_id || `name:${first.user_name}`);
    }
    if (!visible) {
      setDelta({ over30: 0, under30: 0 });
      setDayIdx(todayDayIdx());
      setSelectedKey('');
    }
  }, [visible, entries, selectedKey]);

  const selectedEntry = useMemo(() => entries.find((e) => (e.user_id || `name:${e.user_name}`) === selectedKey), [entries, selectedKey]);
  const baseDay = selectedEntry?.days?.[dayIdx] || { over30: null, under30: null, memberships: null, status: 'off' };

  const projected = {
    over30: (baseDay.over30 || 0) + delta.over30,
    under30: (baseDay.under30 || 0) + delta.under30,
  };
  // Sign-ups are £15+ (over30) + £12 (under30).
  const totalAdded = delta.over30 + delta.under30;

  const bump = (k: 'over30' | 'under30', step: 1 | -1) => {
    haptics.light();
    setDelta((d) => ({ ...d, [k]: Math.max(0, d[k] + step) }));
  };

  const handleSave = async () => {
    if (!selectedEntry || totalAdded === 0) {
      toast.info('Nothing to save', `Tap +1 on ${TIER.over30.short} or ${TIER.under30.short} first.`);
      return;
    }
    const ok = await editLock.requireEditAccess();
    if (!ok) return;
    try {
      setSaving(true);
      // Build full days payload (preserve other days untouched)
      const days = Array.from({ length: 7 }, (_, i) => {
        const cur = selectedEntry.days?.[i] || { over30: null, under30: null, memberships: null, status: 'off' };
        if (i !== dayIdx) return cur;
        return {
          over30: projected.over30 || null,
          under30: projected.under30 || null,
          // Not used by Vertex — pass the day's existing value straight through.
          memberships: cur.memberships ?? null,
          status: 'in',
        };
      });
      await apiService.upsertBell({
        user_id: selectedEntry.user_id || null,
        user_name: selectedEntry.user_name,
        week_ending: weekEnding,
        days,
      });
      toast.success(`+${totalAdded} for ${selectedEntry.user_name}`, `${DAY_LABELS[dayIdx]} updated.`);
      onSaved();
      onClose();
    } catch (e: any) {
      toast.error('Save failed', e?.response?.data?.detail || e?.message || 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.container, { paddingTop: Platform.OS === 'ios' ? 0 : insets.top }]}>
        <View style={styles.header}>
          <View style={styles.headerIcon}>
            <Ionicons name="flash" size={18} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Quick Log</Text>
            <Text style={styles.subtitle}>Tap +1 to bump a count. No need to expand the row.</Text>
          </View>
          <TouchableOpacity onPress={onClose} style={styles.headerBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close" size={22} color={colors.text} />
          </TouchableOpacity>
        </View>

        {/* Rep picker (horizontal scroll) */}
        <View style={styles.repsRowWrap}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.repsRow} bounces={false}>
            {entries.map((e) => {
              const k = e.user_id || `name:${e.user_name}`;
              const sel = k === selectedKey;
              return (
                <TouchableOpacity
                  key={k}
                  style={[styles.repChip, sel && styles.repChipActive]}
                  onPress={() => { haptics.tap(); setSelectedKey(k); }}
                >
                  <Text style={[styles.repChipText, sel && styles.repChipTextActive]} numberOfLines={1}>
                    {e.user_name}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>

        {/* Day picker */}
        <View style={styles.daysRow}>
          {DAY_LABELS.map((d, i) => {
            const sel = i === dayIdx;
            return (
              <TouchableOpacity
                key={d}
                style={[styles.dayChip, sel && styles.dayChipActive]}
                onPress={() => { haptics.tap(); setDayIdx(i); setDelta({ over30: 0, under30: 0 }); }}
              >
                <Text style={[styles.dayChipText, sel && styles.dayChipTextActive]}>{d}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Tally cards */}
        <View style={styles.tallyGrid}>
          <Tally
            tag={TIER.over30.short} label="Target/Premium" primary
            dayName={DAY_LABELS[dayIdx]}
            base={baseDay.over30 || 0}
            delta={delta.over30}
            onPlus={() => bump('over30', 1)}
            onMinus={() => bump('over30', -1)}
            colors={colors}
            styles={styles}
          />
          <Tally
            tag={TIER.under30.short} label="Standard"
            dayName={DAY_LABELS[dayIdx]}
            base={baseDay.under30 || 0}
            delta={delta.under30}
            onPlus={() => bump('under30', 1)}
            onMinus={() => bump('under30', -1)}
            colors={colors}
            styles={styles}
          />
        </View>

        {/* Save row pinned at the bottom */}
        <View style={[styles.saveRow, { paddingBottom: Math.max(insets.bottom, 8) + 8 }]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.summaryLine}>
              {selectedEntry ? selectedEntry.user_name : 'Pick a rep'} · {DAY_LABELS[dayIdx]}
            </Text>
            <Text style={styles.summarySub}>
              {totalAdded > 0 ? `+${signUps(totalAdded)} → new total ${projected.over30 + projected.under30}` : 'No changes yet'}
            </Text>
          </View>
          <TouchableOpacity
            style={[styles.saveBtn, (saving || totalAdded === 0) && { opacity: 0.4 }]}
            disabled={saving || totalAdded === 0}
            onPress={handleSave}
          >
            {saving ? <ActivityIndicator color={colors.onPrimary} /> : (
              <>
                <Ionicons name="checkmark" size={16} color={colors.onPrimary} />
                <Text style={styles.saveBtnText}>Save</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ── Tally card ──────────────────────────────────────────────────────────
function Tally({ tag, label, primary, dayName, base, delta, onPlus, onMinus, colors, styles }: any) {
  const total = base + delta;
  return (
    <View style={styles.tallyCard}>
      <View style={styles.tallyHeader}>
        {/* Tier chip — £15+ on the brand colour, £12 on the quiet surface. */}
        <View style={[styles.tallyTag, primary ? { backgroundColor: colors.primary, borderColor: colors.primary } : null]}>
          <Text style={[styles.tallyTagText, primary ? { color: colors.onPrimary } : null]}>{tag}</Text>
        </View>
        <Text style={styles.tallyLabel}>{label}</Text>
      </View>
      <Text style={styles.tallyValue}>{total}</Text>
      {delta > 0 ? <Text style={styles.tallyDelta}>+{delta}</Text> : <Text style={styles.tallyDeltaPlaceholder}> </Text>}
      <View style={styles.tallyButtons}>
        <TouchableOpacity style={styles.tallyMinus} onPress={onMinus} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityLabel={`${dayName} ${tag} sign-ups minus one`}>
          <Ionicons name="remove" size={18} color={colors.text} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.tallyPlus} onPress={onPlus} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityLabel={`${dayName} ${tag} sign-ups plus one`}>
          <Ionicons name="add" size={22} color={colors.onPrimary} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface },
  headerIcon: { width: 36, height: 36, borderRadius: 12, backgroundColor: `${colors.primary}1A`, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.primary },
  headerBtn: { padding: 6 },
  title: { fontSize: 17, fontWeight: '900', color: colors.text },
  subtitle: { fontSize: 11, color: colors.textMuted, marginTop: 2 },

  repsRowWrap: { maxHeight: 56 },
  repsRow: { paddingHorizontal: 12, paddingVertical: 10, gap: 6, alignItems: 'center' },
  repChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: colors.borderDark, backgroundColor: colors.surface, marginRight: 6, justifyContent: 'center' },
  repChipActive: { borderColor: colors.primary, backgroundColor: `${colors.primary}1A` },
  repChipText: { fontSize: 13, color: colors.text, fontWeight: '700', maxWidth: 140 },
  repChipTextActive: { color: colors.primary },

  daysRow: { flexDirection: 'row', gap: 4, paddingHorizontal: 12, paddingBottom: 8 },
  dayChip: { flex: 1, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: colors.borderDark, backgroundColor: colors.surface, alignItems: 'center' },
  dayChipActive: { borderColor: colors.primary, backgroundColor: colors.primary },
  dayChipText: { fontSize: 11, fontWeight: '800', color: colors.textMuted, letterSpacing: 0.4 },
  dayChipTextActive: { color: colors.onPrimary },

  tallyGrid: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingTop: 8 },
  tallyCard: { flex: 1, backgroundColor: colors.surface, borderRadius: 14, borderWidth: 1.5, borderColor: colors.borderDark, paddingVertical: 14, paddingHorizontal: 8, alignItems: 'center', gap: 4 },
  tallyHeader: { alignItems: 'center', gap: 0, marginBottom: 2 },
  tallyEmoji: { fontSize: 28 },
  tallyTag: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceAlt, marginBottom: 4 },
  tallyTagText: { fontSize: 15, fontWeight: '900', color: colors.text, fontVariant: ['tabular-nums'] as any },
  tallyLabel: { fontSize: 10, fontWeight: '800', color: colors.textMuted, letterSpacing: 0.4 },
  tallyValue: { fontSize: 32, fontWeight: '900', color: colors.text, fontVariant: ['tabular-nums'] as any, lineHeight: 36 },
  tallyDelta: { fontSize: 11, fontWeight: '900', color: colors.primary, height: 14 },
  tallyDeltaPlaceholder: { fontSize: 11, height: 14, opacity: 0 },
  tallyButtons: { flexDirection: 'row', gap: 6, marginTop: 6 },
  tallyMinus: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: colors.borderDark, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  tallyPlus: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary, shadowColor: colors.primary, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.35, shadowRadius: 5, elevation: 4 },

  saveRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface },
  summaryLine: { fontSize: 14, fontWeight: '800', color: colors.text },
  summarySub: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  saveBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 18, paddingVertical: 12, borderRadius: 999, backgroundColor: colors.primary, minWidth: 100 },
  saveBtnText: { color: colors.onPrimary, fontWeight: '900', fontSize: 14, letterSpacing: 0.3 },
});

void lightColors;
