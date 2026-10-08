/**
 * AICoachSheet — modal sheet that asks Gemini for SWOT or Gap coaching tips
 * via /api/monthly-planners/ai-coach. Lets the leader copy/apply each tip.
 *
 * Two modes:
 *   - kind="swot":  one accordion per quadrant (3 bullets each)
 *   - kind="gap":   single trait → 3 tips + headline
 *
 * The leader can tap a tip to copy it to the clipboard, or tap "Insert" on
 * SWOT to append it to the matching quadrant in the planner.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, ScrollView,
  ActivityIndicator, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { apiService } from '../../api/client';
import { useColors, lightColors } from '../../theme/ThemeContext';
import { haptics } from '../../utils/haptics';
import { toast } from '../../utils/toast';
import { useDeviceInsets } from '../../nav/AppShell';

type SwotKey = 'strengths' | 'weaknesses' | 'opportunities' | 'threats';

const SWOT_LABELS: Record<SwotKey, { label: string; emoji: string; color: string }> = {
  strengths:    { label: 'Strengths',     emoji: '💪', color: '#22c55e' },
  weaknesses:   { label: 'Weaknesses',    emoji: '⚠️', color: '#ef4444' },
  opportunities:{ label: 'Opportunities', emoji: '🚀', color: '#3B82F6' },
  threats:      { label: 'Threats',       emoji: '🛡️', color: '#f59e0b' },
};

type Props = {
  visible: boolean;
  onClose: () => void;
  // SWOT mode
  kind: 'swot' | 'gap';
  swot?: Record<SwotKey, string>;
  onApplySwot?: (quadrant: SwotKey, suggestions: string[]) => void;
  // Gap mode
  trait?: string;
  score?: number;
};

export function AICoachSheet({ visible, onClose, kind, swot, onApplySwot, trait, score }: Props) {
  const insets = useDeviceInsets();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<any>(null);

  const fetchCoach = async () => {
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const payload: any = { kind };
      if (kind === 'swot') {
        payload.swot_current = swot || {};
      } else {
        payload.trait = trait;
        payload.score = score;
      }
      const { data: res } = await apiService.plannerAiCoach(payload);
      setData(res?.suggestions || {});
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e?.message || 'AI request failed';
      setError(String(msg));
      toast.error('Coach failed', String(msg).slice(0, 80));
    } finally {
      setLoading(false);
    }
  };

  // Auto-fetch when sheet opens
  useEffect(() => {
    if (visible) {
      fetchCoach();
    } else {
      setData(null);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, kind, trait]);

  const handleClose = () => { onClose(); };

  const copyTip = async (text: string) => {
    haptics.tap();
    try {
      await Clipboard.setStringAsync(text);
      toast.success('Copied', text.slice(0, 60));
    } catch {
      toast.error('Copy failed');
    }
  };

  const applySwotQuadrant = (q: SwotKey, tips: string[]) => {
    haptics.success();
    onApplySwot?.(q, tips);
    toast.success(`Added to ${SWOT_LABELS[q].label}`);
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={handleClose}>
      <View style={[styles.container, { paddingTop: Platform.OS === 'ios' ? 0 : insets.top }]}>
        <View style={styles.header}>
          <View style={styles.headerIcon}>
            <Ionicons name="sparkles" size={18} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>AI Coach</Text>
            <Text style={styles.subtitle}>
              {kind === 'swot' ? 'SWOT suggestions for your planner' : `Coaching for “${trait}” (${score ?? '?'}⁄5)`}
            </Text>
          </View>
          <TouchableOpacity onPress={handleClose} style={styles.headerBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="close" size={22} color={colors.text} />
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={{ padding: 14, gap: 10, paddingBottom: 40 }}>
          {loading ? (
            <View style={styles.loadingBox}>
              <ActivityIndicator color={colors.primary} />
              <Text style={styles.loadingText}>Coaching you up…</Text>
            </View>
          ) : error ? (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle" size={20} color={colors.red} />
              <Text style={styles.errorText} numberOfLines={4}>{error}</Text>
              <TouchableOpacity style={styles.retryBtn} onPress={fetchCoach}>
                <Ionicons name="refresh" size={14} color={colors.onPrimary} />
                <Text style={styles.retryBtnText}>Try again</Text>
              </TouchableOpacity>
            </View>
          ) : kind === 'swot' && data ? (
            (Object.keys(SWOT_LABELS) as SwotKey[]).map((q) => {
              const tips: string[] = Array.isArray(data?.[q]) ? data[q] : [];
              if (!tips.length) return null;
              const meta = SWOT_LABELS[q];
              return (
                <View key={q} style={[styles.quadrantCard, { borderLeftColor: meta.color }]}>
                  <View style={styles.quadrantHeader}>
                    <Text style={styles.quadrantTitle}>{meta.emoji}  {meta.label}</Text>
                    {onApplySwot && (
                      <TouchableOpacity onPress={() => applySwotQuadrant(q, tips)} style={styles.applyBtn}>
                        <Ionicons name="add-circle" size={14} color={colors.primary} />
                        <Text style={styles.applyBtnText}>Add all</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                  {tips.map((tip, i) => (
                    <TouchableOpacity key={i} style={styles.tipRow} onPress={() => copyTip(tip)}>
                      <View style={[styles.tipBullet, { backgroundColor: meta.color }]}>
                        <Text style={styles.tipBulletText}>{i + 1}</Text>
                      </View>
                      <Text style={styles.tipText}>{tip}</Text>
                      <Ionicons name="copy-outline" size={14} color={colors.textMuted} />
                    </TouchableOpacity>
                  ))}
                </View>
              );
            })
          ) : kind === 'gap' && data ? (
            <View>
              {data.headline ? (
                <View style={styles.headlineCard}>
                  <Ionicons name="flag" size={16} color={colors.primary} />
                  <Text style={styles.headlineText}>{data.headline}</Text>
                </View>
              ) : null}
              <View style={styles.tipsBox}>
                {(data.tips || []).map((tip: string, i: number) => (
                  <TouchableOpacity key={i} style={styles.tipRow} onPress={() => copyTip(tip)}>
                    <View style={[styles.tipBullet, { backgroundColor: colors.primary }]}>
                      <Text style={styles.tipBulletText}>{i + 1}</Text>
                    </View>
                    <Text style={styles.tipText}>{tip}</Text>
                    <Ionicons name="copy-outline" size={14} color={colors.textMuted} />
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          ) : null}

          <Text style={styles.disclaimer}>
            ✨ Powered by Gemini. Suggestions are starting points — trust your gut.
          </Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface },
  headerIcon: { width: 36, height: 36, borderRadius: 12, backgroundColor: `${colors.primary}1A`, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.primary },
  headerBtn: { padding: 6 },
  title: { fontSize: 17, fontWeight: '900', color: colors.text },
  subtitle: { fontSize: 11, color: colors.textMuted, marginTop: 2 },

  loadingBox: { alignItems: 'center', padding: 40, gap: 12 },
  loadingText: { fontSize: 13, color: colors.textSecondary, fontStyle: 'italic' },

  errorBox: { alignItems: 'center', padding: 24, gap: 10, backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.red },
  errorText: { color: colors.text, fontSize: 13, textAlign: 'center', lineHeight: 18 },
  retryBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, backgroundColor: colors.primary, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  retryBtnText: { color: colors.onPrimary, fontWeight: '800', fontSize: 12 },

  quadrantCard: { backgroundColor: colors.surface, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: colors.border, borderLeftWidth: 4, gap: 8 },
  quadrantHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  quadrantTitle: { fontSize: 14, fontWeight: '900', color: colors.text },
  applyBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 8, borderWidth: 1, borderColor: colors.primary, backgroundColor: `${colors.primary}1A` },
  applyBtnText: { fontSize: 11, fontWeight: '800', color: colors.primary },

  tipsBox: { backgroundColor: colors.surface, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: colors.border, gap: 8 },
  tipRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, paddingHorizontal: 6, borderRadius: 8, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border },
  tipBullet: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  tipBulletText: { color: '#fff', fontWeight: '900', fontSize: 11 },
  tipText: { flex: 1, fontSize: 13, color: colors.text, lineHeight: 18 },

  headlineCard: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderRadius: 10, marginBottom: 10, backgroundColor: `${colors.primary}1A`, borderWidth: 1, borderColor: colors.primary },
  headlineText: { flex: 1, fontSize: 14, color: colors.text, fontWeight: '700', lineHeight: 18 },

  disclaimer: { fontSize: 10, color: colors.textMuted, textAlign: 'center', fontStyle: 'italic', marginTop: 12 },
});

void lightColors;
