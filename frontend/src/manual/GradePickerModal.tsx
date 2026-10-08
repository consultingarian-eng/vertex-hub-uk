/**
 * Bottom-sheet style modal for picking a grade preset (1-10, Competent /
 * Learnt / Not Learnt, etc.) for a single training-manual item. Extracted
 * from app/(tabs)/manual.tsx.
 *
 * Stateless — the parent owns the open/close state and the active item.
 */
import React from 'react';
import { View, Text, Modal, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { TrainingManualItem, GradePreset } from '../api/client';
import { getPresetColor } from './utils';

export type GradePickerModalProps = {
  visible: boolean;
  presets: GradePreset[] | undefined;
  item: TrainingManualItem | null;
  styles: any;
  onSelect: (preset: GradePreset) => void;
  onClose: () => void;
};

export function GradePickerModal({
  visible,
  presets,
  item,
  styles,
  onSelect,
  onClose,
}: GradePickerModalProps) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={onClose}>
        <View style={styles.modalContent} onStartShouldSetResponder={() => true}>
          <View style={styles.modalHandle} />
          <Text style={styles.modalTitle}>Select Grade Type</Text>
          {item && (
            <Text style={styles.modalSubtitle}>
              Day {item.day_number} - {item.topic}
            </Text>
          )}
          <View style={styles.presetList}>
            {(presets || []).map((preset, idx) => {
              const pColor = getPresetColor(preset.label);
              const isActive = item?.grade_options?.join(',') === preset.options.join(',');
              return (
                <TouchableOpacity
                  key={idx}
                  style={[styles.presetOption, isActive && { borderColor: pColor, borderWidth: 2 }]}
                  onPress={() => onSelect(preset)}
                  activeOpacity={0.7}
                >
                  <View style={styles.presetHeader}>
                    <View style={[styles.presetDot, { backgroundColor: pColor }]} />
                    <Text style={[styles.presetLabel, { color: pColor }]}>{preset.label}</Text>
                    {isActive && <Ionicons name="checkmark-circle" size={20} color={pColor} style={{ marginLeft: 'auto' }} />}
                  </View>
                  <View style={styles.presetOptionsRow}>
                    {preset.options.map((opt, i) => (
                      <View key={i} style={[styles.presetChip, { backgroundColor: pColor + '15' }]}>
                        <Text style={[styles.presetChipText, { color: pColor }]}>{opt}</Text>
                      </View>
                    ))}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
          <TouchableOpacity style={styles.modalCancel} onPress={onClose}>
            <Text style={styles.modalCancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}
