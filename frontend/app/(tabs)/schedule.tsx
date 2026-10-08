import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Platform, ScrollView, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useColors, fonts } from '../../src/theme/ThemeContext';
import { apiService } from '../../src/api/client';
import { useAuth } from '../../src/auth/AuthContext';
import { useActiveOffice } from '../../src/office/ActiveOfficeContext';
import OfficeToggle from '../../src/components/ui/OfficeToggle';
import WeeklyPlanView from '../../src/components/schedule/WeeklyPlanView';
import CalendarGrid, { CAL } from '../../src/components/schedule/CalendarGrid';
import MiniMonth from '../../src/components/schedule/MiniMonth';
import DuplicateDaySheet from '../../src/components/schedule/DuplicateDaySheet';
import { Draft, EventDetail, EventEditor, DayLabelsEditor } from '../../src/components/schedule/EventSheets';
import { GROUP_LABEL, blockGroups, isDone, isPersonal, occursOn } from '../../src/components/schedule/calendarModel';
import { rescheduleAllForUser, isBlockVisible, ScheduleBlock } from '../../src/utils/scheduleNotifications';
import {
  DAY_FULL, addDays, dowOf, hhmmToMin, longDate, minToHHMM, nowMinutes, rangeLabel, shortTime,
  startOfWeek, todayISO,
} from '../../src/utils/calendarDates';
import { useTabBarClearance } from '../../src/customization/CustomTabBar';
import { BrandLoader } from '../../src/components/ui/BrandLoader';
import { showAlert } from '../../src/utils/showAlert';

// Weekly Schedule, Google Calendar style.
//
// The office timetable (the Owner's Mon–Fri sheet) is locked: only an admin
// edits it, from "Edit timetable". Everyone adds their own events and tasks
// on top, with their own reminders; those stay private to them.

type View3 = 'day' | 'week' | 'plan';
const ZOOMS = [32, 40, 48, 60, 76, 96];
const PREFS_KEY = 'schedule_cal_prefs_v1';

