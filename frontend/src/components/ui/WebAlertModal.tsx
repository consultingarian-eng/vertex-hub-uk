import React from 'react';
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAlertStore } from '../../utils/alertStore';
import { useColors } from '../../theme/ThemeContext';

export default function WebAlertModal() {
  const colors = useColors();
  const { visible, title, message, buttons, hide } = useAlertStore();

  const handlePress = (onPress?: () => void) => {
    hide();
    onPress?.();
  };

  const stack = buttons.length > 2;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={hide}>
      <Pressable style={styles.overlay} onPress={() => {
        const cancelBtn = buttons.find(b => b.style === 'cancel');
        handlePress(cancelBtn?.onPress);
      }}>
        <Pressable style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]} onPress={() => {}}>
          <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
          {!!message && <Text style={[styles.message, { color: colors.textMuted }]}>{message}</Text>}
          <View style={[styles.btnRow, stack && styles.btnRowStacked]}>
            {buttons.map((btn, i) => {
              const isDestructive = btn.style === 'destructive';
              const isCancel = btn.style === 'cancel';
              const isLast = i === buttons.length - 1;
              return (
                <TouchableOpacity
                  key={i}
                  style={[
                    styles.btn,
                    stack ? styles.btnFull : styles.btnFlex,
                    !stack && !isLast && { borderRightWidth: 1, borderRightColor: colors.border },
                    stack && !isLast && { borderBottomWidth: 1, borderBottomColor: colors.border },
                    isDestructive && styles.btnDestructive,
                  ]}
                  onPress={() => handlePress(btn.onPress)}
                  activeOpacity={0.7}
                >
                  <Text style={[
                    styles.btnText,
                    { color: isDestructive ? '#ef4444' : isCancel ? colors.textMuted : colors.primary },
                    isDestructive && { fontWeight: '700' },
                    !isDestructive && !isCancel && { fontWeight: '700' },
                  ]}>
                    {btn.text}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  card: {
    width: '100%',
    maxWidth: 320,
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    textAlign: 'center',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 4,
  },
  message: {
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  btnRow: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: '#DDE7D4',
  },
  btnRowStacked: {
    flexDirection: 'column',
  },
  btn: {
    paddingVertical: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnFlex: {
    flex: 1,
  },
  btnFull: {
    width: '100%',
  },
  btnDestructive: {},
  btnText: {
    fontSize: 15,
  },
});
