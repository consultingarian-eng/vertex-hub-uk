/**
 * Monthly Targets block — renders inside the Monthly Planner's "Targets"
 * section. Lets the owner set two numeric targets (Monthly Sales Target,
 * Personal Best Target) and shows live progress bars that auto-pull the
 * actual sales count for the planner's calendar month from the bells data.
 */
import React, { useMemo } from 'react';
import { View, Text, StyleSheet, TextInput } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { apiService } from '../../api/client';
import { useColors } from '../../theme/ThemeContext';

type Targets = { monthly_sales?: number; personal_best?: number };

export function MonthlyTargetsBlock({
  month,
  canEdit,
  targets,
  onChange,
}: {
  month: string;            // YYYY-MM
  canEdit: boolean;
  targets: Targets;
  onChange: (next: Targets) => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const q = useQuery({
    queryKey: ['planner-sales-actual', month],
    queryFn: async () => (await apiService.monthlyPlannerSalesActual(month)).data,
    enabled: !!month,
    refetchInterval: 60_000,    // re-pull every 60s in case bells updated
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });

  const actual = q.data?.total_sales || 0;
  const monthlyTarget = Math.max(0, parseInt(String(targets.monthly_sales ?? 0), 10) || 0);
  const pbTarget = Math.max(0, parseInt(String(targets.personal_best ?? 0), 10) || 0);

  return (
    <View style={{ gap: 14 }}>
      {/* Actual badge */}
      <View style={styles.actualRow}>
        <Ionicons name="cellular" size={14} color={colors.primary} />
        <Text style={styles.actualLabel}>Sign-ups this month so far</Text>
        <Text style={styles.actualValue}>{q.isLoading ? '…' : actual}</Text>
      </View>

      {/* Monthly Sales Focus — the owner's monthly tracker (his standard: 100) */}
      <View style={styles.targetRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>Monthly Sales Focus</Text>
          <Text style={styles.helperRow}>
            <Text style={styles.helperBold}>{actual}</Text>
            <Text style={styles.helper}> / </Text>
            <Text style={styles.helperBold}>{monthlyTarget || '—'}</Text>
            {monthlyTarget > 0 && (
              <Text style={styles.helper}>  ·  {Math.min(100, Math.round((actual / monthlyTarget) * 100))}%</Text>
            )}
          </Text>
        </View>
        <TextInput
          editable={canEdit}
          keyboardType="numeric"
          style={[styles.numInput, !canEdit && styles.disabled]}
          placeholder="100"
          placeholderTextColor={colors.textMuted}
          value={monthlyTarget ? String(monthlyTarget) : ''}
          onChangeText={(v) => onChange({ ...targets, monthly_sales: parseInt(v.replace(/[^0-9]/g, ''), 10) || 0 })}
          maxLength={4}
        />
      </View>
      <ProgressBar pct={monthlyTarget > 0 ? Math.min(100, (actual / monthlyTarget) * 100) : 0} hit={actual >= monthlyTarget && monthlyTarget > 0} colors={colors} />

      {/* Personal Best Target */}
      <View style={[styles.targetRow, { marginTop: 4 }]}>
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>Personal Best Target</Text>
          <Text style={styles.helperRow}>
            <Text style={styles.helperBold}>{actual}</Text>
            <Text style={styles.helper}> / </Text>
            <Text style={styles.helperBold}>{pbTarget || '—'}</Text>
            {pbTarget > 0 && (
              <Text style={styles.helper}>  ·  {Math.min(100, Math.round((actual / pbTarget) * 100))}%</Text>
            )}
            {actual >= pbTarget && pbTarget > 0 && (
              <Text style={styles.hitBadge}>  🏆 PB BEATEN</Text>
            )}
          </Text>
        </View>
        <TextInput
          editable={canEdit}
          keyboardType="numeric"
          style={[styles.numInput, !canEdit && styles.disabled]}
          placeholder="0"
          placeholderTextColor={colors.textMuted}
          value={pbTarget ? String(pbTarget) : ''}
          onChangeText={(v) => onChange({ ...targets, personal_best: parseInt(v.replace(/[^0-9]/g, ''), 10) || 0 })}
          maxLength={4}
        />
      </View>
      <ProgressBar pct={pbTarget > 0 ? Math.min(100, (actual / pbTarget) * 100) : 0} hit={actual >= pbTarget && pbTarget > 0} colors={colors} accent="#f59e0b" />
    </View>
  );
}

function ProgressBar({ pct, hit, colors, accent }: { pct: number; hit: boolean; colors: any; accent?: string }) {
  const fillColor = hit ? '#16a34a' : (accent || colors.primary);
  return (
    <View style={{ height: 8, backgroundColor: colors.surfaceAlt || colors.surface, borderRadius: 4, overflow: 'hidden', borderWidth: 1, borderColor: colors.border }}>
      <View style={{ width: `${pct}%`, height: '100%', backgroundColor: fillColor }} />
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  actualRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 10, backgroundColor: colors.surfaceAlt || colors.surface, borderWidth: 1, borderColor: colors.border },
  actualLabel: { flex: 1, fontSize: 12, fontWeight: '700', color: colors.textSecondary, letterSpacing: 0.2 },
  actualValue: { fontSize: 18, fontWeight: '900', color: colors.primary, fontVariant: ['tabular-nums'] as any },

  targetRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  label: { fontSize: 13, fontWeight: '800', color: colors.text },
  helperRow: { fontSize: 11, marginTop: 3 },
  helper: { color: colors.textMuted, fontWeight: '600' },
  helperBold: { color: colors.text, fontWeight: '800', fontVariant: ['tabular-nums'] as any },
  hitBadge: { color: '#16a34a', fontWeight: '900', letterSpacing: 0.3 },
  numInput: { width: 80, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, color: colors.text, fontSize: 16, fontWeight: '800', textAlign: 'center', fontVariant: ['tabular-nums'] as any },
  disabled: { opacity: 0.55 },
});
