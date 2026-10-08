import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, Modal, Pressable, TextInput, ScrollView, ActivityIndicator, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fonts } from '../../theme/ThemeContext';
import { apiService } from '../../api/client';
import { showAlert } from '../../utils/showAlert';
import { useKeyboardInset } from '../../hooks/useKeyboardInset';
import { ScheduleBlock } from '../../utils/scheduleNotifications';
import { DAY_FULL, dowOf, hhmmToMin, longDate, minToHHMM, shortTime, timeRange, todayISO } from '../../utils/calendarDates';
import TimePickerSheet from './TimePickerSheet';
import MiniMonth from './MiniMonth';
import { CAL } from './CalendarGrid';
import {
  GROUPS, GROUP_LABEL, OFFICE_COLOURS, PERSONAL_COLOURS, REMINDER_OPTIONS, blockGroups, isDone, isPersonal,
  reminderLabel, textOn,
} from './calendarModel';

// ── Shared dialog frame: a centred card on wide screens, a bottom sheet on
// phones (lifted over the on-screen keyboard on the installed web app).
function Frame({ wide, onClose, children, maxW = 460 }: { wide: boolean; onClose: () => void; children: React.ReactNode; maxW?: number }) {
  const insets = useSafeAreaInsets();
  const kb = useKeyboardInset();
  return (
    <Modal visible transparent animationType={wide ? 'fade' : 'slide'} onRequestClose={onClose}>
      <Pressable style={[f.backdrop, wide ? f.backdropWide : f.backdropSheet]} onPress={onClose}>
        <Pressable
          onPress={() => {}}
          style={[f.card, wide ? [f.cardWide, { maxWidth: maxW }] : [f.cardSheet, { paddingBottom: insets.bottom + 8, marginBottom: kb }]]}
        >
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Editor ──────────────────────────────────────────────────────────────────
export type Draft = Partial<ScheduleBlock> & { date?: string | null; anchorDate?: string };

export function EventEditor({ draft, office, officeId, wide, onClose, onSaved, onDelete }: {
  draft: Draft;
  /** true = the office timetable (admin only); false = the viewer's own item. */
  office: boolean;
  officeId: string | null;
  wide: boolean;
  onClose: () => void;
  onSaved: () => void;
  onDelete?: () => void;
}) {
  const isEdit = !!draft.id;
  const [title, setTitle] = useState(draft.title || '');
  const [kind, setKind] = useState<'event' | 'task'>(draft.kind === 'task' ? 'task' : 'event');
  const [date, setDate] = useState<string>(draft.date || draft.anchorDate || todayISO());
  const [repeat, setRepeat] = useState<boolean>(isEdit ? !draft.date : office);
  const [start, setStart] = useState(draft.start_time || '10:00');
  const [end, setEnd] = useState(draft.end_time || minToHHMM((hhmmToMin(draft.start_time || '10:00') ?? 600) + 30));
  const [groups, setGroups] = useState<string[]>(office ? (draft.id ? blockGroups(draft as ScheduleBlock) : [...GROUPS]) : []);
  const [reminder, setReminder] = useState<number | null>(
    draft.reminder_minutes !== undefined ? draft.reminder_minutes : (office ? 5 : 10));
  const [color, setColor] = useState(draft.color || (office ? OFFICE_COLOURS[3] : PERSONAL_COLOURS[0]));
  const [presenter, setPresenter] = useState(draft.presenter || '');
  const [details, setDetails] = useState(draft.details || '');
  const [picking, setPicking] = useState<null | 'start' | 'end' | 'date'>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleGroup = (g: string) => setGroups((cur) => cur.includes(g) ? cur.filter((x) => x !== g) : GROUPS.filter((x) => cur.includes(x) || x === g));

  const save = async () => {
    if (!title.trim()) { setError('Add a title'); return; }
    const sm = hhmmToMin(start), em = hhmmToMin(end);
    if (sm === null || em === null || em <= sm) { setError('End time must be after the start'); return; }
    if (office && !groups.length) { setError('Pick at least one lane'); return; }
    setSaving(true); setError(null);
    const payload: any = {
      title: title.trim(), start_time: start, end_time: end,
      day_of_week: dowOf(date), date: repeat ? null : date,
      reminder_minutes: reminder, color, details: details.trim() || null,
    };
    if (office) {
      Object.assign(payload, { office_id: officeId, groups, presenter: presenter.trim() || null });
      if (!isEdit || draft.audience !== 'core_leaders') payload.audience = 'all';
    } else {
      Object.assign(payload, { audience: 'personal', kind });
    }
    try {
      if (isEdit) await apiService.updateScheduleBlock(draft.id!, payload);
      else await apiService.createScheduleBlock(payload);
      onSaved();
    } catch (e: any) {
      const msg = e?.response?.data?.detail;
      setError(typeof msg === 'string' ? msg : 'Could not save. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const palette = office ? OFFICE_COLOURS : PERSONAL_COLOURS;
  return (
    <Frame wide={wide} onClose={onClose}>
      <View style={f.topBar}>
        <View style={[f.badge, office ? f.badgeOffice : null]}>
          <Ionicons name={office ? 'business-outline' : 'person-outline'} size={12} color={office ? CAL.onLime : CAL.lime} />
          <Text style={[f.badgeText, office && { color: CAL.onLime }]}>{office ? 'Office timetable' : 'Only you'}</Text>
        </View>
        <View style={{ flex: 1 }} />
        {isEdit && onDelete && (
          <Pressable onPress={onDelete} style={f.iconBtn} accessibilityLabel="Delete" hitSlop={6}>
            <Ionicons name="trash-outline" size={18} color={CAL.muted} />
          </Pressable>
        )}
        <Pressable onPress={onClose} style={f.iconBtn} accessibilityLabel="Close" hitSlop={6}>
          <Ionicons name="close" size={20} color={CAL.muted} />
        </Pressable>
      </View>

      <ScrollView style={{ maxHeight: wide ? 560 : 520 }} contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 6 }} keyboardShouldPersistTaps="handled">
        <TextInput
          value={title}
          onChangeText={setTitle}
          placeholder={kind === 'task' ? 'Add a task' : 'Add title'}
          placeholderTextColor={CAL.faint}
          style={f.title}
          autoFocus={Platform.OS === 'web' && wide}
          maxLength={80}
          onSubmitEditing={save}
          testID="cal-title"
        />
        <View style={f.titleRule} />

        {!office && (
          <View style={f.seg}>
            {(['event', 'task'] as const).map((k) => (
              <Pressable key={k} onPress={() => setKind(k)} style={[f.segItem, kind === k && f.segOn]}>
                <Ionicons name={k === 'task' ? 'checkmark-circle-outline' : 'calendar-outline'} size={14} color={kind === k ? CAL.onLime : CAL.muted} />
                <Text style={[f.segText, kind === k && { color: CAL.onLime }]}>{k === 'task' ? 'Task' : 'Event'}</Text>
              </Pressable>
            ))}
          </View>
        )}

        {/* When */}
        <Row icon="time-outline">
          <View style={{ flex: 1, gap: 8 }}>
            <View style={f.whenRow}>
              <Pressable onPress={() => setPicking(picking === 'date' ? null : 'date')} style={f.pill}>
                <Text style={f.pillText}>{repeat ? `Every ${DAY_FULL[dowOf(date)]}` : longDate(date)}</Text>
              </Pressable>
              <Pressable onPress={() => setPicking('start')} style={f.pill} testID="cal-start">
                <Text style={f.pillText}>{shortTime(start)}</Text>
              </Pressable>
              <Text style={{ color: CAL.muted }}>–</Text>
              <Pressable onPress={() => setPicking('end')} style={f.pill} testID="cal-end">
                <Text style={f.pillText}>{shortTime(end)}</Text>
              </Pressable>
            </View>
            {picking === 'date' && (
              <View style={f.inlineCal}>
                <MiniMonth selected={date} today={todayISO()} weekMode={false} onPick={(d) => { setDate(d); setPicking(null); }} />
              </View>
            )}
            <Pressable onPress={() => setRepeat((r) => !r)} style={f.check} accessibilityRole="checkbox" accessibilityState={{ checked: repeat }}>
              <Ionicons name={repeat ? 'checkbox' : 'square-outline'} size={18} color={repeat ? CAL.lime : CAL.muted} />
              <Text style={f.checkText}>Repeat every week</Text>
            </Pressable>
          </View>
        </Row>

        {/* Lanes (office timetable) */}
        {office && (
          <Row icon="people-outline">
            <View style={f.chips}>
              <Chip on={groups.length === GROUPS.length} label="Everyone" onPress={() => setGroups(groups.length === GROUPS.length ? [] : [...GROUPS])} />
              {GROUPS.map((g) => <Chip key={g} on={groups.includes(g)} label={GROUP_LABEL[g]} onPress={() => toggleGroup(g)} />)}
            </View>
          </Row>
        )}

        {/* Reminder */}
        <Row icon="notifications-outline">
          <View style={f.chips}>
            {REMINDER_OPTIONS.map((o) => (
              <Chip key={String(o.value)} on={reminder === o.value} label={o.label} onPress={() => setReminder(o.value)} />
            ))}
          </View>
        </Row>

        {office && (
          <Row icon="person-circle-outline">
            <TextInput value={presenter} onChangeText={setPresenter} placeholder="Led by (optional)" placeholderTextColor={CAL.faint} style={f.input} maxLength={60} />
          </Row>
        )}

        <Row icon="reorder-three-outline">
          <TextInput
            value={details}
            onChangeText={setDetails}
            placeholder={office ? 'Agenda or notes (optional)' : 'Notes (optional)'}
            placeholderTextColor={CAL.faint}
            style={[f.input, { minHeight: 64, textAlignVertical: 'top' }]}
            multiline
          />
        </Row>

        <Row icon="color-palette-outline">
          <View style={f.chips}>
            {palette.map((c) => (
              <Pressable key={c} onPress={() => setColor(c)} style={[f.swatch, { backgroundColor: c }, color === c && f.swatchOn]} accessibilityLabel={`Colour ${c}`}>
                {color === c && <Ionicons name="checkmark" size={14} color={textOn(c)} />}
              </Pressable>
            ))}
          </View>
        </Row>

        {error && <Text style={f.error}>{error}</Text>}
      </ScrollView>

      <View style={f.footer}>
        <Pressable onPress={onClose} style={f.ghostBtn}><Text style={f.ghostText}>Cancel</Text></Pressable>
        <Pressable onPress={save} style={[f.saveBtn, saving && { opacity: 0.6 }]} disabled={saving} testID="cal-save">
          {saving ? <ActivityIndicator color={CAL.onLime} /> : <Text style={f.saveText}>Save</Text>}
        </Pressable>
      </View>

      <TimePickerSheet visible={picking === 'start'} initialValue={start} title="Starts" onClose={() => setPicking(null)}
        onConfirm={(v) => {
          const dur = Math.max(15, (hhmmToMin(end) ?? 0) - (hhmmToMin(start) ?? 0));
          setStart(v); setEnd(minToHHMM((hhmmToMin(v) ?? 0) + dur)); setPicking(null);
        }} />
      <TimePickerSheet visible={picking === 'end'} initialValue={end} title="Ends" onClose={() => setPicking(null)}
        onConfirm={(v) => { setEnd(v); setPicking(null); }} />
    </Frame>
  );
}

function Row({ icon, children }: { icon: any; children: React.ReactNode }) {
  return (
    <View style={f.row}>
      <Ionicons name={icon} size={18} color={CAL.muted} style={{ marginTop: 6, width: 22 }} />
      <View style={{ flex: 1 }}>{children}</View>
    </View>
  );
}

function Chip({ on, label, onPress }: { on: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[f.chip, on && f.chipOn]} accessibilityRole="button" accessibilityState={{ selected: on }}>
      <Text style={[f.chipText, on && { color: CAL.onLime }]}>{label}</Text>
    </Pressable>
  );
}

// ── Detail card ─────────────────────────────────────────────────────────────
export function EventDetail({ block, iso, wide, canManage, isAdmin, onClose, onEdit, onDelete, onDuplicate, onToggleDone }: {
  block: ScheduleBlock; iso: string; wide: boolean; canManage: boolean; isAdmin: boolean;
  onClose: () => void; onEdit: () => void; onDelete: () => void; onDuplicate: () => void; onToggleDone: () => void;
}) {
  const personal = isPersonal(block);
  const task = block.kind === 'task';
  const done = isDone(block, iso);
  const lanes = useMemo(() => blockGroups(block).map((g) => GROUP_LABEL[g]), [block]);
  return (
    <Frame wide={wide} onClose={onClose} maxW={420}>
      <View style={f.topBar}>
        <View style={{ flex: 1 }} />
        {canManage && !personal && isAdmin && (
          <Pressable onPress={onDuplicate} style={f.iconBtn} accessibilityLabel="Copy to other days" hitSlop={6}>
            <Ionicons name="copy-outline" size={18} color={CAL.muted} />
          </Pressable>
        )}
        {canManage && (
          <>
            <Pressable onPress={onEdit} style={f.iconBtn} accessibilityLabel="Edit" hitSlop={6}>
              <Ionicons name="create-outline" size={18} color={CAL.muted} />
            </Pressable>
            <Pressable onPress={onDelete} style={f.iconBtn} accessibilityLabel="Delete" hitSlop={6}>
              <Ionicons name="trash-outline" size={18} color={CAL.muted} />
            </Pressable>
          </>
        )}
        <Pressable onPress={onClose} style={f.iconBtn} accessibilityLabel="Close" hitSlop={6}>
          <Ionicons name="close" size={20} color={CAL.muted} />
        </Pressable>
      </View>
      <View style={{ paddingHorizontal: 18, paddingBottom: 18, gap: 12 }}>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={[f.dot, { backgroundColor: block.color }]} />
          <View style={{ flex: 1 }}>
            <Text style={[f.detailTitle, done && { textDecorationLine: 'line-through', opacity: 0.6 }]}>{block.title}</Text>
            <Text style={f.detailWhen}>
              {block.date ? longDate(block.date) : longDate(iso)} · {timeRange(block.start_time, block.end_time)}
            </Text>
            <Text style={f.detailSub}>{block.date ? 'Does not repeat' : `Every ${DAY_FULL[block.day_of_week]}`}</Text>
          </View>
        </View>
        {!personal && (
          <Line icon="people-outline" text={lanes.length === 4 ? 'Everyone' : lanes.join(' · ')} />
        )}
        {block.presenter ? <Line icon="person-circle-outline" text={`Led by ${block.presenter}`} /> : null}
        {block.topic ? <Line icon="bulb-outline" text={block.topic} /> : null}
        {block.details ? <Line icon="reorder-three-outline" text={block.details} /> : null}
        <Line icon="notifications-outline" text={reminderLabel(block.reminder_minutes)} />
        {personal ? (
          <Line icon="lock-closed-outline" text="Private: only you can see this" />
        ) : !isAdmin ? (
          <Line icon="lock-closed-outline" text="Office timetable: set by the Owner" />
        ) : null}
        {task && (
          <Pressable onPress={onToggleDone} style={[f.saveBtn, { alignSelf: 'flex-start', paddingHorizontal: 16, flexDirection: 'row', gap: 6 }]}>
            <Ionicons name={done ? 'arrow-undo-outline' : 'checkmark'} size={16} color={CAL.onLime} />
            <Text style={f.saveText}>{done ? 'Mark not done' : 'Mark done'}</Text>
          </Pressable>
        )}
      </View>
    </Frame>
  );
}

function Line({ icon, text }: { icon: any; text: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
      <Ionicons name={icon} size={17} color={CAL.muted} style={{ width: 20, marginTop: 1 }} />
      <Text style={f.lineText}>{text}</Text>
    </View>
  );
}

// ── Day label editor (admin): "Tuesday · Day Trip" ─────────────────────────
export function DayLabelsEditor({ labels, wide, onClose, onSave }: {
  labels: Record<string, string>; wide: boolean; onClose: () => void; onSave: (l: Record<string, string>) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({ ...labels });
  const [saving, setSaving] = useState(false);
  return (
    <Frame wide={wide} onClose={onClose} maxW={400}>
      <View style={f.topBar}>
        <Text style={[f.detailTitle, { fontSize: 16 }]}>Day names</Text>
        <View style={{ flex: 1 }} />
        <Pressable onPress={onClose} style={f.iconBtn} accessibilityLabel="Close"><Ionicons name="close" size={20} color={CAL.muted} /></Pressable>
      </View>
      <View style={{ paddingHorizontal: 18, gap: 8 }}>
        {DAY_FULL.slice(0, 6).map((d, i) => (
          <View key={d} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Text style={[f.lineText, { width: 92 }]}>{d}</Text>
            <TextInput
              value={draft[String(i)] || ''}
              onChangeText={(v) => setDraft((x) => ({ ...x, [String(i)]: v }))}
              placeholder="e.g. Day Trip"
              placeholderTextColor={CAL.faint}
              style={[f.input, { flex: 1 }]}
              maxLength={40}
            />
          </View>
        ))}
      </View>
      <View style={f.footer}>
        <Pressable onPress={onClose} style={f.ghostBtn}><Text style={f.ghostText}>Cancel</Text></Pressable>
        <Pressable
          onPress={async () => {
            setSaving(true);
            try { await onSave(draft); } catch { showAlert('Could not save', 'Try again.'); } finally { setSaving(false); }
          }}
          style={[f.saveBtn, saving && { opacity: 0.6 }]}
        >
          <Text style={f.saveText}>Save</Text>
        </Pressable>
      </View>
    </Frame>
  );
}

const f = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(5,18,14,0.55)' },
  backdropWide: { justifyContent: 'center', alignItems: 'center', padding: 24 },
  backdropSheet: { justifyContent: 'flex-end' },
  card: { backgroundColor: CAL.panel, borderWidth: 1, borderColor: 'rgba(183,223,88,0.16)', boxShadow: '0 24px 60px rgba(0,0,0,0.5)' } as any,
  cardWide: { width: '100%', borderRadius: 18 },
  cardSheet: { borderTopLeftRadius: 22, borderTopRightRadius: 22, borderBottomWidth: 0 },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 10, paddingBottom: 4, gap: 2, minHeight: 48 },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(183,223,88,0.4)', marginLeft: 6 },
  badgeOffice: { backgroundColor: CAL.lime, borderColor: CAL.lime },
  badgeText: { fontFamily: fonts.mono, fontSize: 10, letterSpacing: 0.6, color: CAL.lime, textTransform: 'uppercase' },

  title: { fontFamily: fonts.bodySemibold, fontSize: 22, color: CAL.text, paddingVertical: 8, outlineStyle: 'none' } as any,
  titleRule: { height: 2, backgroundColor: CAL.lime, opacity: 0.7, borderRadius: 1, marginBottom: 12 },
  seg: { flexDirection: 'row', gap: 6, marginBottom: 8 },
  segItem: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, backgroundColor: 'rgba(240,244,233,0.06)', minHeight: 36 },
  segOn: { backgroundColor: CAL.lime },
  segText: { fontFamily: fonts.bodySemibold, fontSize: 13, color: CAL.muted },

  row: { flexDirection: 'row', gap: 10, paddingVertical: 8 },
  whenRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  pill: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, backgroundColor: 'rgba(240,244,233,0.06)', minHeight: 36, justifyContent: 'center' },
  pillText: { fontFamily: fonts.bodySemibold, fontSize: 13.5, color: CAL.text },
  inlineCal: { padding: 10, borderRadius: 12, backgroundColor: CAL.canvas, maxWidth: 300 },
  check: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32 },
  checkText: { fontFamily: fonts.body, fontSize: 13.5, color: CAL.text },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingHorizontal: 11, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(240,244,233,0.14)', minHeight: 34, justifyContent: 'center' },
  chipOn: { backgroundColor: CAL.lime, borderColor: CAL.lime },
  chipText: { fontFamily: fonts.bodySemibold, fontSize: 12.5, color: CAL.text },
  input: { fontFamily: fonts.body, fontSize: 14, color: CAL.text, backgroundColor: 'rgba(240,244,233,0.06)', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 9, outlineStyle: 'none' } as any,
  swatch: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  swatchOn: { borderWidth: 2, borderColor: CAL.text },
  error: { fontFamily: fonts.bodySemibold, color: '#f59e9e', fontSize: 13, marginTop: 6 },

  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, padding: 14, paddingTop: 10 },
  ghostBtn: { paddingHorizontal: 16, minHeight: 40, borderRadius: 999, justifyContent: 'center' },
  ghostText: { fontFamily: fonts.bodySemibold, fontSize: 14, color: CAL.muted },
  saveBtn: { backgroundColor: CAL.lime, paddingHorizontal: 22, minHeight: 40, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  saveText: { fontFamily: fonts.bodyBold, fontSize: 14, color: CAL.onLime },

  dot: { width: 14, height: 14, borderRadius: 4, marginTop: 6 },
  detailTitle: { fontFamily: fonts.bodyBold, fontSize: 20, color: CAL.text },
  detailWhen: { fontFamily: fonts.body, fontSize: 13.5, color: CAL.text, marginTop: 4 },
  detailSub: { fontFamily: fonts.body, fontSize: 12, color: CAL.muted, marginTop: 2 },
  lineText: { flex: 1, fontFamily: fonts.body, fontSize: 13.5, color: CAL.text, lineHeight: 19 },
});
