/**
 * Daily Breakdown sheet — admin/leader taps the FAB on the Bells screen,
 * picks a date (default today), the backend pulls today's bells data +
 * week-to-date + same-day-last-week + the office weekly goal and asks
 * the AI to generate a punchy WhatsApp-ready summary the user can copy
 * directly into a WhatsApp group.
 */
import React, { useMemo, useState, useEffect } from 'react';
import { showAlert } from '../../utils/showAlert';
import { View, Text, StyleSheet, Modal, TouchableOpacity, ActivityIndicator, ScrollView, Platform, KeyboardAvoidingView, TextInput,  } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiService } from '../../api/client';
import { useColors } from '../../theme/ThemeContext';
import { toast } from '../../utils/toast';
import { useAuth } from '../../auth/AuthContext';
import { APP_LOCALE } from '../../utils/appTime';
import { appTodayISO } from './types';

// Today's calendar date in app (UK) time — not the phone's own zone, and not
// the UTC date — so "Today" / "Yesterday" match the office's day.
const fmtToday = (offset = 0) => appTodayISO(offset);

export default function DailyBreakdownSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [date, setDate] = useState<string>(fmtToday(0));
  const [text, setText] = useState<string>('');
  const [meta, setMeta] = useState<any | null>(null);
  const [promptEditorOpen, setPromptEditorOpen] = useState(false);

  const genMut = useMutation({
    mutationFn: () => apiService.generateDailyBreakdown(date).then((r) => r.data),
    onSuccess: (data: any) => {
      setText(data.text || '');
      setMeta(data.meta || null);
    },
    onError: (e: any) => {
      toast.error(e?.response?.data?.detail || 'Failed to generate breakdown');
    },
  });

  const copy = async () => {
    if (!text) return;
    try {
      await Clipboard.setStringAsync(text);
      toast.success('Copied — paste into WhatsApp');
    } catch {
      toast.error('Could not copy');
    }
  };

  const handleClose = () => {
    setText('');
    setMeta(null);
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <TouchableOpacity activeOpacity={1} onPress={handleClose} style={styles.overlay}>
          <TouchableOpacity activeOpacity={1} style={styles.sheet}>
            <View style={styles.handle} />

            <View style={styles.header}>
              <View style={{ flex: 1 }}>
                <Text style={styles.title}>End-of-Day Breakdown</Text>
                <Text style={styles.subtitle}>Today's wins · tomorrow's schedule · WhatsApp-ready</Text>
              </View>
              {isAdmin && (
                <TouchableOpacity
                  onPress={() => setPromptEditorOpen(true)}
                  style={styles.gearBtn}
                  testID="daily-breakdown-edit-prompt-btn"
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="settings-outline" size={18} color={colors.textMuted} />
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={handleClose} style={styles.closeBtn}>
                <Ionicons name="close" size={22} color={colors.textMuted} />
              </TouchableOpacity>
            </View>

            {/* Date selector — yesterday / today / specific */}
            <View style={styles.dateRow}>
              {[
                { key: 'yest', label: 'Yesterday', val: fmtToday(-1) },
                { key: 'today', label: 'Today', val: fmtToday(0) },
              ].map((p) => (
                <TouchableOpacity
                  key={p.key}
                  style={[styles.preset, date === p.val && styles.presetActive]}
                  onPress={() => setDate(p.val)}
                >
                  <Text style={[styles.presetText, date === p.val && styles.presetTextActive]}>{p.label}</Text>
                </TouchableOpacity>
              ))}
              <View style={styles.dateBadge}>
                <Ionicons name="calendar-outline" size={13} color={colors.textMuted} />
                <Text style={styles.dateBadgeText}>{new Date(date + 'T00:00:00Z').toLocaleDateString(APP_LOCALE, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}</Text>
              </View>
            </View>

            {/* Generate / Regenerate button */}
            <TouchableOpacity
              style={[styles.genBtn, genMut.isPending && { opacity: 0.6 }]}
              onPress={() => genMut.mutate()}
              disabled={genMut.isPending}
            >
              {genMut.isPending ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <Ionicons name={text ? 'refresh' : 'sparkles'} size={16} color={colors.onPrimary} />
              )}
              <Text style={styles.genBtnText}>{genMut.isPending ? 'Generating…' : (text ? 'Regenerate' : 'Generate Breakdown')}</Text>
            </TouchableOpacity>

            {/* Meta-info bar (goal progress + days left) */}
            {meta && (
              <View style={styles.metaBar}>
                <View style={styles.metaPill}>
                  <Ionicons name="cellular" size={12} color={colors.primary} />
                  <Text style={styles.metaText}>Today: <Text style={styles.metaBold}>{meta.today_sales}</Text></Text>
                </View>
                <View style={styles.metaPill}>
                  <Ionicons name="calendar" size={12} color={colors.textMuted} />
                  <Text style={styles.metaText}>Week: <Text style={styles.metaBold}>{meta.week_to_date_sales}</Text>{meta.weekly_goal > 0 && <Text>{` / ${meta.weekly_goal}`}</Text>}</Text>
                </View>
                {meta.weekly_goal > 0 && (
                  <View style={styles.metaPill}>
                    <Ionicons name="flag" size={12} color={meta.goal_remaining > 0 ? '#dc2626' : '#16a34a'} />
                    <Text style={[styles.metaText, { color: meta.goal_remaining > 0 ? '#dc2626' : '#16a34a' }]}>
                      {meta.goal_remaining > 0 ? `${meta.goal_remaining} to go · ${meta.days_left_in_week}d left` : 'GOAL HIT 🎯'}
                    </Text>
                  </View>
                )}
              </View>
            )}

            {/* Generated text output */}
            <ScrollView style={styles.outputScroll} contentContainerStyle={{ paddingBottom: 8 }}>
              {text ? (
                <View style={styles.output}>
                  <Text style={styles.outputText} selectable>
                    {text}
                  </Text>
                </View>
              ) : (
                <View style={styles.placeholder}>
                  <Ionicons name="sparkles-outline" size={28} color={colors.textMuted} />
                  <Text style={styles.placeholderTitle}>Ready when you are</Text>
                  <Text style={styles.placeholderSub}>
                    Tap Generate to roll up today's office bells, compare against the same day last week, and write a punchy WhatsApp message with shoutouts + tomorrow's schedule already attached.
                  </Text>
                </View>
              )}
            </ScrollView>

            {/* Copy button */}
            {text && (
              <TouchableOpacity style={styles.copyBtn} onPress={copy}>
                <Ionicons name="copy" size={16} color="#fff" />
                <Text style={styles.copyBtnText}>Copy to clipboard</Text>
              </TouchableOpacity>
            )}
          </TouchableOpacity>
        </TouchableOpacity>
      </KeyboardAvoidingView>

      {/* Admin-only: prompt editor modal */}
      {isAdmin && (
        <PromptEditor
          visible={promptEditorOpen}
          onClose={() => setPromptEditorOpen(false)}
        />
      )}
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// PromptEditor — admin-only. Lets the admin write free-form instructions
// that override the default prompt ("tone, what to include, what to avoid").
// Loads the saved override for this admin's office, lets them edit/save/reset.
// ─────────────────────────────────────────────────────────────────────────
function PromptEditor({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string>('');
  const [dirty, setDirty] = useState<boolean>(false);

  const settingsQuery = useQuery({
    queryKey: ['daily-breakdown-settings'],
    queryFn: () => apiService.getDailyBreakdownSettings().then((r) => r.data),
    enabled: visible,
    staleTime: 1000 * 5,
  });

  // Sync server data into the local draft whenever it loads (unless the admin
  // has actively typed something — don't clobber their WIP).
  useEffect(() => {
    if (!visible) return;
    if (settingsQuery.data && !dirty) {
      setDraft(settingsQuery.data.custom_instructions || '');
    }
  }, [settingsQuery.data, visible, dirty]);

  // When the modal closes, forget the dirty flag so reopening starts fresh.
  useEffect(() => {
    if (!visible) setDirty(false);
  }, [visible]);

  const saveMut = useMutation({
    mutationFn: (v: string) => apiService.saveDailyBreakdownSettings(v).then((r) => r.data),
    onSuccess: (data: any) => {
      queryClient.setQueryData(['daily-breakdown-settings'], data);
      setDirty(false);
      toast.success('Prompt saved — next generation will use your instructions.');
      onClose();
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Could not save prompt'),
  });
  const resetMut = useMutation({
    mutationFn: () => apiService.resetDailyBreakdownSettings().then((r) => r.data),
    onSuccess: (data: any) => {
      queryClient.setQueryData(['daily-breakdown-settings'], data);
      setDraft('');
      setDirty(false);
      toast.success('Prompt reset — baseline tone restored.');
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Could not reset prompt'),
  });

  const confirmReset = () => {
    showAlert(
      'Reset to default?',
      'This removes your custom instructions and restores the baseline prompt. You can always type new instructions again.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Reset', style: 'destructive', onPress: () => resetMut.mutate() },
      ],
    );
  };

  const close = () => {
    if (dirty) {
      showAlert(
        'Unsaved changes',
        'You haven\'t saved your edits yet. Close anyway?',
        [
          { text: 'Keep editing', style: 'cancel' },
          { text: 'Discard', style: 'destructive', onPress: () => { setDirty(false); onClose(); } },
        ],
      );
      return;
    }
    onClose();
  };

  const charCount = draft.length;
  const tooLong = charCount > 6000;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <TouchableOpacity activeOpacity={1} onPress={close} style={styles.overlay}>
          <TouchableOpacity activeOpacity={1} style={[styles.sheet, { height: '92%' }]}>
            <View style={styles.handle} />
            <View style={styles.header}>
              <View style={{ flex: 1 }}>
                <Text style={styles.title}>Edit Daily-Breakdown Prompt</Text>
                <Text style={styles.subtitle}>
                  Tell the AI exactly how you want tomorrow's messages to sound.
                </Text>
              </View>
              <TouchableOpacity onPress={close} style={styles.closeBtn}>
                <Ionicons name="close" size={22} color={colors.textMuted} />
              </TouchableOpacity>
            </View>

            {settingsQuery.isLoading ? (
              <View style={{ paddingVertical: 40, alignItems: 'center' }}>
                <ActivityIndicator color={colors.primary} />
              </View>
            ) : (
              <>
                <View style={styles.helpCard}>
                  <Ionicons name="bulb-outline" size={14} color={colors.primary} />
                  <Text style={styles.helpCardText}>
                    Write in plain English. The AI already knows the stats and tomorrow's schedule — use this space for <Text style={styles.b}>tone, what to include, what to avoid, which people to emphasise, forbidden phrases,</Text> etc. Leave blank to use the default prompt.
                  </Text>
                </View>

                <ScrollView
                  style={{ flex: 1, marginBottom: 10 }}
                  contentContainerStyle={{ paddingBottom: 8 }}
                  keyboardShouldPersistTaps="handled"
                >
                  <TextInput
                    value={draft}
                    onChangeText={(v) => { setDraft(v); if (!dirty) setDirty(true); }}
                    multiline
                    textAlignVertical="top"
                    placeholder={`e.g.\n• Keep it under 20 lines. No emojis in callouts, just names + numbers.\n• Always mention how we're tracking vs the weekly goal.\n• Don't use the word "crushed". Prefer "stepped up" or "delivered".\n• Call out any new starter who rang their first bell today with a graduation cap 🎓.\n• End every message with a question the team can answer in the group.`}
                    placeholderTextColor={colors.textMuted}
                    style={styles.bigInput}
                    testID="daily-breakdown-prompt-input"
                  />
                  <View style={styles.charRow}>
                    <Text style={[styles.charCount, tooLong && { color: '#dc2626' }]}>
                      {charCount.toLocaleString(APP_LOCALE)} / 6,000 chars
                    </Text>
                    {settingsQuery.data?.updated_by_name && (
                      <Text style={styles.updatedBy}>
                        Last edited by {settingsQuery.data.updated_by_name}
                      </Text>
                    )}
                  </View>
                </ScrollView>

                <View style={styles.footerRow}>
                  <TouchableOpacity
                    style={[styles.footerBtn, styles.footerBtnGhost]}
                    onPress={confirmReset}
                    disabled={resetMut.isPending}
                    testID="daily-breakdown-prompt-reset"
                  >
                    {resetMut.isPending ? (
                      <ActivityIndicator size="small" color={colors.textMuted} />
                    ) : (
                      <>
                        <Ionicons name="refresh" size={14} color={colors.textMuted} />
                        <Text style={styles.footerBtnGhostText}>Reset to default</Text>
                      </>
                    )}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.footerBtn, styles.footerBtnPrimary, (saveMut.isPending || tooLong) && { opacity: 0.55 }]}
                    onPress={() => saveMut.mutate(draft)}
                    disabled={saveMut.isPending || tooLong}
                    testID="daily-breakdown-prompt-save"
                  >
                    {saveMut.isPending ? (
                      <ActivityIndicator size="small" color={colors.onPrimary} />
                    ) : (
                      <>
                        <Ionicons name="checkmark" size={14} color={colors.onPrimary} />
                        <Text style={styles.footerBtnPrimaryText}>Save prompt</Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>
              </>
            )}
          </TouchableOpacity>
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.background, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 16, paddingBottom: 28, maxHeight: '88%' },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginBottom: 10 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
  title: { fontSize: 18, fontWeight: '900', color: colors.text },
  subtitle: { fontSize: 11, color: colors.textMuted, marginTop: 2, fontWeight: '600' },
  closeBtn: { padding: 6, marginLeft: 8 },

  dateRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' },
  preset: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  presetActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  presetText: { fontSize: 12, fontWeight: '800', color: colors.textSecondary },
  presetTextActive: { color: colors.onPrimary },
  dateBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  dateBadgeText: { fontSize: 11, color: colors.textSecondary, fontWeight: '700' },

  genBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: colors.primary, paddingVertical: 12, borderRadius: 12, marginBottom: 12 },
  genBtnText: { color: colors.onPrimary, fontSize: 14, fontWeight: '800', letterSpacing: 0.3 },

  metaBar: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  metaPill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  metaText: { fontSize: 11, color: colors.textSecondary, fontWeight: '700' },
  metaBold: { color: colors.text, fontWeight: '900', fontVariant: ['tabular-nums'] as any },

  outputScroll: { maxHeight: 360, marginBottom: 10 },
  output: { backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 14 },
  outputText: { fontSize: 13, lineHeight: 21, color: colors.text, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },

  placeholder: { alignItems: 'center', padding: 30, gap: 8, backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed' as any },
  placeholderTitle: { fontSize: 13, fontWeight: '800', color: colors.text },
  placeholderSub: { fontSize: 11, color: colors.textMuted, textAlign: 'center', lineHeight: 16, fontWeight: '600' },

  copyBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#16a34a', paddingVertical: 12, borderRadius: 12 },
  copyBtnText: { color: '#fff', fontSize: 14, fontWeight: '800' },

  // Prompt editor — header gear + editor modal
  gearBtn: { padding: 6, marginRight: 2 },
  b: { fontWeight: '800', color: colors.text },
  helpCard: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 12, marginBottom: 12, backgroundColor: `${colors.primary}12`, borderRadius: 12, borderWidth: 1, borderColor: `${colors.primary}33` },
  helpCardText: { flex: 1, fontSize: 12, lineHeight: 17, color: colors.textSecondary },
  bigInput: {
    minHeight: 220, maxHeight: 400,
    backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border,
    padding: 14, fontSize: 13, color: colors.text, lineHeight: 19,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  charRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, paddingHorizontal: 2 },
  charCount: { fontSize: 11, color: colors.textMuted, fontWeight: '700', fontVariant: ['tabular-nums'] as any },
  updatedBy: { fontSize: 10, color: colors.textMuted, fontStyle: 'italic' },
  footerRow: { flexDirection: 'row', gap: 10 },
  footerBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: 12 },
  footerBtnGhost: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  footerBtnGhostText: { color: colors.textSecondary, fontSize: 13, fontWeight: '700' },
  footerBtnPrimary: { backgroundColor: colors.primary, flex: 1.4 },
  footerBtnPrimaryText: { color: colors.onPrimary, fontSize: 13, fontWeight: '800', letterSpacing: 0.3 },
});
