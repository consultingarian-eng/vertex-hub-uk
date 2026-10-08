import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { showAlert } from '../../utils/showAlert';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, ActivityIndicator, Platform, KeyboardAvoidingView, Modal, Pressable,  } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../../theme/colors';
import { lightColors } from '../../theme/ThemeContext';
import { useColors } from '../../theme/ThemeContext';
import { apiService } from '../../api/client';
import { Day, Entry, DAY_LONG, emptyDay, isInDay, MIN_AB_REASON, TIER, signUps } from './types';
import { useBellsEditLock } from './BellsEditLockContext';
import { useAuth } from '../../auth/AuthContext';
import { centerNotice } from '../../utils/centerNotice';
import { useDeviceInsets } from '../../nav/AppShell';

// Tap a day in the office strip → opens this modal.
// Supports read-only summary (default) and inline Edit mode for fast per-day entry.
export default function DayBreakdownModal({ dayIdx, entries, weekEnding, onClose, onUpdated }: {
  dayIdx: number; entries: Entry[]; weekEnding: string; onClose: () => void; onUpdated: () => void;
}) {
  const insets = useDeviceInsets();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [editMode, setEditMode] = useState(false);
  const editLock = useBellsEditLock();
  const { user } = useAuth();
  const isAdminUser = user?.role === 'admin';

  // AB request sheet (non-admins). Absences are the office owner's call, so
  // tapping AB here fires a REQUEST rather than writing AB to the sheet — the
  // server reverts any direct AB write from a non-admin, which used to make
  // the day silently snap back to Off.
  const [abReq, setAbReq] = useState<{ entry: Entry } | null>(null);
  const [abReason, setAbReason] = useState('');
  const [abSending, setAbSending] = useState(false);
  const abReasonOk = abReason.trim().length >= MIN_AB_REASON;

  const sendAbRequest = async () => {
    if (!abReq?.entry.user_id || !abReasonOk) return;
    setAbSending(true);
    try {
      await apiService.createAbsenceRequest({
        target_user_id: abReq.entry.user_id,
        week_ending: weekEnding,
        day_indices: [dayIdx],
        reason: abReason.trim(),
      });
      setAbReq(null);
      centerNotice.success('Absence requested', 'The office owner has been notified and will approve or deny it.');
    } catch (e: any) {
      showAlert('Could not request', e?.response?.data?.detail || 'Try again');
    } finally {
      setAbSending(false);
    }
  };

  type LocalPerson = {
    key: string;
    entry: Entry;
    dayValue: Day;
    otherDays: Day[];
    saveState: false | 'pending' | 'saved' | 'error';
  };

  const [local, setLocal] = useState<LocalPerson[]>(() =>
    entries.map((e) => {
      const allDays: Day[] = e.days && e.days.length === 7 ? e.days.map((d) => ({ ...d })) : Array.from({ length: 7 }, emptyDay);
      const dayValue: Day = { ...(allDays[dayIdx] || emptyDay()) };
      return {
        key: e.user_id || `name:${e.user_name}`,
        entry: e,
        dayValue,
        otherDays: allDays,
        saveState: false as const,
      };
    })
  );

  useEffect(() => {
    setLocal((prev) =>
      entries.map((e) => {
        const key = e.user_id || `name:${e.user_name}`;
        const existing = prev.find((p) => p.key === key);
        const serverDays: Day[] = e.days && e.days.length === 7 ? e.days.map((d) => ({ ...d })) : Array.from({ length: 7 }, emptyDay);
        const dayValue: Day = existing && existing.saveState === 'pending' ? existing.dayValue : { ...(serverDays[dayIdx] || emptyDay()) };
        return {
          key,
          entry: e,
          dayValue,
          otherDays: serverDays,
          saveState: existing?.saveState ?? false,
        };
      })
    );
  }, [entries, dayIdx]);

  const localRef = useRef<LocalPerson[]>(local);
  useEffect(() => { localRef.current = local; }, [local]);

  const saveTimers = useRef<Record<string, any>>({});

  const handleClearDay = () => {
    showAlert(
      'Clear sign-ups?',
      `This will reset everyone to Off and clear all sign-ups for ${DAY_LONG[dayIdx]}. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear sign-ups', style: 'destructive', onPress: async () => {
            try {
              await apiService.clearBellsDay(weekEnding, dayIdx);
              onUpdated();
              setEditMode(false);
            } catch {
              showAlert('Error', 'Failed to clear sign-ups. Please try again.', [{ text: 'OK' }]);
            }
          },
        },
      ],
      { cancelable: true },
    );
  };

  const scheduleSave = useCallback((key: string) => {
    if (saveTimers.current[key]) clearTimeout(saveTimers.current[key]);
    setLocal((prev) => prev.map((p) => (p.key === key ? { ...p, saveState: 'pending' } : p)));
    saveTimers.current[key] = setTimeout(async () => {
      const person = localRef.current.find((p) => p.key === key);
      if (!person) return;
      const fullDays: Day[] = person.otherDays.map((d, i) => (i === dayIdx ? person.dayValue : d));
      try {
        await apiService.upsertBell({
          week_ending: weekEnding,
          user_name: person.entry.user_name,
          user_id: person.entry.user_id,
          office_id: person.entry.office_id,
          stage: null,
          break_even: person.entry.break_even,
          weekly_goal: person.entry.weekly_goal,
          days: fullDays,
        });
        setLocal((prev) => prev.map((p) => (p.key === key ? { ...p, saveState: 'saved' } : p)));
        onUpdated();
        setTimeout(() => {
          setLocal((prev) => prev.map((p) => (p.key === key && p.saveState === 'saved' ? { ...p, saveState: false } : p)));
        }, 1500);
      } catch {
        setLocal((prev) => prev.map((p) => (p.key === key ? { ...p, saveState: 'error' } : p)));
        setTimeout(() => {
          setLocal((prev) => prev.map((p) => (p.key === key && p.saveState === 'error' ? { ...p, saveState: false } : p)));
        }, 2500);
      }
    }, 600);
  }, [weekEnding, dayIdx, onUpdated]);

  const updateField = (key: string, field: keyof Day, raw: string | number) => {
    // Before silently nuking numbers when flipping to Off/NC/AB, confirm with
    // the user. Only prompt when there's actually data to lose. For every
    // other change we stay instant so typing-then-tabbing feels responsive.
    if (field === 'status') {
      const target = local.find((p) => p.key === key);
      // ── Absences are the office owner's call ──────────────────────────
      // Non-admins never write AB straight to the sheet — the server reverts
      // it. Route them to an absence REQUEST instead, and block edits to a
      // day the owner has already approved as AB.
      if (!isAdminUser && target) {
        const curStatus = target.dayValue?.status;
        if (raw === 'ab' && curStatus !== 'ab') {
          if (!target.entry.user_id || dayIdx > 5) {
            showAlert('Not available', 'Absence requests cover Mon–Sat for linked users.');
            return;
          }
          setAbReason('');
          setAbReq({ entry: target.entry });
          return;
        }
        if (curStatus === 'ab') {
          showAlert('Approved absence', 'Only the office owner can change an approved AB day.');
          return;
        }
      }
      const willClear = raw === 'off' || raw === 'nc' || raw === 'ab';
      const d = target?.dayValue;
      const hasData = !!d && (
        (d.over30 != null && d.over30 > 0) ||
        (d.under30 != null && d.under30 > 0)
      );
      if (willClear && hasData && d) {
        const label = raw === 'off' ? 'Off' : raw === 'nc' ? 'NC' : 'AB';
        const total = (d.over30 || 0) + (d.under30 || 0);
        showAlert(
          `Mark as ${label}?`,
          `This day has ${signUps(total)} logged (${TIER.over30.short}, ${TIER.under30.short}). ` +
          `Marking it ${label} will clear them. Are you sure?`,
          [
            { text: 'Cancel', style: 'cancel' },
            { text: `Yes, mark ${label}`, style: 'destructive', onPress: () => applyFieldUpdate(key, field, raw) },
          ],
          { cancelable: true },
        );
        return;
      }
    }
    applyFieldUpdate(key, field, raw);
  };

  // Split out the actual mutation so both the straight-through and the
  // "after confirm" paths can share it verbatim.
  const applyFieldUpdate = (key: string, field: keyof Day, raw: string | number) => {
    setLocal((prev) => prev.map((p) => {
      if (p.key !== key) return p;
      const next: Day = { ...p.dayValue };
      if (field === 'status') {
        next.status = String(raw);
        if (next.status === 'off' || next.status === 'nc' || next.status === 'ab') {
          next.over30 = null; next.under30 = null; next.memberships = null;
        }
      } else {
        const n = typeof raw === 'number' ? raw : (raw === '' ? null : Math.max(0, parseInt(String(raw)) || 0));
        (next as any)[field] = n;
        if (next.status === 'off' && ((n || 0) > 0)) {
          next.status = 'in';
        }
      }
      return { ...p, dayValue: next };
    }));
    scheduleSave(key);
  };

  const dayTotals = useMemo(() => {
    const rows = local.map((p) => {
      const d = p.dayValue;
      const tot = isInDay(d) ? ((d.over30 || 0) + (d.under30 || 0)) : 0;
      return { ...p, tot };
    });
    const inDays = rows.filter((r) => isInDay(r.dayValue));
    const withSale = inDays.filter((r) => r.tot > 0);
    const totalSales = inDays.reduce((s, r) => s + r.tot, 0);
    const totalOver30 = inDays.reduce((s, r) => s + (r.dayValue.over30 || 0), 0);
    const totalUnder30 = inDays.reduce((s, r) => s + (r.dayValue.under30 || 0), 0);
    const dailyAvg = inDays.length > 0 ? totalSales / inDays.length : 0;
    // P/A — pitches per appointment? Or sales per attendant? Standard for
    // field sales: P/A = sales per person working (i.e. dailyAvg). We
    // expose it as a separate label since leaders track it that way.
    const pa = dailyAvg;
    const scoringPct = inDays.length > 0 ? Math.round((withSale.length / inDays.length) * 100) : 0;
    // % of the day's sign-ups that were £15+ (Target/Premium)
    const goldPct = totalSales > 0 ? Math.round((totalOver30 / totalSales) * 100) : 0;
    return {
      rows,
      working: inDays.length,
      totalSales,
      totalOver30,
      totalUnder30,
      dailyAvg,
      pa,
      scoringPct,
      goldPct,
    };
  }, [local]);

  const sortedRows = useMemo(() => {
    const rows = [...dayTotals.rows];
    if (editMode) {
      rows.sort((a, b) => a.entry.user_name.localeCompare(b.entry.user_name));
    } else {
      rows.sort((a, b) => (b.tot - a.tot) || (a.entry.user_name.localeCompare(b.entry.user_name)));
    }
    return rows;
  }, [dayTotals.rows, editMode]);

  return (
    <Modal
      visible
      animationType="slide"
      onRequestClose={onClose}
      // Force a true full-screen presentation on iOS so the modal can never
      // render as a small floating sheet/popover (iPad split-view, landscape
      // iPhone Pro Max, etc. were sometimes showing it pinned to the top-
      // left behind the day strip).
      presentationStyle="fullScreen"
      transparent={false}
      hardwareAccelerated
      statusBarTranslucent={false}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1, width: '100%', backgroundColor: colors.background, paddingTop: insets.top }}
      >
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>{DAY_LONG[dayIdx]}</Text>
            <Text style={styles.subtitle}>Office totals · {signUps(dayTotals.totalSales)} · {dayTotals.working} working</Text>
          </View>
          {editMode && (
            <TouchableOpacity onPress={handleClearDay} style={styles.clearBtn}>
              <Ionicons name="trash-outline" size={16} color="#b91c1c" />
              <Text style={styles.clearBtnText}>Clear</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            onPress={async () => {
              if (editMode) { setEditMode(false); return; }
              const ok = await editLock.requireEditAccess();
              if (ok) setEditMode(true);
            }}
            style={[styles.editBtn, editMode && styles.editBtnActive]}
          >
            <Ionicons name={editMode ? 'checkmark' : (editLock.unlocked || editLock.isAdmin ? 'create-outline' : 'lock-closed')} size={16} color={editMode ? colors.onPrimary : colors.primary} />
            <Text style={[styles.editBtnText, editMode && { color: colors.onPrimary }]}>
              {editMode ? 'Done' : 'Edit'}
            </Text>
          </TouchableOpacity>
          <Pressable onPress={onClose} style={{ marginLeft: 10 }}><Ionicons name="close" size={26} color={colors.text} /></Pressable>
        </View>

        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 12, paddingBottom: insets.bottom + 40 }}
        >
          {/* Office-wide stat cards for THIS day */}
          <View style={styles.statRow}>
            <View style={styles.statCard}>
              <Text style={styles.statLabel}>Sign-ups</Text>
              <Text style={[styles.statValue, { color: colors.primary }]}>{dayTotals.totalSales}</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statLabel}>P/A</Text>
              <Text style={styles.statValue}>{dayTotals.pa.toFixed(1)}</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statLabel}>Scoring</Text>
              <Text style={[styles.statValue, { color: dayTotals.scoringPct >= 70 ? '#059669' : dayTotals.scoringPct >= 50 ? '#d97706' : '#b91c1c' }]}>
                {dayTotals.scoringPct}%
              </Text>
            </View>
          </View>
          <View style={[styles.statRow, { marginTop: 8 }]}>
            <View style={styles.statCard}>
              <Text style={styles.statLabel}>{TIER.over30.short}</Text>
              <Text style={[styles.statValue, { color: colors.primary }]}>{dayTotals.totalOver30}</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statLabel}>{TIER.under30.short}</Text>
              <Text style={[styles.statValue, { color: colors.textSecondary }]}>{dayTotals.totalUnder30}</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statLabel}>{`${TIER.over30.short} %`}</Text>
              <Text style={[styles.statValue, { color: dayTotals.goldPct >= 60 ? colors.primary : colors.text }]}>{dayTotals.goldPct}%</Text>
            </View>
          </View>
          <Text style={styles.hint}>
            {editMode
              ? `Fill in everyone's ${DAY_LONG[dayIdx]} numbers here. Saves automatically.`
              : 'Scoring % = people with ≥1 sign-up ÷ people working that day'}
          </Text>

          {/* Per-person list */}
          {sortedRows.map((r) => (
            editMode ? (
              <EditablePersonDayRow
                key={r.key}
                name={r.entry.user_name}
                role={r.entry.role}
                dayName={DAY_LONG[dayIdx]}
                day={r.dayValue}
                saveState={r.saveState}
                onChange={(field, val) => updateField(r.key, field, val)}
              />
            ) : (
              <ReadOnlyPersonDayRow key={r.key} name={r.entry.user_name} day={r.dayValue} total={r.tot} />
            )
          ))}
        </ScrollView>

        {/* AB request sheet — non-admins: reason + send to the office owner */}
        <Modal visible={abReq !== null} transparent animationType="fade" onRequestClose={() => setAbReq(null)}>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.abBackdrop}>
            <Pressable style={StyleSheet.absoluteFill} onPress={() => setAbReq(null)} />
            <View style={styles.abCard}>
              <Text style={styles.abTitle}>
                Request AB — {abReq?.entry.user_name} · {DAY_LONG[dayIdx]}
              </Text>
              <Text style={styles.abSub}>
                They'll show as "absence requested" until the office owner approves. The owner is notified now.
              </Text>
              <Text style={styles.abLabel}>Reason — required, the owner sees this</Text>
              <TextInput
                value={abReason}
                onChangeText={setAbReason}
                style={styles.abInput}
                placeholder="e.g. Doctor's appointment"
                placeholderTextColor={colors.textMuted}
                multiline
                autoFocus
              />
              {!abReasonOk && (
                <Text style={styles.abHint}>Add a reason before sending — the owner needs it to decide.</Text>
              )}
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                <TouchableOpacity style={styles.abGhostBtn} onPress={() => setAbReq(null)} disabled={abSending}>
                  <Text style={styles.abGhostText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.abSendBtn, (abSending || !abReasonOk) && { opacity: 0.5 }]}
                  onPress={sendAbRequest}
                  disabled={abSending || !abReasonOk}
                >
                  <Text style={styles.abSendText}>{abSending ? 'Sending…' : 'Send request'}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function ReadOnlyPersonDayRow({ name, day, total }: { name: string; day: Day; total: number }) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const inStatus = isInDay(day);
  const badgeColor = day.status === 'off' ? colors.textMuted : day.status === 'ab' ? '#dc2626' : day.status === 'nc' ? '#6b7280' : day.status === 'rt' ? '#d97706' : inStatus && total > 0 ? colors.primary : colors.textMuted;
  const badgeText = day.status === 'off' ? 'Off' : day.status === 'ab' ? 'AB' : day.status === 'nc' ? 'NC' : day.status === 'rt' ? 'RT' : `${total}`;
  return (
    <View style={styles.personRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.personName}>{name}</Text>
        <Text style={styles.personMeta}>
          {day.status === 'off' ? 'Day off' :
            day.status === 'ab' ? 'Absent' :
            day.status === 'nc' ? 'Not counted' :
            day.status === 'rt' ? `Retrain${(day.over30 || 0) + (day.under30 || 0) > 0 ? ` · ${signUps((day.over30 || 0) + (day.under30 || 0))} (not scored)` : ''}` :
            `${TIER.over30.short}: ${day.over30 ?? 0} · ${TIER.under30.short}: ${day.under30 ?? 0}`
          }
        </Text>
      </View>
      <View style={[styles.personBadge, { backgroundColor: badgeColor }]}>
        <Text style={[styles.personBadgeText, badgeColor === colors.primary && { color: colors.onPrimary }]}>{badgeText}</Text>
      </View>
    </View>
  );
}

