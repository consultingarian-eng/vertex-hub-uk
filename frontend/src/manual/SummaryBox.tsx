/**
 * Renders the "What Good / Great Looks Like" summary cards for the current
 * day — one card per audience (Leader / New Hire). Edits are gated to
 * admins; trainees and leaders see a read-only collapsible card with bullet
 * points. Extracted from app/(tabs)/manual.tsx.
 *
 * The drag-to-reorder editor uses NestableDraggableFlatList because the
 * parent screen renders this inside a ScrollView.
 */
import React from 'react';
import { View, Text, TouchableOpacity, TextInput } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  NestableDraggableFlatList,
  ScaleDecorator,
} from 'react-native-draggable-flatlist';
import { useColors, useTheme } from '../theme/ThemeContext';
import type { DayTarget } from '../api/client';

export type AudienceRole = 'admin' | 'trainee' | 'leader';

export type SummaryBoxStyle = {
  bg: string;
  border: string;
  dot: string;
  text: string;
  editBg: string;
  editBorder: string;
  /** Hairline on the three non-accent sides (the left bar keeps `border`). */
  hairline?: string;
  /** boxShadow string that lifts the card off the page field (dark only —
   *  manual.tsx already paints colors.depthShadow on the light card). */
  shadow?: string;
};

export type SummaryBoxPalette = { good: SummaryBoxStyle; great: SummaryBoxStyle };

export type SummaryBoxConfig = {
  key: string;
  title: string;
  field: keyof DayTarget;
  icon: string;
  adminLabel?: string;
} & SummaryBoxStyle;

/* Visual presets — purple gradient: lighter for "Good", darker for "Great".
 *
 * These were the ONLY hard-coded light pastels left on this screen, so in dark
 * the four boxes floated as paper islands on the #061410 abyss (spec §2.5).
 * Each box now has a light AND a dark preset: light keeps its identity hue,
 * dark becomes a plum card RAISED above the abyss (never darker than it) with
 * the same Good-vs-Great reading — Good the quieter violet, Great the brighter.
 * Every label / bullet / input clears 4.5:1 on its own box in both themes
 * (measured: light 5.55–9.23, dark 5.37–14.95). primaryDark #2f6a4b is a fill,
 * never text in dark — the dark labels use primary #7fa032 / #c5e37f.
 */
export const GOOD_STYLE: SummaryBoxStyle = {
  bg: '#EAF2DA', border: '#2F6A4B', dot: '#2F6A4B', text: '#244C3B',
  editBg: '#E7EFD7', editBorder: '#AEC879', hairline: '#BBD18E',
};
export const GREAT_STYLE: SummaryBoxStyle = {
  bg: '#E7EFD7', border: '#245B42', dot: '#245B42', text: '#1A4431',
  editBg: '#DBE6C3', editBorder: '#8CAF38', hairline: '#B5CD85',
};
export const GOOD_STYLE_DARK: SummaryBoxStyle = {
  bg: '#0D1E16', border: '#7fa032', dot: '#7fa032', text: '#DAE6C2',
  editBg: '#08140F', editBorder: 'rgba(183,223,88,0.38)',
  hairline: 'rgba(183,223,88,0.28)',
};
export const GREAT_STYLE_DARK: SummaryBoxStyle = {
  bg: '#11261C', border: '#c5e37f', dot: '#c5e37f', text: '#E5EED4',
  editBg: '#0B1A13', editBorder: 'rgba(197,227,127,0.44)',
  hairline: 'rgba(197,227,127,0.34)',
};

const LIGHT_PALETTE: SummaryBoxPalette = { good: GOOD_STYLE, great: GREAT_STYLE };

/** Theme-aware box palette. The dark cards also carry colors.depthShadow so
 *  they READ as raised plum cards rather than flat patches on the field. */
export function useSummaryBoxPalette(): SummaryBoxPalette {
  const c = useColors();
  const isDark = useTheme().effective === 'dark';
  return React.useMemo<SummaryBoxPalette>(() => (
    isDark
      ? {
          good:  { ...GOOD_STYLE_DARK,  shadow: c.depthShadow },
          great: { ...GREAT_STYLE_DARK, shadow: c.depthShadow },
        }
      : LIGHT_PALETTE
  ), [isDark, c.depthShadow]);
}

