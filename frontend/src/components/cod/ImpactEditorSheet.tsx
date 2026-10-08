/**
 * ImpactEditorSheet — admin create/edit modal for COD impacts. Ported from
 * the old ImpactsView editor and restyled onto the brand kit; the save
 * payload is unchanged (coachingCreateImpact / coachingUpdateImpact).
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Modal, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { apiService } from '../../api/client';
import { useColors } from '../../theme/ThemeContext';
import { fonts } from '../../theme/brand';
import { toast } from '../../utils/toast';
import { showAlert } from '../../utils/showAlert';
import { Impact, STAGE_META } from './types';

type Props = {
  visible: boolean;
  existing: Impact | null;
  defaultStage: number;
  onClose: () => void;
  onSaved: () => void;
};

export function ImpactEditorSheet({ visible, existing, defaultStage, onClose, onSaved }: Props) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();

  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [body, setBody] = useState('');
  const [takeawaysText, setTakeawaysText] = useState('');
  const [stage, setStage] = useState<number>(defaultStage);
  const [category, setCategory] = useState('general');
  const [source, setSource] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible) return;
    if (existing) {
      setTitle(existing.title);
      setSummary(existing.summary || '');
      setBody(existing.body || '');
      setTakeawaysText((existing.key_takeaways || []).join('\n'));
      setStage(existing.stage);
      setCategory(existing.category || 'general');
      setSource(existing.source || '');
    } else {
      setTitle(''); setSummary(''); setBody(''); setTakeawaysText('');
      setStage(defaultStage); setCategory('general'); setSource('');
    }
  }, [visible, existing, defaultStage]);

  const save = async () => {
    const t = title.trim();
    if (!t) { showAlert('Title required'); return; }
    const takeaways = takeawaysText.split('\n').map((s) => s.trim()).filter(Boolean);
    const payload = {
      title: t,
      summary: summary.trim(),
      body: body.trim(),
      key_takeaways: takeaways,
      stage,
      category: (category || 'general').trim().toLowerCase() || 'general',
      source: source.trim(),
    };
    try {
      setSaving(true);
      if (existing) await apiService.coachingUpdateImpact(existing.id, payload);
      else await apiService.coachingCreateImpact(payload);
      toast.success(existing ? 'Saved' : 'Added');
      onSaved();
    } catch (e: any) {
      showAlert('Save failed', e?.response?.data?.detail || e?.message || '');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <TouchableOpacity activeOpacity={1} onPress={onClose} style={styles.overlay}>
          <TouchableOpacity activeOpacity={1} style={[styles.sheet, { paddingBottom: 20 + insets.bottom }]}>
            <View style={styles.handle} />
            <Text style={styles.modalTitle}>{existing ? 'Edit impact' : 'Add impact'}</Text>
            <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 500 }}>
              <Text style={styles.fieldLabel}>STAGE IN THE CYCLE</Text>
              <View style={styles.stageRow}>
                {[1, 2, 3, 4].map((s) => {
                  const meta = STAGE_META[s];
                  const active = stage === s;
                  return (
                    <TouchableOpacity
                      key={s}
                      style={[styles.stageChip, active && { backgroundColor: meta.color, borderColor: meta.color }]}
                      onPress={() => setStage(s)}
                    >
                      <Text style={[styles.stageChipText, active && { color: colors.textLight }]}>{`Stage ${s}`}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <Text style={styles.fieldLabel}>TITLE</Text>
              <TextInput value={title} onChangeText={setTitle} placeholder="e.g. Objection Cycle" placeholderTextColor={colors.textMuted} style={styles.input} />

              <Text style={styles.fieldLabel}>CATEGORY (e.g. skill, mindset, leadership)</Text>
              <TextInput value={category} onChangeText={setCategory} placeholder="general" placeholderTextColor={colors.textMuted} style={styles.input} autoCapitalize="none" />

              <Text style={styles.fieldLabel}>SOURCE</Text>
              <TextInput value={source} onChangeText={setSource} placeholder="Impact Booklet" placeholderTextColor={colors.textMuted} style={styles.input} />

              <Text style={styles.fieldLabel}>SUMMARY (1-2 sentences)</Text>
              <TextInput value={summary} onChangeText={setSummary} multiline style={[styles.input, { minHeight: 60 }]} placeholderTextColor={colors.textMuted} placeholder="The one-line preview shown on the hub." />

              <Text style={styles.fieldLabel}>KEY TAKEAWAYS (one per line)</Text>
              <TextInput value={takeawaysText} onChangeText={setTakeawaysText} multiline style={[styles.input, { minHeight: 80 }]} placeholderTextColor={colors.textMuted} placeholder={'• …\n• …'} />

              <Text style={styles.fieldLabel}>BODY (full content — headings end with “:”, bullets start with “-”)</Text>
              <TextInput value={body} onChangeText={setBody} multiline style={[styles.input, { minHeight: 160 }]} placeholderTextColor={colors.textMuted} />
            </ScrollView>
            <TouchableOpacity style={[styles.primaryBtn, saving && { opacity: 0.5 }]} onPress={save} disabled={saving}>
              {saving ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={styles.primaryBtnText}>{existing ? 'Save changes' : 'Add impact'}</Text>}
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.background, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 16, paddingTop: 8, maxHeight: '92%' },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginBottom: 12 },
  modalTitle: { fontFamily: fonts.display, fontSize: 17, fontWeight: '900', color: colors.text, marginBottom: 12 },
  fieldLabel: { fontFamily: fonts.mono, fontSize: 10, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.8, marginTop: 10, marginBottom: 5, textTransform: 'uppercase' },
  stageRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  stageChip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  stageChipText: { fontFamily: fonts.bodySemibold, fontSize: 12, fontWeight: '700', color: colors.text },
  input: { fontFamily: fonts.body, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text, backgroundColor: colors.surface, marginBottom: 4, textAlignVertical: 'top' },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: colors.primary, paddingHorizontal: 14, paddingVertical: 13, borderRadius: 12, marginTop: 10 },
  primaryBtnText: { fontFamily: fonts.bodyBold, color: colors.onPrimary, fontSize: 14, fontWeight: '800' },
});

export default ImpactEditorSheet;
