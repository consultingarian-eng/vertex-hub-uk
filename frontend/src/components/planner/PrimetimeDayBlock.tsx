/**
 * PrimetimeDayBlock — the office Primetime plan for ONE day, embedded in the
 * Weekly Planner's day page.
 *
 * This sits directly under the day's free-text Primetime box. That box stays
 * exactly what it was — the leader's own note to self. This block is the
 * shared, structured version: for the day being planned it lists the crew
 * who are actually IN, and each one gets Learning / Teaching / Watching, a
 * topic, and who they're doing it with.
 *
 * Who appears:
 *   • Your own tree only, since you only plan for your own people.
 *   • Minus anyone marked Absent on Bells for that day — no point handing a
 *     topic to someone who isn't coming in.
 *   • Minus anyone whose last day was before this one (see the roster rules
 *     in backend/routes/primetime.py).
 *
 * Below that, the rest of the office's sessions for the same day, read-only,
 * with an "Add my person" button — that is how a trainee gets into another
 * team's topic. Joining writes YOUR person's row, never the host's.
 *
 * Offices are separate. Everyone lands on their own — office A stays office
 * A, office B stays office B — and a super admin gets a local switcher to peek
 * at another one. Local is the point: it resets to your own office every
 * time and never touches the app-wide office setting.
 *
 * Data: GET /primetime/week · PUT /primetime/entry · POST /primetime/session/join
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiService, PrimetimeMode, PrimetimePerson } from '../../api/client';
import { useColors, fonts } from '../../theme/ThemeContext';
import { useActiveOffice } from '../../office/ActiveOfficeContext';
import { useAuth } from '../../auth/AuthContext';
import ImpactSummary from '../primetime/ImpactSummary';
import { toast } from '../../utils/toast';

const MODES: { key: PrimetimeMode; label: string; icon: any }[] = [
  { key: 'learning', label: 'Learning', icon: 'school-outline' },
  { key: 'teaching', label: 'Teaching', icon: 'megaphone-outline' },
  { key: 'watching', label: 'Watching', icon: 'eye-outline' },
];

// The preposition changes with the mode — "Learning · with Ana" reads wrong
// when what you mean is "learning FROM Ana".
const WITH_LABEL: Record<PrimetimeMode, string> = {
  learning: 'From who',
  teaching: 'To who',
  watching: 'Watching who',
};

type RowDraft = {
  mode: PrimetimeMode | null;
  topic: string;
  /** The visible "from who / to who" text — names, comma separated. */
  with_text: string;
  /**
   * Real user ids behind the names above, for the ones picked from the
   * suggestion list. These are what let the server fill in the other side of
   * the arrangement; free-typed text has nobody to reciprocate with.
   */
  with_ids: string[];
};