function EditablePersonDayRow({ name, role, dayName, day, saveState, onChange }: {
  name: string;
  role?: string;
  dayName: string;
  day: Day;
  saveState: false | 'pending' | 'saved' | 'error';
  onChange: (field: keyof Day, val: string | number) => void;
}) {
  const inStatus = isInDay(day);
  const off = day.status === 'off';
  const nc = day.status === 'nc';
  const rt = day.status === 'rt';
  const ab = day.status === 'ab';
  const total = inStatus ? ((day.over30 || 0) + (day.under30 || 0)) : 0;
  const inputsDisabled = off || nc;
  const roleLabel = role === 'trainee' ? 'BA' : role === 'leader' ? 'C' : '';

  return (
    <View style={styles.editRow}>
      <View style={styles.editRowHeader}>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={styles.editRowName} numberOfLines={1}>{name}</Text>
          {roleLabel ? <View style={styles.editRowRoleTag}><Text style={styles.editRowRoleTagText}>{roleLabel}</Text></View> : null}
          {saveState === 'pending' && <ActivityIndicator size="small" color={colors.textMuted} />}
          {saveState === 'saved' && <Ionicons name="checkmark-circle" size={14} color={colors.primary} />}
          {saveState === 'error' && <Ionicons name="alert-circle" size={14} color="#b91c1c" />}
        </View>
        <View style={[styles.editRowTotal, { backgroundColor: off ? colors.textMuted : nc ? '#6b7280' : rt ? '#d97706' : total > 0 ? colors.primary : colors.borderDark }]}>
          <Text style={[styles.editRowTotalText, !off && !nc && !rt && total > 0 && { color: colors.onPrimary }]}>{off ? 'Off' : nc ? 'NC' : rt ? 'RT' : total}</Text>
        </View>
      </View>

      <View style={styles.editInputsRow}>
        <EditInput label={TIER.over30.long} a11y={`${name} ${dayName} ${TIER.over30.short} sign-ups`} value={day.over30} disabled={inputsDisabled} onChange={(v) => onChange('over30', v)} />
        <EditInput label={TIER.under30.long} a11y={`${name} ${dayName} ${TIER.under30.short} sign-ups`} value={day.under30} disabled={inputsDisabled} onChange={(v) => onChange('under30', v)} />
      </View>

      <View style={styles.editStatusRow}>
        <EditStatusChip active={inStatus} label="In" onPress={() => onChange('status', 'in')} />
        <EditStatusChip active={off} label="Off" onPress={() => onChange('status', off ? 'in' : 'off')} />
        <EditStatusChip active={ab} label="AB" onPress={() => onChange('status', ab ? 'in' : 'ab')} />
        <EditStatusChip active={rt} label="RT" onPress={() => onChange('status', rt ? 'in' : 'rt')} />
        <EditStatusChip active={nc} label="NC" onPress={() => onChange('status', nc ? 'in' : 'nc')} />
      </View>
    </View>
  );
}

