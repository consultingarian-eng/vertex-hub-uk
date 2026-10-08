/**
 * GoalBuilder — the guided, step-by-step goal-setting flow for the Monthly
 * Goal Planner. Replaces the old "fill each box in" 6-cell grid.
 *
 * It teaches the org's methodology first (why goals matter → KPIs vs Rocks →
 * SMART), then walks the user through picking 4–5 KPIs (each a number + a
 * deadline + a reward) and 2–3 Rocks (did-I/didn't-I tasks). All edits flow up
 * through `onChange` into the planner draft, which autosaves.
 *
 * Data lives in `goals` (v2 shape): { version, kpis[], rocks[], vision }.
 * Teaching steps are shown once (AsyncStorage flag) with a "Replay" link.
 * When `canEdit` is false (locked / someone else's planner) this renders a
 * read-only summary only.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useColors } from '../../theme/ThemeContext';
import { apiService } from '../../api/client';
import { haptics } from '../../utils/haptics';

// ── Types ───────────────────────────────────────────────────────────────
export type Horizon = 'short' | 'medium' | 'long';
export interface Kpi { id: string; name: string; target: string; horizon: Horizon; reward: string; smart_ok: boolean }
export interface Rock { id: string; name: string; horizon: Horizon; reward: string; done: boolean }
export interface GoalsV2 { version: number; kpis: Kpi[]; rocks: Rock[]; vision: string }

// A planner's goals are v2 (structured) once they carry a version / kpis key.
// Legacy planners (six free-text strings) are handled by the old grid.
export function isV2Goals(goals: any): boolean {
  return !!goals && (goals.version === 2 || Array.isArray(goals.kpis));
}

const TUTORIAL_FLAG = 'goalTutorialSeenV1';
const HORIZONS: { key: Horizon; short: string; long: string }[] = [
  { key: 'short', short: '1 mo', long: '1 month' },
  { key: 'medium', short: '3 mo', long: '3 months' },
  { key: 'long', short: '6 mo', long: '6 months' },
];
const horizonLabel = (h: Horizon) => HORIZONS.find((x) => x.key === h)?.long || '1 month';

const genId = () => `g-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const emptyGoals = (): GoalsV2 => ({ version: 2, kpis: [], rocks: [], vision: '' });

// KPI count → recommended Rock count (4 KPIs → 3 rocks, 5+ → 2). 7 total.
const recommendedRocks = (kpiCount: number) => (kpiCount >= 5 ? 2 : 3);

// Steps: 0-2 teach, 3 pick KPIs, 4 pick Rocks, 5 review.
const FIRST_BUILD_STEP = 3;
const LAST_STEP = 5;

interface Props {
  goals: GoalsV2 | any;
  canEdit: boolean;
  onChange: (goals: GoalsV2) => void;
}

export function GoalBuilder({ goals: goalsIn, canEdit, onChange }: Props) {
  const colors = useColors();
  const s = useMemo(() => createS(colors), [colors]);

  const goals: GoalsV2 = useMemo(
    () => ({ version: 2, kpis: goalsIn?.kpis || [], rocks: goalsIn?.rocks || [], vision: goalsIn?.vision || '' }),
    [goalsIn]
  );
  const hasContent = goals.kpis.length > 0 || goals.rocks.length > 0 || !!goals.vision.trim();

  const menuQ = useQuery({
    queryKey: ['planner-goal-menu'],
    queryFn: () => apiService.getPlannerGoalMenu().then((r) => r.data),
    staleTime: 1000 * 60 * 30,
  });
  const kpiMenu: string[] = menuQ.data?.kpis || [];
  const rockMenu: string[] = menuQ.data?.rock_suggestions || [];

  // Mode: show the compact summary by default when goals already exist; open
  // the wizard for a fresh planner or when the user taps Edit.
  const [editing, setEditing] = useState(!hasContent && canEdit);
  const [step, setStep] = useState(FIRST_BUILD_STEP);

  // Decide the opening step once the tutorial flag resolves. Returning users
  // (or planners already in progress) skip straight to building.
  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(TUTORIAL_FLAG)
      .then((seen) => {
        if (!alive) return;
        setStep(seen || hasContent ? FIRST_BUILD_STEP : 0);
      })
      .catch(() => setStep(hasContent ? FIRST_BUILD_STEP : 0));
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const markTutorialSeen = () => { AsyncStorage.setItem(TUTORIAL_FLAG, '1').catch(() => {}); };

  // ── Mutators (write the whole goals object up) ──────────────────────────
  const commit = (next: Partial<GoalsV2>) => onChange({ ...emptyGoals(), ...goals, ...next });
  const setKpis = (kpis: Kpi[]) => commit({ kpis });
  const setRocks = (rocks: Rock[]) => commit({ rocks });

  const addKpi = (name: string) => {
    const nm = name.trim();
    if (!nm) return;
    if (goals.kpis.some((k) => k.name.toLowerCase() === nm.toLowerCase())) return;
    haptics.light();
    setKpis([...goals.kpis, { id: genId(), name: nm, target: '', horizon: 'short', reward: '', smart_ok: false }]);
  };
  const updateKpi = (id: string, patch: Partial<Kpi>) =>
    setKpis(goals.kpis.map((k) => (k.id === id ? { ...k, ...patch } : k)));
  const removeKpi = (id: string) => { haptics.light(); setKpis(goals.kpis.filter((k) => k.id !== id)); };

  const addRock = (name: string) => {
    const nm = name.trim();
    if (!nm) return;
    if (goals.rocks.some((r) => r.name.toLowerCase() === nm.toLowerCase())) return;
    haptics.light();
    setRocks([...goals.rocks, { id: genId(), name: nm, horizon: 'short', reward: '', done: false }]);
  };
  const updateRock = (id: string, patch: Partial<Rock>) =>
    setRocks(goals.rocks.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const removeRock = (id: string) => { haptics.light(); setRocks(goals.rocks.filter((r) => r.id !== id)); };

  // ── Read-only / summary render ──────────────────────────────────────────
  if (!editing) {
    return (
      <GoalSummary
        goals={goals}
        canEdit={canEdit}
        onEdit={() => { setEditing(true); setStep(FIRST_BUILD_STEP); }}
        onToggleDone={canEdit ? (id: string, done: boolean) => updateRock(id, { done }) : undefined}
        s={s}
        colors={colors}
      />
    );
  }

  // ── Wizard ──────────────────────────────────────────────────────────────
  const kpiCount = goals.kpis.length;
  const recRocks = recommendedRocks(kpiCount);

  const goNext = () => {
    haptics.tap();
    if (step === 2) markTutorialSeen();
    setStep((v) => Math.min(LAST_STEP, v + 1));
  };
  const goBack = () => { haptics.tap(); setStep((v) => Math.max(0, v - 1)); };
  const finish = () => { haptics.success?.(); setEditing(false); };

  return (
    <View>
      {/* Progress dots */}
      <View style={s.dots}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <View key={i} style={[s.dot, i === step && s.dotActive, i < step && s.dotDone]} />
        ))}
      </View>

      {step === 0 && <StepWhy s={s} colors={colors} />}
      {step === 1 && <StepTypes s={s} colors={colors} />}
      {step === 2 && <StepSmart s={s} colors={colors} />}

      {step === 3 && (
        <StepPickKpis
          s={s} colors={colors}
          kpis={goals.kpis} menu={kpiMenu} loading={menuQ.isLoading}
          onAdd={addKpi} onUpdate={updateKpi} onRemove={removeKpi}
        />
      )}
      {step === 4 && (
        <StepPickRocks
          s={s} colors={colors}
          rocks={goals.rocks} menu={rockMenu} loading={menuQ.isLoading}
          kpiCount={kpiCount} recRocks={recRocks}
          onAdd={addRock} onUpdate={updateRock} onRemove={removeRock}
        />
      )}
      {step === 5 && (
        <StepReview
          s={s} colors={colors} goals={goals}
          onToggleSmart={(id: string, v: boolean) => updateKpi(id, { smart_ok: v })}
          onVision={(v: string) => commit({ vision: v })}
        />
      )}

      {/* Nav */}
      <View style={s.nav}>
        {step > 0 ? (
          <TouchableOpacity style={s.navBack} onPress={goBack}>
            <Ionicons name="chevron-back" size={16} color={colors.textSecondary} />
            <Text style={s.navBackText}>Back</Text>
          </TouchableOpacity>
        ) : (
          <View style={{ flex: 1 }} />
        )}

        {step < LAST_STEP ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            {step < FIRST_BUILD_STEP && (
              <TouchableOpacity onPress={() => { haptics.tap(); markTutorialSeen(); setStep(FIRST_BUILD_STEP); }}>
                <Text style={s.skipText}>Skip intro</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={s.navNext} onPress={goNext}>
              <Text style={s.navNextText}>{step === 2 ? 'Start building' : 'Next'}</Text>
              <Ionicons name="chevron-forward" size={16} color={colors.onPrimary} />
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity style={s.navNext} onPress={finish}>
            <Ionicons name="checkmark" size={16} color={colors.onPrimary} />
            <Text style={s.navNextText}>Done</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Replay tutorial link on build steps */}
      {step >= FIRST_BUILD_STEP && (
        <TouchableOpacity style={s.replay} onPress={() => { haptics.tap(); setStep(0); }}>
          <Ionicons name="refresh" size={12} color={colors.textMuted} />
          <Text style={s.replayText}>Replay the intro</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ── Teaching steps ────────────────────────────────────────────────────────
function StepWhy({ s, colors }: any) {
  return (
    <View>
      <Text style={s.stepKicker}>STEP 1 OF 3 · WHY</Text>
      <Text style={s.stepTitle}>Why bother with goals?</Text>
      <Text style={s.body}>
        Working with no goals is like watching a match with no goalposts — 23 people running
        around, nothing to aim at. Goals give the day a point and pull you forward.
      </Text>
      <View style={[s.callout, { borderColor: colors.primary, backgroundColor: `${colors.primary}12` }]}>
        <Text style={[s.calloutTitle, { color: colors.primary }]}>“Get fit” vs “run a 5K by June 1st”</Text>
        <Text style={s.calloutBody}>
          Same intention — but only one tells you what to do on Monday morning. A goal with a
          number and a deadline pulls you forward; a vague wish just sits there. That’s the
          difference the rest of this builder makes to your month.
        </Text>
      </View>
      <Text style={s.hint}>Next we'll cover the two kinds of goals you'll set.</Text>
    </View>
  );
}

function StepTypes({ s, colors }: any) {
  return (
    <View>
      <Text style={s.stepKicker}>STEP 2 OF 3 · THE TWO TYPES</Text>
      <Text style={s.stepTitle}>KPIs vs Rocks</Text>

      <View style={[s.typeCard, { borderColor: colors.primary }]}>
        <View style={s.typeHead}>
          <Ionicons name="stats-chart" size={16} color={colors.primary} />
          <Text style={[s.typeTitle, { color: colors.primary }]}>KPIs — the numbers</Text>
        </View>
        <Text style={s.body}>
          Anything measurable: sign-ups, retention %, initial appointments booked, first-day-ons, personal best.
          If you can put a number on it, it's a KPI. <Text style={s.bold}>Pick 4–5.</Text>
        </Text>
      </View>

      <View style={[s.typeCard, { borderColor: colors.green }]}>
        <View style={s.typeHead}>
          <Ionicons name="checkbox" size={16} color={colors.green} />
          <Text style={[s.typeTitle, { color: colors.green }]}>Rocks — did I / didn't I</Text>
        </View>
        <Text style={s.body}>
          A task you tick off at month-end: visit another office, run 2 team meetings, finish a
          book, run a sector. Not a routine — a thing you did or you didn't. <Text style={s.bold}>Pick 2–3.</Text>
        </Text>
      </View>

      <View style={[s.callout, { borderColor: colors.border, backgroundColor: colors.surfaceAlt }]}>
        <Text style={s.calloutBody}>
          <Text style={s.bold}>4 KPIs → 3 Rocks. 5 KPIs → 2 Rocks.</Text> Seven goals in total.
        </Text>
      </View>
    </View>
  );
}

function StepSmart({ s, colors }: any) {
  const rows = [
    ['S', 'Specific', 'Say exactly what — “hit a 6-sign-up day”, not “do well”.'],
    ['M', 'Measurable', 'A number you can check off — like a doctor reads your bloods.'],
    ['A', 'Attainable', 'A stretch, but reachable in your role right now.'],
    ['R', 'Realistic', 'Big is fine; 1,000 sign-ups solo in a week isn’t.'],
    ['T', 'Time-based', 'A deadline creates urgency — “by the 20th”.'],
  ];
  return (
    <View>
      <Text style={s.stepKicker}>STEP 3 OF 3 · THE TEST</Text>
      <Text style={s.stepTitle}>Make every goal SMART</Text>
      {rows.map(([l, t, d]) => (
        <View key={l} style={s.smartRow}>
          <View style={[s.smartLetter, { backgroundColor: colors.primary }]}><Text style={s.smartLetterText}>{l}</Text></View>
          <View style={{ flex: 1 }}>
            <Text style={s.smartTitle}>{t}</Text>
            <Text style={s.smartDesc}>{d}</Text>
          </View>
        </View>
      ))}
      <View style={[s.callout, { borderColor: colors.red, backgroundColor: `${colors.red}10` }]}>
        <Text style={s.calloutBody}>
          <Text style={[s.bold, { color: colors.red }]}>Weak goals:</Text> “get better”, “be more confident”,
          “be on time”. They're feelings or baseline — you can't measure them.
        </Text>
      </View>
    </View>
  );
}

// ── Build steps ───────────────────────────────────────────────────────────
function PickerChips({ s, colors, menu, chosen, loading, onPick }: any) {
  if (loading) return <Text style={s.hint}>Loading suggestions…</Text>;
  if (!menu.length) return null;
  return (
    <View style={s.chips}>
      {menu.map((m: string) => {
        const picked = chosen.some((c: string) => c.toLowerCase() === m.toLowerCase());
        return (
          <TouchableOpacity
            key={m}
            style={[s.chip, picked && { backgroundColor: `${colors.primary}18`, borderColor: colors.primary }]}
            onPress={() => onPick(m)}
            disabled={picked}
          >
            <Ionicons name={picked ? 'checkmark' : 'add'} size={13} color={picked ? colors.primary : colors.textSecondary} />
            <Text style={[s.chipText, picked && { color: colors.primary, fontWeight: '800' }]}>{m}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function AddOwn({ s, colors, placeholder, onAdd }: any) {
  const [val, setVal] = useState('');
  return (
    <View style={s.addOwnRow}>
      <TextInput
        style={s.addOwnInput}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        value={val}
        onChangeText={setVal}
        onSubmitEditing={() => { onAdd(val); setVal(''); }}
        returnKeyType="done"
      />
      <TouchableOpacity style={s.addOwnBtn} onPress={() => { onAdd(val); setVal(''); }} disabled={!val.trim()}>
        <Ionicons name="add" size={16} color={val.trim() ? colors.onPrimary : colors.textMuted} />
      </TouchableOpacity>
    </View>
  );
}

function HorizonToggle({ s, colors, value, onChange }: any) {
  return (
    <View style={s.horizonRow}>
      {HORIZONS.map((h) => {
        const sel = value === h.key;
        return (
          <TouchableOpacity
            key={h.key}
            style={[s.horizonPill, sel && { backgroundColor: colors.primary, borderColor: colors.primary }]}
            onPress={() => { haptics.light(); onChange(h.key); }}
          >
            <Text style={[s.horizonText, sel && { color: colors.onPrimary }]}>{h.short}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function StepPickKpis({ s, colors, kpis, menu, loading, onAdd, onUpdate, onRemove }: any) {
  const count = kpis.length;
  const tone = count >= 4 && count <= 5 ? colors.green : colors.yellow;
  return (
    <View>
      <Text style={s.stepKicker}>YOUR NUMBERS</Text>
      <Text style={s.stepTitle}>Pick your KPIs</Text>
      <Text style={[s.counter, { color: tone }]}>{count} selected · aim for 4–5</Text>

      {kpis.map((k: Kpi) => (
        <View key={k.id} style={s.goalRow}>
          <View style={s.goalRowHead}>
            <Text style={s.goalName}>{k.name}</Text>
            <TouchableOpacity onPress={() => onRemove(k.id)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close-circle" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          <View style={s.fieldRow}>
            <Text style={s.fieldLabel}>Target</Text>
            <TextInput
              style={s.targetInput}
              placeholder="e.g. 40" placeholderTextColor={colors.textMuted}
              keyboardType="numeric"
              value={k.target}
              onChangeText={(v) => onUpdate(k.id, { target: v })}
            />
            <HorizonToggle s={s} colors={colors} value={k.horizon} onChange={(h: Horizon) => onUpdate(k.id, { horizon: h })} />
          </View>
          <TextInput
            style={s.rewardInput}
            placeholder="Reward if you hit it (optional)" placeholderTextColor={colors.textMuted}
            value={k.reward}
            onChangeText={(v) => onUpdate(k.id, { reward: v })}
          />
        </View>
      ))}

      <Text style={s.pickLabel}>Tap to add</Text>
      <PickerChips s={s} colors={colors} menu={menu} chosen={kpis.map((k: Kpi) => k.name)} loading={loading} onPick={onAdd} />
      <AddOwn s={s} colors={colors} placeholder="Add your own KPI…" onAdd={onAdd} />
    </View>
  );
}

function StepPickRocks({ s, colors, rocks, menu, loading, kpiCount, recRocks, onAdd, onUpdate, onRemove }: any) {
  const count = rocks.length;
  const tone = count === recRocks ? colors.green : colors.yellow;
  return (
    <View>
      <Text style={s.stepKicker}>YOUR TASKS</Text>
      <Text style={s.stepTitle}>Pick your Rocks</Text>
      <Text style={[s.counter, { color: tone }]}>
        {count} selected · {kpiCount >= 4 ? `you picked ${kpiCount} KPIs, aim for ${recRocks}` : 'aim for 2–3'}
      </Text>

      {rocks.map((r: Rock) => (
        <View key={r.id} style={s.goalRow}>
          <View style={s.goalRowHead}>
            <Text style={s.goalName}>{r.name}</Text>
            <TouchableOpacity onPress={() => onRemove(r.id)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close-circle" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          <View style={s.fieldRow}>
            <Text style={s.fieldLabel}>By</Text>
            <HorizonToggle s={s} colors={colors} value={r.horizon} onChange={(h: Horizon) => onUpdate(r.id, { horizon: h })} />
          </View>
          <TextInput
            style={s.rewardInput}
            placeholder="Reward if you do it (optional)" placeholderTextColor={colors.textMuted}
            value={r.reward}
            onChangeText={(v) => onUpdate(r.id, { reward: v })}
          />
        </View>
      ))}

      <Text style={s.pickLabel}>Tap to add</Text>
      <PickerChips s={s} colors={colors} menu={menu} chosen={rocks.map((r: Rock) => r.name)} loading={loading} onPick={onAdd} />
      <AddOwn s={s} colors={colors} placeholder="Add your own Rock…" onAdd={onAdd} />
    </View>
  );
}

function StepReview({ s, colors, goals, onToggleSmart, onVision }: any) {
  const total = goals.kpis.length + goals.rocks.length;
  return (
    <View>
      <Text style={s.stepKicker}>REVIEW · {total} GOAL{total === 1 ? '' : 'S'}</Text>
      <Text style={s.stepTitle}>Tick each one that's SMART</Text>
      <Text style={s.hint}>Specific, Measurable, Attainable, Realistic, Time-based.</Text>

      {goals.kpis.map((k: Kpi) => (
        <TouchableOpacity key={k.id} style={s.reviewRow} onPress={() => onToggleSmart(k.id, !k.smart_ok)}>
          <Ionicons name={k.smart_ok ? 'checkbox' : 'square-outline'} size={20} color={k.smart_ok ? colors.green : colors.textMuted} />
          <View style={{ flex: 1 }}>
            <Text style={s.reviewName}>
              <Text style={{ color: colors.primary }}>KPI</Text>  {k.name}
              {k.target ? <Text style={s.reviewMeta}>  → {k.target}</Text> : null}
            </Text>
            <Text style={s.reviewSub}>{horizonLabel(k.horizon)}{k.reward ? ` · 🎁 ${k.reward}` : ''}</Text>
          </View>
        </TouchableOpacity>
      ))}
      {goals.rocks.map((r: Rock) => (
        <View key={r.id} style={s.reviewRow}>
          <Ionicons name="ellipse" size={12} color={colors.green} style={{ marginLeft: 4, marginRight: 4 }} />
          <View style={{ flex: 1 }}>
            <Text style={s.reviewName}><Text style={{ color: colors.green }}>ROCK</Text>  {r.name}</Text>
            <Text style={s.reviewSub}>{horizonLabel(r.horizon)}{r.reward ? ` · 🎁 ${r.reward}` : ''}</Text>
          </View>
        </View>
      ))}

      <Text style={[s.pickLabel, { marginTop: 14 }]}>6-month vision (optional)</Text>
      <TextInput
        style={s.visionInput}
        multiline
        placeholder="Where do you want to be in 6 months?" placeholderTextColor={colors.textMuted}
        value={goals.vision}
        onChangeText={onVision}
      />
    </View>
  );
}

// ── Compact summary (default view once goals exist / read-only) ────────────
function GoalSummary({ goals, canEdit, onEdit, onToggleDone, s, colors }: any) {
  const total = goals.kpis.length + goals.rocks.length;
  if (total === 0 && !goals.vision) {
    return (
      <View style={s.emptySummary}>
        <Text style={s.hint}>No goals set for this month yet.</Text>
        {canEdit && (
          <TouchableOpacity style={s.editBtn} onPress={onEdit}>
            <Ionicons name="flag" size={14} color={colors.onPrimary} />
            <Text style={s.editBtnText}>Set your goals</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }
  return (
    <View>
      {goals.kpis.map((k: Kpi) => (
        <View key={k.id} style={s.sumRow}>
          <View style={[s.sumTag, { backgroundColor: `${colors.primary}18` }]}><Text style={[s.sumTagText, { color: colors.primary }]}>KPI</Text></View>
          <View style={{ flex: 1 }}>
            <Text style={s.sumName}>{k.name}{k.target ? <Text style={s.reviewMeta}>  → {k.target}</Text> : null}</Text>
            <Text style={s.sumSub}>{horizonLabel(k.horizon)}{k.reward ? ` · 🎁 ${k.reward}` : ''}</Text>
          </View>
        </View>
      ))}
      {goals.rocks.map((r: Rock) => (
        <TouchableOpacity
          key={r.id}
          style={s.sumRow}
          activeOpacity={onToggleDone ? 0.6 : 1}
          onPress={onToggleDone ? () => onToggleDone(r.id, !r.done) : undefined}
        >
          <View style={[s.sumTag, { backgroundColor: `${colors.green}22` }]}><Text style={[s.sumTagText, { color: colors.green }]}>ROCK</Text></View>
          <View style={{ flex: 1 }}>
            <Text style={[s.sumName, r.done && { textDecorationLine: 'line-through', color: colors.textMuted }]}>{r.name}</Text>
            <Text style={s.sumSub}>{horizonLabel(r.horizon)}{r.reward ? ` · 🎁 ${r.reward}` : ''}</Text>
          </View>
          {onToggleDone && (
            <Ionicons name={r.done ? 'checkmark-circle' : 'ellipse-outline'} size={22} color={r.done ? colors.green : colors.textMuted} />
          )}
        </TouchableOpacity>
      ))}
      {!!goals.vision && (
        <View style={s.visionSum}>
          <Text style={s.sumSub}>6-MONTH VISION</Text>
          <Text style={s.sumName}>{goals.vision}</Text>
        </View>
      )}
      {canEdit && (
        <TouchableOpacity style={s.editBtn} onPress={onEdit}>
          <Ionicons name="create-outline" size={14} color={colors.onPrimary} />
          <Text style={s.editBtnText}>Edit goals</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────
const createS = (colors: any) => StyleSheet.create({
  dots: { flexDirection: 'row', gap: 6, justifyContent: 'center', marginBottom: 14 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.border },
  dotActive: { backgroundColor: colors.primary, width: 20 },
  dotDone: { backgroundColor: colors.primary },
  stepKicker: { fontSize: 10, fontWeight: '900', color: colors.textMuted, letterSpacing: 0.8, marginBottom: 4 },
  stepTitle: { fontSize: 18, fontWeight: '900', color: colors.text, marginBottom: 8 },
  body: { fontSize: 13.5, color: colors.text, lineHeight: 20 },
  bold: { fontWeight: '800', color: colors.text },
  hint: { fontSize: 12, color: colors.textMuted, marginTop: 8, lineHeight: 17 },
  callout: { borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 12 },
  calloutTitle: { fontSize: 13, fontWeight: '900', marginBottom: 4 },
  calloutBody: { fontSize: 12.5, color: colors.text, lineHeight: 18 },
  typeCard: { borderWidth: 1.5, borderRadius: 12, padding: 12, marginTop: 10 },
  typeHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  typeTitle: { fontSize: 14, fontWeight: '900' },
  smartRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
  smartLetter: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  smartLetterText: { color: colors.onPrimary, fontWeight: '900', fontSize: 15 },
  smartTitle: { fontSize: 13.5, fontWeight: '800', color: colors.text },
  smartDesc: { fontSize: 12, color: colors.textSecondary, marginTop: 1, lineHeight: 16 },
  counter: { fontSize: 12, fontWeight: '800', marginBottom: 10 },
  goalRow: { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 10, marginBottom: 8 },
  goalRowHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  goalName: { fontSize: 14, fontWeight: '800', color: colors.text, flex: 1, marginRight: 8 },
  fieldRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  fieldLabel: { fontSize: 11, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase' },
  targetInput: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 10, fontSize: 13, fontWeight: '700', color: colors.text, minWidth: 70, textAlign: 'center' },
  rewardInput: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingVertical: 7, paddingHorizontal: 10, fontSize: 12.5, color: colors.text, marginTop: 8 },
  horizonRow: { flexDirection: 'row', gap: 5 },
  horizonPill: { paddingVertical: 5, paddingHorizontal: 9, borderRadius: 7, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  horizonText: { fontSize: 11.5, fontWeight: '800', color: colors.textSecondary },
  pickLabel: { fontSize: 11, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 6, marginBottom: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  chipText: { fontSize: 12, fontWeight: '600', color: colors.text },
  addOwnRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  addOwnInput: { flex: 1, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10, fontSize: 13, color: colors.text },
  addOwnBtn: { width: 38, height: 38, borderRadius: 8, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  reviewRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  reviewName: { fontSize: 13.5, fontWeight: '700', color: colors.text },
  reviewMeta: { fontWeight: '800', color: colors.textSecondary },
  reviewSub: { fontSize: 11.5, color: colors.textMuted, marginTop: 1 },
  visionInput: { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 10, fontSize: 13, color: colors.text, minHeight: 60, textAlignVertical: 'top' },
  nav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 },
  navBack: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  navBackText: { fontSize: 13, fontWeight: '700', color: colors.textSecondary },
  navNext: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10, backgroundColor: colors.primary },
  navNextText: { fontSize: 13, fontWeight: '800', color: colors.onPrimary },
  skipText: { fontSize: 12, fontWeight: '700', color: colors.textMuted },
  replay: { flexDirection: 'row', alignItems: 'center', gap: 4, justifyContent: 'center', marginTop: 12 },
  replayText: { fontSize: 11.5, color: colors.textMuted, fontWeight: '600' },
  emptySummary: { alignItems: 'flex-start', gap: 10 },
  editBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 9, paddingHorizontal: 14, borderRadius: 10, backgroundColor: colors.primary, alignSelf: 'flex-start', marginTop: 12 },
  editBtnText: { fontSize: 12.5, fontWeight: '800', color: colors.onPrimary },
  sumRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  sumTag: { paddingVertical: 2, paddingHorizontal: 7, borderRadius: 6 },
  sumTagText: { fontSize: 9.5, fontWeight: '900', letterSpacing: 0.4 },
  sumName: { fontSize: 13.5, fontWeight: '700', color: colors.text },
  sumSub: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  visionSum: { marginTop: 10, padding: 10, borderRadius: 8, backgroundColor: colors.surfaceAlt },
});