export default function PrimetimeDayBlock({
  week, dayIndex, canEdit,
}: {
  week: string;
  /** Mon=0 .. Sat=5 — the day page this block is rendered on. */
  dayIndex: number;
  /** False when viewing someone else's planner: read the plan, don't edit it. */
  canEdit: boolean;
}) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const qc = useQueryClient();

  // Your own office, always, with a peek at the other one for super admins.
  //
  // Deliberately LOCAL state rather than the shared ActiveOfficeContext: that
  // one persists its choice to storage and applies app-wide, so looking at New
  // Haven on Bells would follow you back here and silently show another
  // office's crew inside your own planner. Peeking here starts from your own
  // office every time and leaves no trace anywhere else.
  const { offices, canSwitch, homeOfficeId } = useActiveOffice();
  const [office, setOffice] = useState<string | undefined>(homeOfficeId || undefined);
  useEffect(() => { setOffice(homeOfficeId || undefined); }, [homeOfficeId]);
  const peeking = canSwitch && !!office && !!homeOfficeId && office !== homeOfficeId;

  const q = useQuery({
    // The office is in the key AND on every write below, because scoping reads
    // without scoping writes is worse than not scoping at all (692c153f).
    queryKey: ['primetime-week', week, office || 'mine'],
    queryFn: () => apiService.primetimeWeek(week, office).then((r) => r.data),
    enabled: !!week,
  });

  const data = q.data;

  const entryByUser = useMemo(() => {
    const map: Record<string, any> = {};
    for (const e of data?.entries || []) if (e.day_index === dayIndex) map[e.subject_user_id] = e;
    return map;
  }, [data, dayIndex]);

  // Local edits overlay the server rows rather than replacing them, so an
  // in-flight autosave response can't clobber what's still being typed.
  const [draft, setDraft] = useState<Record<string, RowDraft>>({});
  useEffect(() => { setDraft({}); }, [week, dayIndex]);

  const rowFor = (uid: string): RowDraft => {
    if (draft[uid]) return draft[uid];
    const e = entryByUser[uid];
    // Named people win over free text: once the server knows who they are it
    // keeps their names current, and an impact can hold several of them.
    const names = (e?.with_names || []).filter(Boolean);
    return {
      mode: e?.mode ?? null,
      topic: e?.topic ?? '',
      with_text: names.length ? names.join(', ') : (e?.with_text || ''),
      with_ids: e?.with_ids || [],
    };
  };

  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');

  const saveMut = useMutation({
    mutationFn: (payload: any) => apiService.savePrimetimeEntry(payload),
    onMutate: () => setSaveState('saving'),
    onSuccess: () => {
      setSaveState('saved');
      qc.invalidateQueries({ queryKey: ['primetime-week'] });
      qc.invalidateQueries({ queryKey: ['primetime-home'] });
    },
    onError: (e: any) => {
      setSaveState('idle');
      toast.error(e?.response?.data?.detail || 'Could not save Primetime');
    },
  });

  // Edits not yet sent, keyed by person, holding the FULL payload (week and day
  // included) so a flush stays correct even after the day page has moved on.
  const pending = useRef<Record<string, any>>({});
  const timers = useRef<Record<string, any>>({});

  // Send everything still queued, right now.
  //
  // This exists because the previous version cleared the pending timers on
  // unmount, which threw away every edit made in the last second before
  // leaving the screen — type a topic, tap back, and it was gone with no error.
  // Unmounting must FLUSH the queue, never discard it. The call goes straight
  // to the API rather than through the mutation because by this point the
  // component is usually already unmounting and its callbacks won't run.
  const flush = useCallback(() => {
    const items = Object.values(pending.current);
    pending.current = {};
    Object.values(timers.current).forEach(clearTimeout);
    timers.current = {};
    items.forEach((p) => {
      apiService.savePrimetimeEntry(p).catch(() => {
        toast.error('A Primetime change may not have saved');
      });
    });
  }, []);

  useEffect(() => flush, [flush]);

  const queueSave = (uid: string, row: RowDraft) => {
    pending.current[uid] = {
      week_ending: week, day_index: dayIndex, subject_user_id: uid,
      mode: row.mode, topic: row.topic, with_text: row.with_text,
      with_ids: row.with_ids, office,
    };
    clearTimeout(timers.current[uid]);
    timers.current[uid] = setTimeout(() => {
      const payload = pending.current[uid];
      if (!payload) return;
      delete pending.current[uid];
      saveMut.mutate(payload);
    }, 600);
  };

  /** Send this person's queued edit immediately (used on blur). */
  const flushOne = (uid: string) => {
    const payload = pending.current[uid];
    if (!payload) return;
    delete pending.current[uid];
    clearTimeout(timers.current[uid]);
    saveMut.mutate(payload);
  };

  const nameById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of data?.people || []) m[p.user_id] = p.name || '';
    return m;
  }, [data]);

  const edit = (uid: string, patch: Partial<RowDraft>) => {
    let next = { ...rowFor(uid), ...patch };
    // Hand-editing the text drops anyone whose name is no longer in it —
    // otherwise deleting "Malik" would leave his id behind, still quietly
    // making him teach.
    if (patch.with_text !== undefined && patch.with_ids === undefined) {
      const t = next.with_text.toLowerCase();
      next = {
        ...next,
        with_ids: next.with_ids.filter((id) => {
          const n = nameById[id];
          return !!n && t.includes(n.toLowerCase());
        }),
      };
    }
    setDraft((curr) => ({ ...curr, [uid]: next }));
    queueSave(uid, next);
  };

  const people = useMemo(() => data?.people || [], [data]);

  // My tree, on the grid for this day. Absent people are split out rather than
  // dropped silently — a leader should see WHY someone isn't in the list.
  const { present, absent } = useMemo(() => {
    const onDay = people.filter(
      (p) => p.can_edit && (p.days_on_grid || []).includes(dayIndex),
    );
    return {
      present: onDay.filter((p) => !(p.absent_days || []).includes(dayIndex)),
      absent: onDay.filter((p) => (p.absent_days || []).includes(dayIndex)),
    };
  }, [people, dayIndex]);


  // Every impact running today, whoever is hosting — the same grouped view as
  // Home. For an admin the editable list below is the whole office and is
  // genuinely hard to read; this is the part worth seeing first.
  const daySessions = useMemo(
    () => (data?.sessions || []).filter((s) => s.day_index === dayIndex),
    [data, dayIndex],
  );

  const daySolo = useMemo(() => {
    const grouped = new Set<string>();
    for (const s of daySessions) {
      grouped.add(s.host_user_id);
      for (const a of s.attendees) grouped.add(a.user_id);
    }
    return (data?.entries || [])
      .filter((e) => e.day_index === dayIndex && e.mode && !grouped.has(e.subject_user_id))
      .map((e) => ({
        user_id: e.subject_user_id,
        name: e.subject_name,
        mode: e.mode as string,
        topic: e.topic,
        with_label: (e.with_names || []).join(', ') || e.with_text,
      }));
  }, [data, dayIndex, daySessions]);

  const [joinFor, setJoinFor] = useState<string | null>(null);

  // An admin's "team" is the whole office, so the editable list is long enough
  // to bury the summary above it. Leaders have a handful of people and want to
  // type straight away.
  const { user } = useAuth();
  const isAdmin = (user?.role || '').toLowerCase() === 'admin';
  const [editOpen, setEditOpen] = useState(!isAdmin);

  const joinMut = useMutation({
    mutationFn: (v: { session_id: string; subject_user_id: string; mode?: 'learning' | 'watching' }) =>
      apiService.joinPrimetimeSession({ ...v, mode: v.mode || 'learning', office }),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: ['primetime-week'] });
      qc.invalidateQueries({ queryKey: ['primetime-home'] });
      setJoinFor(null);
      toast.success(`${present.find((p) => p.user_id === v.subject_user_id)?.name || 'They'} added`);
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Could not join'),
  });

  const candidatesFor = (sessionId: string) => {
    const s = daySessions.find((x) => x.session_id === sessionId);
    const taken = new Set([s?.host_user_id, ...(s?.attendees || []).map((a) => a.user_id)]);
    return present.filter((p) => !taken.has(p.user_id));
  };

  // ── Suggestions ──────────────────────────────────────────────────────
  // Everyone teaching something on this day, so typing "Malik" can pull his
  // topic across, and typing "Closing" can pull up whoever is running it.
  const teachingToday = useMemo(() => {
    const map: Record<string, { topic: string; session_id: string; name: string }> = {};
    for (const e of data?.entries || []) {
      if (e.day_index === dayIndex && e.mode === 'teaching') {
        map[e.subject_user_id] = {
          topic: e.topic, session_id: e.session_id, name: e.subject_name,
        };
      }
    }
    return map;
  }, [data, dayIndex]);

  /** Office people matching what's been typed, teachers first.
   *
   * Matches only the segment after the last comma, so on a teacher's row —
   * where the list grows — "Ana, Be" is looking for Ben, not for somebody
   * called "Ana, Be".
   */
  const peopleMatching = (text: string, excludeId: string) => {
    const t = (text.split(',').pop() || '').trim().toLowerCase();
    if (!t) return [];
    return people
      .filter((p) => p.user_id !== excludeId && (p.name || '').toLowerCase().includes(t))
      .sort((a, b) => Number(!!teachingToday[b.user_id]) - Number(!!teachingToday[a.user_id]))
      .slice(0, 5);
  };

  /** Topics already being run on this day that match what's been typed. */
  const topicsMatching = (text: string, excludeId: string) => {
    const t = text.trim().toLowerCase();
    if (t.length < 2) return [];
    const all = Object.entries(teachingToday)
      .filter(([uid, v]) => uid !== excludeId && v.topic)
      .map(([uid, v]) => ({ user_id: uid, ...v }));
    if (!t) return [];
    return all.filter((v) => {
      const tt = v.topic.toLowerCase();
      return tt.includes(t) && tt !== t;
    }).slice(0, 5);
  };

  /**
   * Point one of my people at a teacher.
   *
   * If they're learning or watching and the other person is actually running a
   * session, join it properly — that links the two rows, so the teacher sees
   * an attendee rather than two unrelated rows that happen to share a topic.
   * Otherwise just fill the fields in.
   */
  /**
   * Picking a TOPIC suggestion fills the topic in and nothing else.
   *
   * It used to route through pickTeacher, which joined that person's session
   * and overwrote whatever you had typed — so anyone typing a topic that
   * merely shared a few letters with an existing one got snapped into someone
   * else's session and could never set a topic of their own. A suggestion is
   * a shortcut, not a decision: it may fill a blank counterpart, never
   * replace one, and never joins anything.
   */
  const pickTopic = (uid: string, topic: string, teacherId: string, teacherName: string) => {
    const row = rowFor(uid);
    edit(uid, {
      topic,
      ...(row.with_text.trim() ? {} : { with_text: teacherName, with_ids: [teacherId] }),
    });
  };

  const pickTeacher = (uid: string, otherId: string, otherName: string) => {
    const t = teachingToday[otherId];
    const row = rowFor(uid);
    if (row.with_ids.includes(otherId)) return; // already on this row

    // Joining an existing session is the cleanest path when they're already
    // running one and this person is going to it.
    if (t?.session_id && (row.mode === 'learning' || row.mode === 'watching')) {
      delete pending.current[uid];
      clearTimeout(timers.current[uid]);
      setDraft((curr) => ({
        ...curr,
        [uid]: { ...row, topic: t.topic, with_text: otherName, with_ids: [otherId] },
      }));
      joinMut.mutate({ session_id: t.session_id, subject_user_id: uid, mode: row.mode });
      return;
    }

    // Otherwise append. A teacher's list grows as more people join the impact,
    // so picking a second name adds to it rather than replacing the first.
    //
    // The visible text is rebuilt from the picked ids rather than appended to,
    // so picking Ben after typing "Ana, Be" gives "Ana, Ben" and not
    // "Ana, Be, Ben".
    const multi = row.mode === 'teaching';
    const ids = multi ? [...row.with_ids, otherId] : [otherId];
    edit(uid, {
      with_text: ids.map((id) => nameById[id] || (id === otherId ? otherName : '')).filter(Boolean).join(', '),
      with_ids: ids,
      ...(row.topic ? {} : { topic: t?.topic || '' }),
    });
  };

  const plannedCount = present.filter((p) => entryByUser[p.user_id]?.mode).length;

  if (q.isLoading) {
    return (
      <View style={styles.block}>
        <ActivityIndicator style={{ marginVertical: 12 }} color={colors.primary} />
      </View>
    );
  }
  if (q.isError) return null;

  return (
    <View style={styles.block}>
      <View style={styles.head}>
        <Ionicons name="people-outline" size={15} color={colors.primary} />
        <Text style={styles.headTitle}>Who's on Primetime</Text>
        <Text style={styles.headCount}>
          {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : `${plannedCount}/${present.length} set`}
        </Text>
      </View>

      {/* Super admins only, and only with more than one office to look at. */}
      {canSwitch && (
        <View style={styles.officeRow}>
          {offices.map((o) => {
            const on = o.id === office;
            return (
              <TouchableOpacity
                key={o.id}
                style={[styles.officeSeg, on && styles.officeSegOn]}
                onPress={() => setOffice(o.id)}
              >
                <Text style={[styles.officeTxt, on && styles.officeTxtOn]} numberOfLines={1}>
                  {o.name}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}
      {peeking && (
        <Text style={styles.peekNote}>
          Looking at another office — your own planner is unaffected.
        </Text>
      )}



      {/* The grouped picture of the day first — same rendering as Home. For
          an admin this is the readable version; the editable list underneath
          is the whole office. */}
      {daySessions.length > 0 && (
        <ImpactSummary
          sessions={daySessions}
          solo={daySolo}
          compact
          renderSessionAction={(s) => {
            if (!canEdit) return null;
            const candidates = candidatesFor(s.session_id);
            if (!candidates.length) return null;
            const isOpen = joinFor === s.session_id;
            return (
              <View>
                <TouchableOpacity style={styles.addBtn} onPress={() => setJoinFor(isOpen ? null : s.session_id)}>
                  <Ionicons name={isOpen ? 'close' : 'person-add-outline'} size={13} color={colors.primary} />
                  <Text style={styles.addBtnTxt}>{isOpen ? 'Cancel' : 'Add my person'}</Text>
                </TouchableOpacity>
                {isOpen && (
                  <View style={styles.candidates}>
                    {candidates.map((p) => (
                      <TouchableOpacity
                        key={p.user_id}
                        style={styles.candidate}
                        disabled={joinMut.isPending}
                        onPress={() => joinMut.mutate({ session_id: s.session_id, subject_user_id: p.user_id })}
                      >
                        <Text style={styles.candidateTxt}>{p.name}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>
            );
          }}
        />
      )}

      {/* Editing is the noisy part, so it folds away. Collapsed by default for
          admins, whose "team" is the entire office. */}
      <TouchableOpacity style={styles.editHead} onPress={() => setEditOpen(!editOpen)}>
        <Ionicons name={editOpen ? 'chevron-up' : 'chevron-down'} size={14} color={colors.textMuted} />
        <Text style={styles.editHeadTxt}>
          {editOpen ? 'Hide' : 'Set'} my team's Primetime
        </Text>
        <Text style={styles.editHeadCount}>{plannedCount}/{present.length}</Text>
      </TouchableOpacity>

      {editOpen && (present.length === 0 ? (
        <Text style={styles.muted}>Nobody on your team is in on this day.</Text>
      ) : (
        present.map((p) => (
          <PersonRow
            key={p.user_id}
            person={p}
            row={rowFor(p.user_id)}
            editable={canEdit}
            styles={styles}
            colors={colors}
            onEdit={(patch) => edit(p.user_id, patch)}
            onBlurRow={() => flushOne(p.user_id)}
            peopleMatching={(t) => peopleMatching(t, p.user_id)}
            topicsMatching={(t) => topicsMatching(t, p.user_id)}
            teachingToday={teachingToday}
            onPickTeacher={(id, name) => pickTeacher(p.user_id, id, name)}
            onPickTopic={(topic, id, name) => pickTopic(p.user_id, topic, id, name)}
            onOpenPlanner={() =>
              router.push(`/weekly-planner?user_id=${p.user_id}&week=${week}&day=${dayIndex}` as any)
            }
          />
        ))
      ))}

      {absent.length > 0 && (
        <View style={styles.absentRow}>
          <Ionicons name="remove-circle-outline" size={13} color={colors.textMuted} />
          <Text style={styles.absentTxt}>
            Absent: {absent.map((p) => p.name).join(', ')}
          </Text>
        </View>
      )}

    </View>
  );
}

/** One person's Primetime row for the day being planned. */
function PersonRow({
  person, row, editable, styles, colors, onEdit, onBlurRow, onOpenPlanner,
  peopleMatching, topicsMatching, teachingToday, onPickTeacher, onPickTopic,
}: {
  person: PrimetimePerson;
  row: RowDraft;
  editable: boolean;
  styles: any;
  colors: any;
  onEdit: (patch: Partial<RowDraft>) => void;
  onBlurRow: () => void;
  onOpenPlanner: () => void;
  peopleMatching: (text: string) => PrimetimePerson[];
  topicsMatching: (text: string) => { user_id: string; name: string; topic: string }[];
  teachingToday: Record<string, { topic: string; session_id: string; name: string }>;
  onPickTeacher: (teacherId: string, teacherName: string) => void;
  onPickTopic: (topic: string, teacherId: string, teacherName: string) => void;
}) {
  // Which field is open for suggestions. Only one at a time, and only while
  // focused, so the row doesn't grow a dropdown the moment it's rendered.
  const [focus, setFocus] = useState<null | 'topic' | 'with'>(null);

  // Closing the list has to be DELAYED. onBlur fires the instant a suggestion
  // is touched, so clearing focus synchronously tore the list off the screen
  // before the tap could land on it — the row just appeared to refresh with
  // nothing filled in. The delay is what gives onPress time to land.
  const closeTimer = useRef<any>(null);
  const closeSuggestions = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setFocus(null), 200);
  };
  const openSuggestions = (which: 'topic' | 'with') => {
    clearTimeout(closeTimer.current);
    setFocus(which);
  };
  useEffect(() => () => clearTimeout(closeTimer.current), []);

  const pick = (teacherId: string, teacherName: string) => {
    clearTimeout(closeTimer.current);
    setFocus(null);
    onPickTeacher(teacherId, teacherName);
  };

  const takeTopic = (topic: string, teacherId: string, teacherName: string) => {
    clearTimeout(closeTimer.current);
    setFocus(null);
    onPickTopic(topic, teacherId, teacherName);
  };

  const nameHits = focus === 'with' ? peopleMatching(row.with_text) : [];
  const topicHits = focus === 'topic' ? topicsMatching(row.topic) : [];

  return (
    <View style={styles.person}>
      <View style={styles.personHead}>
        <TouchableOpacity onPress={onOpenPlanner} style={styles.nameBtn} hitSlop={{ top: 6, bottom: 6 }}>
          <Text style={styles.personName} numberOfLines={1}>{person.name || 'Unnamed'}</Text>
          <Ionicons name="open-outline" size={12} color={colors.textMuted} />
        </TouchableOpacity>
        {!!person.left_on && <Text style={styles.leftTag}>leaving {person.left_on.slice(5)}</Text>}
      </View>

      <View style={styles.modeRow}>
        {MODES.map((m) => {
          const on = row.mode === m.key;
          return (
            <TouchableOpacity
              key={m.key}
              disabled={!editable}
              // Tapping the active mode clears the row — an empty toggle is how
              // you say "nothing planned".
              onPress={() => onEdit({ mode: on ? null : m.key })}
              style={[styles.modeBtn, on && styles.modeBtnOn, !editable && styles.modeBtnDisabled]}
            >
              <Ionicons name={m.icon} size={12} color={on ? colors.onPrimary : colors.textMuted} />
              <Text style={[styles.modeTxt, on && styles.modeTxtOn]}>{m.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {row.mode && (
        <View style={styles.fields}>
          <TextInput
            style={[styles.input, !editable && styles.inputRO]}
            editable={editable}
            value={row.topic}
            onChangeText={(v) => onEdit({ topic: v })}
            onFocus={() => openSuggestions('topic')}
            onBlur={() => { closeSuggestions(); onBlurRow(); }}
            placeholder="Topic"
            placeholderTextColor={colors.textMuted}
          />
          {/* Type "clos" and the topics already running today come up, with
              whoever is running them. Picking one joins their session. */}
          {topicHits.length > 0 && (
            <View style={styles.suggest}>
              {topicHits.map((t) => (
                <TouchableOpacity
                  key={`${t.user_id}-${t.topic}`}
                  style={styles.suggestRow}
                  // onPress, not onPressIn — touch-down fires when you're only
                  // reaching past the list, and this overwrites the topic box.
                  // closeSuggestions()'s delay keeps the row alive for the tap.
                  onPress={() => takeTopic(t.topic, t.user_id, t.name)}
                >
                  <Ionicons name="megaphone-outline" size={12} color={colors.primary} />
                  <Text style={styles.suggestMain} numberOfLines={1}>{t.topic}</Text>
                  <Text style={styles.suggestSub} numberOfLines={1}>{t.name}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          <TextInput
            style={[styles.input, !editable && styles.inputRO]}
            editable={editable}
            value={row.with_text}
            onChangeText={(v) => onEdit({ with_text: v })}
            onFocus={() => openSuggestions('with')}
            onBlur={() => { closeSuggestions(); onBlurRow(); }}
            placeholder={WITH_LABEL[row.mode]}
            placeholderTextColor={colors.textMuted}
          />
          {/* Start typing a name and the office comes up, anyone already
              teaching first. Picking them pulls their topic across. */}
          {nameHits.length > 0 && (
            <View style={styles.suggest}>
              {nameHits.map((p) => {
                const t = teachingToday[p.user_id];
                return (
                  <TouchableOpacity
                    key={p.user_id}
                    style={styles.suggestRow}
                    // onPress — see the topic list above.
                    onPress={() => pick(p.user_id, p.name)}
                  >
                    <Ionicons
                      name={t ? 'megaphone-outline' : 'person-outline'}
                      size={12}
                      color={t ? colors.primary : colors.textMuted}
                    />
                    <Text style={styles.suggestMain} numberOfLines={1}>{p.name}</Text>
                    {!!t?.topic && (
                      <Text style={styles.suggestSub} numberOfLines={1}>running {t.topic}</Text>
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const createStyles = (c: any) => StyleSheet.create({
  block: { marginTop: 10, marginBottom: 4 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  headTitle: { fontFamily: fonts.bodySemibold, fontSize: 12.5, color: c.text, flex: 1 },
  headCount: { fontFamily: fonts.body, fontSize: 11, color: c.textMuted },
  muted: { fontFamily: fonts.body, fontSize: 12, color: c.textMuted, paddingVertical: 6 },

  officeRow: { flexDirection: 'row', gap: 3, backgroundColor: c.surfaceAlt, borderRadius: 9, padding: 3, marginBottom: 8 },
  officeSeg: { flex: 1, paddingVertical: 6, paddingHorizontal: 8, borderRadius: 7, alignItems: 'center' },
  officeSegOn: { backgroundColor: c.background },
  officeTxt: { fontFamily: fonts.bodySemibold, fontSize: 11.5, color: c.textMuted },
  officeTxtOn: { color: c.primary },
  peekNote: { fontFamily: fonts.body, fontSize: 10.5, color: c.textMuted, fontStyle: 'italic', marginBottom: 8 },

  person: { backgroundColor: c.surfaceAlt, borderRadius: 10, padding: 10, marginBottom: 6 },
  personHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 },
  nameBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, flex: 1 },
  personName: { fontFamily: fonts.bodySemibold, fontSize: 13, color: c.text },
  leftTag: { fontFamily: fonts.body, fontSize: 10, color: c.textMuted, fontStyle: 'italic' },

  modeRow: { flexDirection: 'row', gap: 4 },
  modeBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3, paddingVertical: 6, borderRadius: 7, backgroundColor: c.background },
  modeBtnOn: { backgroundColor: c.primary },
  modeBtnDisabled: { opacity: 0.6 },
  modeTxt: { fontFamily: fonts.bodySemibold, fontSize: 10.5, color: c.textMuted },
  modeTxtOn: { color: c.onPrimary },

  suggest: { backgroundColor: c.background, borderWidth: 1, borderColor: c.border, borderRadius: 7, overflow: 'hidden' },
  suggestRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 7, paddingHorizontal: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  suggestMain: { fontFamily: fonts.bodySemibold, fontSize: 11.5, color: c.text, flexShrink: 1 },
  suggestSub: { fontFamily: fonts.body, fontSize: 10.5, color: c.textMuted, flex: 1, textAlign: 'right' },

  fields: { marginTop: 7, gap: 5 },
  input: { backgroundColor: c.background, borderWidth: 1, borderColor: c.border, borderRadius: 7, paddingHorizontal: 9, paddingVertical: 7, fontFamily: fonts.body, fontSize: 12, color: c.text },
  inputRO: { opacity: 0.7 },

  absentRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2, paddingVertical: 4 },
  absentTxt: { fontFamily: fonts.body, fontSize: 11, color: c.textMuted, flex: 1 },

  editHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, marginBottom: 6, paddingVertical: 4 },
  editHeadTxt: { fontFamily: fonts.bodySemibold, fontSize: 11.5, color: c.text, flex: 1 },
  editHeadCount: { fontFamily: fonts.body, fontSize: 11, color: c.textMuted },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', marginTop: 8, paddingVertical: 5, paddingHorizontal: 9, borderRadius: 7, borderWidth: 1, borderColor: c.border },
  addBtnTxt: { fontFamily: fonts.bodySemibold, fontSize: 11, color: c.primary },
  candidates: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 7 },
  candidate: { paddingVertical: 5, paddingHorizontal: 9, borderRadius: 999, backgroundColor: c.background },
  candidateTxt: { fontFamily: fonts.body, fontSize: 11.5, color: c.text },
});
