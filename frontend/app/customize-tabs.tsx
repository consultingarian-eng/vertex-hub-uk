/**
 * Customise Tab Bar — let users pick which items appear on their bottom
 * bar (max 7 + Profile pinned), reorder them with up/down arrows, and
 * see what'll appear in Quick Access (Profile screen) when hidden.
 */
import React, { useMemo, useState, useEffect } from 'react';
import { showAlert } from '../src/utils/showAlert';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Switch } from 'react-native';
import { Stack, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useColors } from '../src/theme/ThemeContext';
import { useTabPrefs } from '../src/customization/TabPrefsContext';
import { MAX_BOTTOM_TABS, MIN_BOTTOM_TABS } from '../src/customization/tabRegistry';
import { toast } from '../src/utils/toast';
import { useTabBarClearance } from '../src/customization/CustomTabBar';

export default function CustomizeTabsScreen() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { resolved, save, reset, loaded } = useTabPrefs();
  const tabBarClearance = useTabBarClearance();

  const [items, setItems] = useState<{ id: string; visible: boolean }[]>([]);
  useEffect(() => {
    if (loaded) {
      setItems(resolved.map((r) => ({ id: r.item.id, visible: r.visible })));
    }
  }, [loaded, resolved]);

  const itemDetails = useMemo(() => {
    const map: Record<string, typeof resolved[number]['item']> = {};
    for (const r of resolved) map[r.item.id] = r.item;
    return map;
  }, [resolved]);

  const visibleCount = items.filter((i) => i.visible).length;

  const toggleVisible = (id: string) => {
    setItems((curr) => {
      const idx = curr.findIndex((c) => c.id === id);
      if (idx < 0) return curr;
      const isOn = curr[idx].visible;
      const visibleCount = curr.filter((c) => c.visible).length;
      if (isOn && visibleCount <= MIN_BOTTOM_TABS) {
        showAlert('At least one item', `Keep at least ${MIN_BOTTOM_TABS} item in your sidebar.`);
        return curr;
      }
      if (!isOn && visibleCount >= MAX_BOTTOM_TABS) {
        showAlert('Sidebar is full', `You can pin up to ${MAX_BOTTOM_TABS} items. The rest stay under More.`);
        return curr;
      }
      const next = [...curr];
      next[idx] = { ...next[idx], visible: !isOn };
      return next;
    });
  };

  const move = (id: string, delta: -1 | 1) => {
    setItems((curr) => {
      const idx = curr.findIndex((c) => c.id === id);
      if (idx < 0) return curr;
      const newIdx = idx + delta;
      if (newIdx < 0 || newIdx >= curr.length) return curr;
      const next = [...curr];
      [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
      return next;
    });
  };

  const onSave = async () => {
    try {
      await save(items);
      toast.success('Saved!');
      router.back();
    } catch (e: any) {
      showAlert('Save failed', e?.response?.data?.detail || e?.message || '');
    }
  };

  const onReset = () => {
    showAlert('Reset to defaults?', 'Restores the recommended layout for your role.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reset', style: 'destructive', onPress: async () => {
        try { await reset(); toast.success('Reset'); router.back(); }
        catch (e: any) { showAlert('Reset failed', e?.message || ''); }
      }},
    ]);
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Customise Sidebar</Text>
          <Text style={styles.subtitle}>{visibleCount}/{MAX_BOTTOM_TABS} pinned · Profile always there</Text>
        </View>
        <TouchableOpacity onPress={onSave} style={styles.saveBtn}>
          <Text style={[styles.saveBtnText, { color: colors.onPrimary }]}>Save</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 80 + tabBarClearance }}>
        <Text style={styles.sectionLabel}>YOUR ITEMS</Text>
        <Text style={styles.helper}>
          Toggle to pin to the sidebar. Reorder with the up/down arrows. Unpinned items stay under More in the sidebar and in Quick Access on your Profile.
        </Text>
        {items.map((it, idx) => {
          const detail = itemDetails[it.id];
          if (!detail) return null;
          return (
            <View key={it.id} style={[styles.row, it.visible && { borderColor: colors.primary }]}>
              <View style={[styles.iconBox, { backgroundColor: it.visible ? `${colors.primary}1a` : colors.background }]}>
                <Ionicons name={detail.icon} size={20} color={it.visible ? colors.primary : colors.textMuted} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.rowTitle} numberOfLines={1}>{detail.longLabel}</Text>
                <Text style={styles.rowSub} numberOfLines={1}>
                  {it.visible ? `Bar label: "${detail.label}"` : 'Hidden — Quick Access on Profile'}
                </Text>
              </View>
              <View style={styles.actions}>
                <TouchableOpacity onPress={() => move(it.id, -1)} disabled={idx === 0} style={[styles.arrowBtn, idx === 0 && { opacity: 0.3 }]} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                  <Ionicons name="chevron-up" size={18} color={colors.text} />
                </TouchableOpacity>
                <TouchableOpacity onPress={() => move(it.id, 1)} disabled={idx === items.length - 1} style={[styles.arrowBtn, idx === items.length - 1 && { opacity: 0.3 }]} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                  <Ionicons name="chevron-down" size={18} color={colors.text} />
                </TouchableOpacity>
                <Switch value={it.visible} onValueChange={() => toggleVisible(it.id)} />
              </View>
            </View>
          );
        })}

        <TouchableOpacity onPress={onReset} style={styles.resetBtn}>
          <Ionicons name="refresh" size={16} color={colors.textSecondary} />
          <Text style={styles.resetBtnText}>Reset to defaults</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  screen: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  title: { fontSize: 17, fontWeight: '900', color: colors.text },
  subtitle: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  saveBtn: { backgroundColor: colors.primary, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  saveBtnText: { fontSize: 13, fontWeight: '800' },
  sectionLabel: { fontSize: 11, fontWeight: '900', color: colors.textMuted, letterSpacing: 0.5, marginBottom: 6 },
  helper: { fontSize: 12, color: colors.textSecondary, marginBottom: 16, lineHeight: 17 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 10, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface, marginBottom: 8 },
  iconBox: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { fontSize: 13, fontWeight: '800', color: colors.text },
  rowSub: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  arrowBtn: { padding: 6, borderRadius: 6 },
  resetBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, marginTop: 12 },
  resetBtnText: { fontSize: 13, fontWeight: '700', color: colors.textSecondary },
});