function EditInput({ label, a11y, value, disabled, onChange }: { label: string; a11y?: string; value: number | null; disabled: boolean; onChange: (v: string) => void }) {
  return (
    <View style={[styles.inputCell, disabled && { opacity: 0.4 }]}>
      <Text style={styles.inputLabel}>{label}</Text>
      <TextInput
        style={styles.inputField}
        value={value === null || value === undefined ? '' : String(value)}
        onChangeText={onChange}
        keyboardType="number-pad"
        placeholder="0"
        placeholderTextColor={colors.textMuted}
        selectTextOnFocus
        editable={!disabled}
        maxLength={3}
        accessibilityLabel={a11y || label}
      />
    </View>
  );
}

function EditStatusChip({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={[styles.statusChip, active && styles.statusChipActive]} onPress={onPress} activeOpacity={0.7}>
      <Text style={[styles.statusChipText, active && { color: colors.onPrimary }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border },
  title: { fontSize: 18, fontWeight: '800', color: colors.text },
  subtitle: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  clearBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: '#b91c1c', marginRight: 6 },
  clearBtnText: { fontSize: 13, fontWeight: '700', color: '#b91c1c' },
  editBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: colors.primary, backgroundColor: colors.surface },
  editBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  editBtnText: { fontSize: 13, fontWeight: '700', color: colors.primary },
  statRow: { flexDirection: 'row', gap: 8 },
  statCard: { flex: 1, alignItems: 'center', padding: 14, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  statLabel: { fontSize: 10, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.5 },
  statValue: { fontSize: 22, fontWeight: '800', color: colors.text, marginTop: 4, fontVariant: ['tabular-nums'] as any },
  hint: { fontSize: 11, color: colors.textMuted, textAlign: 'center', marginTop: 8, marginBottom: 14, fontStyle: 'italic' },
  personRow: { flexDirection: 'row', alignItems: 'center', padding: 12, borderRadius: 10, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, marginBottom: 6 },
  personName: { fontSize: 14, fontWeight: '700', color: colors.text },
  personMeta: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  personBadge: { minWidth: 48, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, alignItems: 'center' },
  personBadgeText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  editRow: { padding: 10, borderRadius: 10, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, marginBottom: 8 },
  editRowHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  editRowName: { fontSize: 14, fontWeight: '700', color: colors.text },
  editRowRoleTag: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, backgroundColor: colors.surfaceAlt },
  editRowRoleTagText: { fontSize: 9, fontWeight: '800', color: colors.textMuted, letterSpacing: 0.5 },
  editRowTotal: { minWidth: 44, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, alignItems: 'center' },
  editRowTotalText: { color: '#fff', fontWeight: '800', fontSize: 13, fontVariant: ['tabular-nums'] as any },
  editInputsRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  inputCell: { flex: 1, backgroundColor: colors.background, borderRadius: 8, borderWidth: 1, borderColor: colors.border, paddingVertical: 6, paddingHorizontal: 8 },
  inputLabel: { fontSize: 10, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.5 },
  inputField: { fontSize: 18, fontWeight: '800', color: colors.text, paddingVertical: 4, textAlign: 'center', fontVariant: ['tabular-nums'] as any },
  editStatusRow: { flexDirection: 'row', gap: 6 },
  statusChip: { flex: 1, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: colors.border, alignItems: 'center', backgroundColor: colors.background },
  statusChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  statusChipText: { fontSize: 11, fontWeight: '700', color: colors.textMuted },

  // AB request sheet
  abBackdrop: { flex: 1, backgroundColor: 'rgba(10, 6, 16, 0.55)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  abCard: { width: '100%', maxWidth: 380, backgroundColor: colors.surface, borderRadius: 16, padding: 20, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 12 },
  abTitle: { fontSize: 16, fontWeight: '800', color: colors.text },
  abSub: { fontSize: 12, color: colors.textMuted, lineHeight: 17, marginTop: 4, marginBottom: 12 },
  abLabel: { fontSize: 10, fontWeight: '800', color: colors.textMuted, letterSpacing: 0.4, textTransform: 'uppercase', marginBottom: 4 },
  abInput: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background, color: colors.text, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, minHeight: 52, textAlignVertical: 'top' },
  abHint: { fontSize: 11, color: '#b45309', marginTop: 6, fontWeight: '600' },
  abGhostBtn: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border },
  abGhostText: { fontSize: 13, fontWeight: '700', color: colors.textMuted },
  abSendBtn: { flex: 2, alignItems: 'center', paddingVertical: 12, borderRadius: 10, backgroundColor: '#b45309' },
  abSendText: { fontSize: 13, fontWeight: '800', color: '#fff' },
});

/* __theme_static_fallback__ */
// Fallback static styles (used if a sub-component didn't pick up the
// useColors hook). Always light-mode — won't react to theme changes.
const styles = createStyles(lightColors);