/** Picks which audience-specific boxes to render based on the viewer's role.
 *  Admins see all four; trainees see new-hire boxes; leaders see leader boxes.
 *  `palette` defaults to the light presets so existing callers are unchanged. */
export function getBoxesForRole(role: AudienceRole, palette: SummaryBoxPalette = LIGHT_PALETTE): SummaryBoxConfig[] {
  const GOOD = palette.good;
  const GREAT = palette.great;
  if (role === 'admin') {
    return [
      { key: 'lg',  title: 'What Good Looks Like',  field: 'what_good_looks_like'        as keyof DayTarget, icon: 'star-outline', adminLabel: 'Coach',    ...GOOD },
      { key: 'lgr', title: 'What Great Looks Like', field: 'what_great_looks_like'       as keyof DayTarget, icon: 'star',         adminLabel: 'Coach',    ...GREAT },
      { key: 'hg',  title: 'What Good Looks Like',  field: 'hire_what_good_looks_like'   as keyof DayTarget, icon: 'star-outline', adminLabel: 'New Starter', ...GOOD },
      { key: 'hgr', title: 'What Great Looks Like', field: 'hire_what_great_looks_like'  as keyof DayTarget, icon: 'star',         adminLabel: 'New Starter', ...GREAT },
    ];
  }
  if (role === 'trainee') {
    return [
      { key: 'hg',  title: 'What Good Looks Like',  field: 'hire_what_good_looks_like'   as keyof DayTarget, icon: 'star-outline', ...GOOD },
      { key: 'hgr', title: 'What Great Looks Like', field: 'hire_what_great_looks_like'  as keyof DayTarget, icon: 'star',         ...GREAT },
    ];
  }
  return [
    { key: 'lg',  title: 'What Good Looks Like',  field: 'what_good_looks_like'        as keyof DayTarget, icon: 'star-outline', ...GOOD },
    { key: 'lgr', title: 'What Great Looks Like', field: 'what_great_looks_like'       as keyof DayTarget, icon: 'star',         ...GREAT },
  ];
}

export type SummaryBoxesProps = {
  role: AudienceRole;
  dayTarget: DayTarget | undefined;
  selectedDay: number;
  styles: any;
  // Edit state (admin only)
  editingBox: string | null;
  setEditingBox: (k: string | null) => void;
  editBullets: string[];
  setEditBullets: (b: string[]) => void;
  editNewBullet: string;
  setEditNewBullet: (v: string) => void;
  collapsedBoxes: Record<string, boolean>;
  toggleCollapse: (k: string) => void;
  // Save handler — fired when admin presses the check icon
  onSave: (day: number, patch: Partial<DayTarget>) => void;
};

export function SummaryBoxes(props: SummaryBoxesProps) {
  const { role } = props;
  const palette = useSummaryBoxPalette();
  const boxes = getBoxesForRole(role, palette);
  return (
    <>
      {boxes.map((box) => (
        <SummaryBox key={box.key} box={box} {...props} />
      ))}
    </>
  );
}