export default function ScheduleScreen() {
  const colors = useColors();
  const tabBarClearance = useTabBarClearance();
  const { width } = useWindowDimensions();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const canSeePlan = isAdmin || user?.role === 'leader';
  const queryClient = useQueryClient();
  const { officeId: activeOfficeId, homeOfficeId } = useActiveOffice();

  const wide = width >= 1000;      // sidebar beside the grid
  const roomy = width >= 700;      // one-row toolbar, week view by default
  const today = todayISO();

  const [view, setView] = useState<View3>(roomy ? 'week' : 'day');
  const [anchor, setAnchor] = useState(today);
  const [zoom, setZoom] = useState(3);
  const [lanes, setLanes] = useState<'office' | 'mine'>(isAdmin ? 'office' : 'mine');
  const [show, setShow] = useState({ office: true, events: true, tasks: true });
  const [sidebar, setSidebar] = useState(true);
  const [miniOpen, setMiniOpen] = useState(false);
  const [editTimetable, setEditTimetable] = useState(false);
  const [editor, setEditor] = useState<{ draft: Draft; office: boolean } | null>(null);
  const [detail, setDetail] = useState<{ block: ScheduleBlock; iso: string } | null>(null);
  const [dupBlock, setDupBlock] = useState<ScheduleBlock | null>(null);
  const [labelsOpen, setLabelsOpen] = useState(false);

  // Remember zoom / lanes / sidebar per device (a convenience only).
  useEffect(() => {
    AsyncStorage.getItem(PREFS_KEY).then((raw) => {
      if (!raw) return;
      const p = JSON.parse(raw);
      if (typeof p.zoom === 'number') setZoom(Math.max(0, Math.min(ZOOMS.length - 1, p.zoom)));
      if (p.lanes === 'office' || p.lanes === 'mine') setLanes(p.lanes);
      if (typeof p.sidebar === 'boolean') setSidebar(p.sidebar);
    }).catch(() => {});
  }, []);
  useEffect(() => {
    AsyncStorage.setItem(PREFS_KEY, JSON.stringify({ zoom, lanes, sidebar })).catch(() => {});
  }, [zoom, lanes, sidebar]);

  const q = useQuery({
    queryKey: ['schedule', activeOfficeId],
    queryFn: () => apiService.listSchedule(activeOfficeId).then((r) => r.data),
    staleTime: 1000 * 30,
  });
  const refresh = useCallback(() => queryClient.invalidateQueries({ queryKey: ['schedule', activeOfficeId] }), [queryClient, activeOfficeId]);

  const rawBlocks: ScheduleBlock[] = q.data?.blocks || [];
  const officeId: string | null = q.data?.office_id || null;
  const myGroup: string = q.data?.my_group || (isAdmin ? 's4' : user?.role === 'leader' ? 'ld' : 's1');
  const dayLabels: Record<string, string> = q.data?.day_labels || {};
  const absentDates: string[] = q.data?.absent_dates || [];
  const blankAbsent = absentDates.length > 0 && (!isAdmin || lanes === 'mine');

  const allBlocks = useMemo(
    () => rawBlocks.filter((b) => isBlockVisible(b.audience, user?.role, user?.id, b.core_leader_ids, b.owner_id)),
    [rawBlocks, user?.role, user?.id],
  );
  const shown = useMemo(() => allBlocks.filter((b) => {
    if (!isPersonal(b)) return show.office;
    return b.kind === 'task' ? show.tasks : show.events;
  }), [allBlocks, show]);

  // Native reminders for the home office only (the web app gets server pushes).
  useEffect(() => {
    if (!q.data) return;
    if (activeOfficeId && homeOfficeId && activeOfficeId !== homeOfficeId) return;
    rescheduleAllForUser(rawBlocks, user?.role, user?.id, absentDates).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, user?.role, user?.id, activeOfficeId, homeOfficeId]);

  // Days on screen. Weekends appear only when something's on.
  const days = useMemo(() => {
    if (view === 'day') return [anchor];
    const mon = startOfWeek(anchor);
    const week = Array.from({ length: 7 }, (_, i) => addDays(mon, i));
    return week.filter((d, i) => i < 5 || shown.some((b) => occursOn(b, d)));
  }, [view, anchor, shown]);

  const step = view === 'day' ? 1 : 7;
  const go = useCallback((n: number) => setAnchor((a) => addDays(a, n * step)), [step]);
  const title = view === 'day' ? longDate(anchor) : rangeLabel(days[0], days[days.length - 1]);

  const openCreate = useCallback((iso: string, startMin?: number, kind: 'event' | 'task' = 'event') => {
    const office = isAdmin && editTimetable;
    const s = startMin ?? Math.min(20 * 60, Math.ceil((iso === today ? nowMinutes() : 600) / 30) * 30);
    setEditor({
      office,
      draft: {
        anchorDate: iso, day_of_week: dowOf(iso), start_time: minToHHMM(s), end_time: minToHHMM(s + 30),
        kind, date: office ? null : iso,
      },
    });
  }, [isAdmin, editTimetable, today]);

  // Google-style keyboard shortcuts on desktop: t today, d/w views, j/k or
  // arrows to move, c to create.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (editor || detail || e.metaKey || e.ctrlKey || e.altKey) return;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === 't') setAnchor(today);
      else if (k === 'd') setView('day');
      else if (k === 'w') setView('week');
      else if (k === 'j' || k === 'n' || e.key === 'ArrowRight') go(1);
      else if (k === 'k' || k === 'p' || e.key === 'ArrowLeft') go(-1);
      else if (k === 'c') openCreate(view === 'day' ? anchor : today);
      else if (k === '+' || k === '=') setZoom((z) => Math.min(ZOOMS.length - 1, z + 1));
      else if (k === '-') setZoom((z) => Math.max(0, z - 1));
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor, detail, go, openCreate, view, anchor, today]);

  const canManage = (b: ScheduleBlock) => (isPersonal(b) ? b.owner_id === user?.id : isAdmin);

  const toggleDone = async (b: ScheduleBlock, iso: string) => {
    if (!isPersonal(b) || b.owner_id !== user?.id) return;
    try {
      await apiService.setScheduleTaskDone(b.id, iso, !isDone(b, iso));
      await refresh();
    } catch {
      showAlert('Could not update', 'Try again.');
    }
  };

  const remove = (b: ScheduleBlock) => {
    const run = async () => {
      try { await apiService.deleteScheduleBlock(b.id); setDetail(null); setEditor(null); await refresh(); }
      catch (e: any) { showAlert('Could not delete', e?.response?.data?.detail || 'Try again.'); }
    };
    const what = isPersonal(b) ? `"${b.title}"` : `"${b.title}" from the office timetable${b.date ? '' : ` (every ${DAY_FULL[b.day_of_week]})`}`;
    if (Platform.OS === 'web') {
      // eslint-disable-next-line no-alert
      if (confirm(`Delete ${what}?`)) run();
    } else {
      showAlert('Delete', `Delete ${what}?`, [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: run }]);
    }
  };

  const duplicate = async (b: ScheduleBlock, toDays: number[]) => {
    try {
      const r = await apiService.duplicateScheduleBlock(b.id, toDays);
      await refresh();
      const names = (r.data?.created || []).map((c: any) => DAY_FULL[c.day_of_week]).join(', ');
      showAlert('Copied', `"${b.title}" copied to ${names || 'the selected days'}.`);
    } catch (e: any) {
      showAlert('Could not copy', e?.response?.data?.detail || 'Try again.');
    }
  };

  // "Up next" for the sidebar: the viewer's next thing today.
  const upNext = useMemo(() => {
    const now = nowMinutes();
    const mine = allBlocks
      .filter((b) => occursOn(b, today) && (isPersonal(b) || blockGroups(b).includes(myGroup)) && !isDone(b, today))
      .filter((b) => (hhmmToMin(b.end_time) ?? 0) > now)
      .sort((a, b) => (hhmmToMin(a.start_time) ?? 0) - (hhmmToMin(b.start_time) ?? 0));
    return mine.slice(0, 3).map((b) => ({ b, live: (hhmmToMin(b.start_time) ?? 0) <= now }));
  }, [allBlocks, today, myGroup]);

  const marked = useMemo(() => new Set(allBlocks.filter((b) => isPersonal(b) && b.date).map((b) => b.date as string)), [allBlocks]);

  // ── Pieces ───────────────────────────────────────────────────────────────
  const Seg = ({ items, value, onChange }: { items: { key: string; label: string }[]; value: string; onChange: (k: any) => void }) => (
    <View style={st.seg}>
      {items.map((it) => (
        <Pressable key={it.key} onPress={() => onChange(it.key)} style={[st.segItem, value === it.key && st.segOn]} testID={`schedule-view-${it.key}`}>
          <Text style={[st.segText, value === it.key && { color: CAL.onLime }]}>{it.label}</Text>
        </Pressable>
      ))}
    </View>
  );
  const IconBtn = ({ icon, onPress, label, active }: { icon: any; onPress: () => void; label: string; active?: boolean }) => (
    <Pressable onPress={onPress} style={(s: any) => [st.iconBtn, active && st.iconBtnOn, s.hovered && st.iconBtnHover]} accessibilityLabel={label} hitSlop={4}>
      <Ionicons name={icon} size={18} color={active ? CAL.onLime : CAL.text} />
    </Pressable>
  );

  const viewItems = [
    { key: 'day', label: 'Day' }, { key: 'week', label: 'Week' },
    ...(canSeePlan ? [{ key: 'plan', label: 'Plan' }] : []),
  ];

  const Toolbar = (
    <View style={st.toolbar}>
      <View style={st.toolRow}>
        {wide && view !== 'plan' && <IconBtn icon="menu" onPress={() => setSidebar((v) => !v)} label="Show or hide the sidebar" />}
        {view !== 'plan' && (
          <>
            <Pressable onPress={() => setAnchor(today)} style={st.todayBtn} testID="schedule-today">
              <Text style={st.todayText}>Today</Text>
            </Pressable>
            <IconBtn icon="chevron-back" onPress={() => go(-1)} label={view === 'day' ? 'Previous day' : 'Previous week'} />
            <IconBtn icon="chevron-forward" onPress={() => go(1)} label={view === 'day' ? 'Next day' : 'Next week'} />
            <Pressable onPress={() => !wide && setMiniOpen((v) => !v)} style={st.titleWrap} disabled={wide}>
              <Text style={st.title} numberOfLines={1}>{title}</Text>
              {!wide && <Ionicons name={miniOpen ? 'chevron-up' : 'chevron-down'} size={14} color={CAL.muted} />}
            </Pressable>
          </>
        )}
        {view === 'plan' && <Text style={[st.title, { flex: 1 }]}>Weekly Plan</Text>}
        {roomy && <View style={{ flex: view === 'plan' ? 0 : 1 }} />}
        {roomy && view !== 'plan' && <Seg items={[{ key: 'mine', label: 'My lane' }, { key: 'office', label: 'Whole office' }]} value={lanes} onChange={setLanes} />}
        {roomy && <Seg items={viewItems} value={view} onChange={setView} />}
        {roomy && view !== 'plan' && (
          <View style={st.zoom}>
            <IconBtn icon="remove" onPress={() => setZoom((z) => Math.max(0, z - 1))} label="Zoom out" />
            <IconBtn icon="add" onPress={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))} label="Zoom in" />
          </View>
        )}
      </View>
      {!roomy && (
        <View style={[st.toolRow, { marginTop: 6 }]}>
          <Seg items={viewItems} value={view} onChange={setView} />
          {view !== 'plan' && <Seg items={[{ key: 'mine', label: 'Mine' }, { key: 'office', label: 'Office' }]} value={lanes} onChange={setLanes} />}
          <View style={{ flex: 1 }} />
          {view !== 'plan' && (
            <View style={st.zoom}>
              <IconBtn icon="remove" onPress={() => setZoom((z) => Math.max(0, z - 1))} label="Zoom out" />
              <IconBtn icon="add" onPress={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))} label="Zoom in" />
            </View>
          )}
        </View>
      )}
      {!wide && miniOpen && view !== 'plan' && (
        <View style={st.miniDrop}>
          <MiniMonth selected={anchor} today={today} weekMode={view === 'week'} marked={marked} onPick={(d) => { setAnchor(d); setMiniOpen(false); }} />
        </View>
      )}
      {isAdmin && editTimetable && view !== 'plan' && (
        <View style={st.editBanner}>
          <Ionicons name="lock-open-outline" size={14} color={CAL.onLime} />
          <Text style={st.editBannerText}>Editing the office timetable: tap a slot to add, tap a block to change it.</Text>
          <Pressable onPress={() => setEditTimetable(false)} hitSlop={8}><Text style={[st.editBannerText, { textDecorationLine: 'underline' }]}>Done</Text></Pressable>
        </View>
      )}
    </View>
  );

  const Check = ({ on, color, label, onPress }: { on: boolean; color: string; label: string; onPress: () => void }) => (
    <Pressable onPress={onPress} style={(s: any) => [st.checkRow, s.hovered && st.rowHover]} accessibilityRole="checkbox" accessibilityState={{ checked: on }}>
      <View style={[st.checkBox, { borderColor: color }, on && { backgroundColor: color }]}>
        {on && <Ionicons name="checkmark" size={12} color={CAL.onLime} />}
      </View>
      <Text style={st.checkText}>{label}</Text>
    </Pressable>
  );

  const Sidebar = (
    <ScrollView style={st.sidebar} contentContainerStyle={{ padding: 14, gap: 18 }} showsVerticalScrollIndicator={false}>
      <Pressable onPress={() => openCreate(view === 'day' ? anchor : today)} style={(s: any) => [st.createBtn, s.hovered && { transform: [{ translateY: -1 }] }]} testID="schedule-create">
        <Ionicons name="add" size={22} color={CAL.onLime} />
        <Text style={st.createText}>{isAdmin && editTimetable ? 'Timetable block' : 'Create'}</Text>
      </Pressable>
      {!(isAdmin && editTimetable) && (
        <Pressable onPress={() => openCreate(view === 'day' ? anchor : today, undefined, 'task')} style={st.taskBtn}>
          <Ionicons name="checkmark-circle-outline" size={16} color={CAL.lime} />
          <Text style={st.taskText}>New task</Text>
        </Pressable>
      )}

      <MiniMonth selected={anchor} today={today} weekMode={view === 'week'} marked={marked} onPick={setAnchor} />

      {upNext.length > 0 && (
        <View style={{ gap: 8 }}>
          <Text style={st.sideHead}>Up next today</Text>
          {upNext.map(({ b, live }) => (
            <Pressable key={b.id} onPress={() => setDetail({ block: b, iso: today })} style={(s: any) => [st.nextCard, s.hovered && st.rowHover]}>
              <View style={[st.nextBar, { backgroundColor: b.color }]} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={st.nextTitle} numberOfLines={1}>{b.title}</Text>
                <Text style={[st.nextTime, live && { color: CAL.lime }]}>{live ? `Now · until ${shortTime(b.end_time)}` : shortTime(b.start_time)}</Text>
              </View>
            </Pressable>
          ))}
        </View>
      )}

      <View style={{ gap: 2 }}>
        <Text style={st.sideHead}>Calendars</Text>
        <Check on={show.office} color={CAL.lime} label="Office timetable" onPress={() => setShow((s) => ({ ...s, office: !s.office }))} />
        <Check on={show.events} color="#4fd1c5" label="My events" onPress={() => setShow((s) => ({ ...s, events: !s.events }))} />
        <Check on={show.tasks} color="#60a5fa" label="My tasks" onPress={() => setShow((s) => ({ ...s, tasks: !s.tasks }))} />
      </View>

      <View style={st.laneCard}>
        <Ionicons name="person-circle-outline" size={18} color={CAL.lime} />
        <Text style={st.laneText}>Your lane: <Text style={{ color: CAL.lime, fontFamily: fonts.bodyBold }}>{GROUP_LABEL[myGroup] || 'Everyone'}</Text></Text>
      </View>

      {isAdmin && (
        <View style={{ gap: 6 }}>
          <Text style={st.sideHead}>Owner tools</Text>
          <Pressable onPress={() => setEditTimetable((v) => !v)} style={[st.adminBtn, editTimetable && st.adminBtnOn]} testID="schedule-edit-timetable">
            <Ionicons name={editTimetable ? 'lock-open-outline' : 'lock-closed-outline'} size={15} color={editTimetable ? CAL.onLime : CAL.text} />
            <Text style={[st.adminText, editTimetable && { color: CAL.onLime }]}>{editTimetable ? 'Editing timetable' : 'Edit timetable'}</Text>
          </Pressable>
          <Pressable onPress={() => setLabelsOpen(true)} style={st.adminBtn}>
            <Ionicons name="pricetag-outline" size={15} color={CAL.text} />
            <Text style={st.adminText}>Day names</Text>
          </Pressable>
        </View>
      )}

      {Platform.OS === 'web' && (
        <Text style={st.hint}>Shortcuts: T today · D day · W week · ←/→ move · C create · +/− zoom</Text>
      )}
    </ScrollView>
  );

  // ── Render ─────────────────────────────────────────────────────────────────
  let body: React.ReactNode;
  if (view === 'plan') {
    body = <WeeklyPlanView />;
  } else if (q.isLoading) {
    body = <View style={{ marginTop: 40, alignItems: 'center' }}><BrandLoader size={48} /></View>;
  } else if (!officeId) {
    body = (
      <View style={st.empty}>
        <Ionicons name="alert-circle-outline" size={40} color={colors.textMuted} />
        <Text style={[st.emptyText, { color: colors.textMuted }]}>You're not in an office yet. Ask an admin to add you.</Text>
      </View>
    );
  } else {
    body = (
      <View style={{ flex: 1, flexDirection: 'row', gap: 10 }}>
        {wide && sidebar && Sidebar}
        <CalendarGrid
          days={days}
          blocks={shown}
          mode={lanes}
          myGroup={myGroup}
          isAdmin={isAdmin}
          hourHeight={ZOOMS[zoom]}
          dayLabels={dayLabels}
          today={today}
          absentDates={absentDates}
          blankAbsent={blankAbsent}
          compact={!roomy}
          onPressBlock={(b, iso) => setDetail({ block: b, iso })}
          onCreate={(iso, m) => openCreate(iso, m)}
          onToggleDone={toggleDone}
          onPressDay={view === 'week' ? (iso) => { setAnchor(iso); setView('day'); } : undefined}
        />
      </View>
    );
  }

  return (
    <View style={[st.container, { paddingBottom: tabBarClearance }]}>
      <OfficeToggle style={{ marginBottom: 8 }} />
      {Toolbar}
      <View style={{ flex: 1 }}>{body}</View>

      {/* Phone: floating create button, Google-style */}
      {!wide && view !== 'plan' && officeId && (
        <Pressable
          onPress={() => openCreate(view === 'day' ? anchor : today)}
          style={[st.fab, { bottom: tabBarClearance + 16 }]}
          accessibilityLabel={isAdmin && editTimetable ? 'Add a timetable block' : 'Create'}
          testID="schedule-fab"
        >
          <Ionicons name="add" size={28} color={CAL.onLime} />
        </Pressable>
      )}
      {!wide && isAdmin && view !== 'plan' && !editTimetable && officeId && (
        <Pressable onPress={() => setEditTimetable(true)} style={[st.fabSmall, { bottom: tabBarClearance + 84 }]} accessibilityLabel="Edit the office timetable">
          <Ionicons name="lock-closed-outline" size={18} color={CAL.text} />
        </Pressable>
      )}

      {editor && (
        <EventEditor
          draft={editor.draft}
          office={editor.office}
          officeId={officeId}
          wide={roomy}
          onClose={() => setEditor(null)}
          onSaved={() => { setEditor(null); refresh(); }}
          onDelete={editor.draft.id ? () => remove(editor.draft as ScheduleBlock) : undefined}
        />
      )}
      {detail && (
        <EventDetail
          block={detail.block}
          iso={detail.iso}
          wide={roomy}
          canManage={canManage(detail.block)}
          isAdmin={isAdmin}
          onClose={() => setDetail(null)}
          onEdit={() => {
            const b = detail.block;
            setDetail(null);
            setEditor({ office: !isPersonal(b), draft: { ...b, anchorDate: detail.iso } });
          }}
          onDelete={() => remove(detail.block)}
          onDuplicate={() => { const b = detail.block; setDetail(null); setDupBlock(b); }}
          onToggleDone={async () => { await toggleDone(detail.block, detail.iso); setDetail(null); }}
        />
      )}
      {dupBlock && (
        <DuplicateDaySheet
          block={dupBlock}
          onClose={() => setDupBlock(null)}
          onConfirm={async (d) => { const b = dupBlock; setDupBlock(null); if (b) await duplicate(b, d); }}
        />
      )}
      {labelsOpen && (
        <DayLabelsEditor
          labels={dayLabels}
          wide={roomy}
          onClose={() => setLabelsOpen(false)}
          onSave={async (l) => { await apiService.setScheduleDayLabels(l, officeId); setLabelsOpen(false); await refresh(); }}
        />
      )}
    </View>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 10, paddingTop: 10 },
  toolbar: { marginBottom: 10, backgroundColor: CAL.panel, borderRadius: 14, padding: 8, borderWidth: 1, borderColor: 'rgba(183,223,88,0.10)' },
  toolRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  todayBtn: { paddingHorizontal: 14, minHeight: 36, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(240,244,233,0.22)', justifyContent: 'center' },
  todayText: { fontFamily: fonts.bodySemibold, fontSize: 13, color: CAL.text },
  titleWrap: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1, minWidth: 0, paddingHorizontal: 4 },
  title: { fontFamily: fonts.bodyBold, fontSize: 17, color: CAL.text, flexShrink: 1 },
  iconBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  iconBtnOn: { backgroundColor: CAL.lime },
  iconBtnHover: { backgroundColor: 'rgba(240,244,233,0.08)' },
  seg: { flexDirection: 'row', backgroundColor: 'rgba(240,244,233,0.06)', borderRadius: 999, padding: 3 },
  segItem: { paddingHorizontal: 12, minHeight: 32, borderRadius: 999, justifyContent: 'center' },
  segOn: { backgroundColor: CAL.lime },
  segText: { fontFamily: fonts.bodySemibold, fontSize: 12.5, color: CAL.muted },
  zoom: { flexDirection: 'row', backgroundColor: 'rgba(240,244,233,0.06)', borderRadius: 999 },
  miniDrop: { marginTop: 8, padding: 10, borderRadius: 12, backgroundColor: CAL.canvas },
  editBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, backgroundColor: CAL.lime, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7 },
  editBannerText: { flex: 0, fontFamily: fonts.bodySemibold, fontSize: 12, color: CAL.onLime, flexShrink: 1 },

  sidebar: { width: 248, flexGrow: 0, backgroundColor: CAL.panel, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(183,223,88,0.10)' },
  createBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', backgroundColor: CAL.lime, paddingLeft: 14, paddingRight: 20, minHeight: 48, borderRadius: 16, boxShadow: '0 8px 20px rgba(183,223,88,0.25)' } as any,
  createText: { fontFamily: fonts.bodyBold, fontSize: 15, color: CAL.onLime },
  taskBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: -8, paddingHorizontal: 6, minHeight: 32 },
  taskText: { fontFamily: fonts.bodySemibold, fontSize: 13, color: CAL.lime },
  sideHead: { fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1.2, color: CAL.muted, textTransform: 'uppercase', marginBottom: 4 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, paddingHorizontal: 6, borderRadius: 8, minHeight: 36 },
  rowHover: { backgroundColor: 'rgba(240,244,233,0.06)' },
  checkBox: { width: 18, height: 18, borderRadius: 4, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  checkText: { fontFamily: fonts.body, fontSize: 13.5, color: CAL.text },
  nextCard: { flexDirection: 'row', gap: 10, alignItems: 'center', padding: 8, borderRadius: 10, backgroundColor: 'rgba(240,244,233,0.04)' },
  nextBar: { width: 4, alignSelf: 'stretch', borderRadius: 2 },
  nextTitle: { fontFamily: fonts.bodySemibold, fontSize: 13, color: CAL.text },
  nextTime: { fontFamily: fonts.mono, fontSize: 10.5, color: CAL.muted, marginTop: 2 },
  laneCard: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(183,223,88,0.2)' },
  laneText: { fontFamily: fonts.body, fontSize: 13, color: CAL.text },
  adminBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, minHeight: 38, borderRadius: 10, backgroundColor: 'rgba(240,244,233,0.06)' },
  adminBtnOn: { backgroundColor: CAL.lime },
  adminText: { fontFamily: fonts.bodySemibold, fontSize: 13, color: CAL.text },
  hint: { fontFamily: fonts.mono, fontSize: 9.5, lineHeight: 15, color: CAL.faint },

  fab: { position: 'absolute', right: 18, width: 58, height: 58, borderRadius: 20, backgroundColor: CAL.lime, alignItems: 'center', justifyContent: 'center', boxShadow: '0 10px 24px rgba(0,0,0,0.35), 0 0 18px rgba(183,223,88,0.35)' } as any,
  fabSmall: { position: 'absolute', right: 26, width: 42, height: 42, borderRadius: 14, backgroundColor: CAL.panel, borderWidth: 1, borderColor: 'rgba(183,223,88,0.3)', alignItems: 'center', justifyContent: 'center' },
  empty: { alignItems: 'center', padding: 36, gap: 8 },
  emptyText: { fontSize: 13, textAlign: 'center' },
});