function SummaryBox({
  box, role, dayTarget, selectedDay, styles,
  editingBox, setEditingBox, editBullets, setEditBullets,
  editNewBullet, setEditNewBullet, collapsedBoxes, toggleCollapse, onSave,
}: SummaryBoxesProps & { box: SummaryBoxConfig }) {
  const c = useColors();
  const isAdmin = role === 'admin';
  const bullets = (dayTarget as any)?.[box.field] as string[] | undefined;
  const isEditing = editingBox === box.key;
  const isCollapsed = collapsedBoxes[box.key] ?? false;
  const hasBullets = bullets && bullets.length > 0;

  if (!hasBullets && !isAdmin) return null;

  // Per-side colours (never the `borderColor` shorthand — it would clobber the
  // 4px left accent bar that tells Good from Great).
  const cardStyle = {
    backgroundColor: box.bg,
    borderLeftColor: box.border,
    ...(box.hairline ? {
      borderTopColor: box.hairline,
      borderRightColor: box.hairline,
      borderBottomColor: box.hairline,
    } : null),
    ...(box.shadow ? { boxShadow: box.shadow } : null),
  };

  return (
    <View style={[styles.wgllCard, cardStyle]}>
      <TouchableOpacity
        style={styles.wgllHeader}
        onPress={() => !isAdmin ? toggleCollapse(box.key) : undefined}
        activeOpacity={isAdmin ? 1 : 0.7}
      >
        <Ionicons name={box.icon as any} size={18} color={box.border} />
        <Text style={[styles.wgllTitle, { color: box.border }]}>
          {box.title}{box.adminLabel ? ` - ${box.adminLabel}` : ''}
        </Text>
        {isAdmin ? (
          <TouchableOpacity
            style={styles.wgllEditBtn}
            onPress={() => {
              if (isEditing) {
                onSave(selectedDay, { [box.field]: editBullets } as any);
                setEditingBox(null);
              } else {
                setEditBullets([...(bullets || [])]);
                setEditNewBullet('');
                setEditingBox(box.key);
              }
            }}
          >
            <Ionicons name={isEditing ? 'checkmark' : 'create-outline'} size={18} color={isEditing ? c.green : box.border} />
          </TouchableOpacity>
        ) : (
          <Ionicons name={isCollapsed ? 'chevron-down' : 'chevron-up'} size={18} color={box.border} />
        )}
      </TouchableOpacity>
      {isEditing ? (
        <>
          <NestableDraggableFlatList
            data={editBullets.map((b, i) => ({ key: `wgll-${i}`, text: b, idx: i }))}
            keyExtractor={(item) => item.key}
            onDragEnd={({ data: newData }) => setEditBullets(newData.map(d => d.text))}
            renderItem={({ item, drag, isActive }) => (
              <ScaleDecorator>
                <View style={[styles.wgllEditRow, isActive && { opacity: 0.8, elevation: 4 }]}>
                  <TouchableOpacity onLongPress={drag} delayLongPress={150} style={styles.wgllDragHandle}>
                    <Ionicons name="reorder-three" size={20} color={box.border} />
                  </TouchableOpacity>
                  <TextInput
                    style={[styles.wgllEditInput, { backgroundColor: box.editBg, borderColor: box.editBorder, color: box.text }]}
                    value={item.text}
                    onChangeText={(t) => { const u = [...editBullets]; u[item.idx] = t; setEditBullets(u); }}
                    multiline
                  />
                  <TouchableOpacity onPress={() => setEditBullets(editBullets.filter((_, i) => i !== item.idx))} style={styles.wgllRemoveBtn}>
                    <Ionicons name="close-circle" size={20} color={c.red} />
                  </TouchableOpacity>
                </View>
              </ScaleDecorator>
            )}
          />
          <View style={styles.wgllAddRow}>
            <TextInput
              style={[styles.wgllAddInput, { backgroundColor: box.editBg, borderColor: box.editBorder, color: box.text }]}
              value={editNewBullet}
              onChangeText={setEditNewBullet}
              placeholder="Add bullet point..."
              placeholderTextColor={c.textMuted}
            />
            <TouchableOpacity onPress={() => { if (editNewBullet.trim()) { setEditBullets([...editBullets, editNewBullet.trim()]); setEditNewBullet(''); } }} style={styles.wgllAddBtn}>
              <Ionicons name="add-circle" size={24} color={box.border} />
            </TouchableOpacity>
          </View>
        </>
      ) : (
        !isCollapsed && hasBullets && (
          <View style={styles.wgllBulletList}>
            {bullets!.map((bullet, idx) => (
              <View key={idx} style={styles.wgllBulletRow}>
                <View style={[styles.wgllDot, { backgroundColor: box.dot }]} />
                <Text style={[styles.wgllBulletText, { color: box.text }]}>{bullet}</Text>
              </View>
            ))}
          </View>
        )
      )}
    </View>
  );
}
