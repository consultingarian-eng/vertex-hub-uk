import React, { useState, useEffect, useMemo } from 'react';
import { showAlert } from '../src/utils/showAlert';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView, KeyboardAvoidingView, Platform,  } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../src/theme/colors';
import { lightColors } from '../src/theme/ThemeContext';
import { useColors } from '../src/theme/ThemeContext';
import { apiService, NewHireCreate } from '../src/api/client';
import { format } from 'date-fns';
import { roleWord } from '../src/utils/roleTitle';

export default function AddHireScreen() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [selectedLeaderId, setSelectedLeaderId] = useState<string | null>(null);
  const [leaders, setLeaders] = useState<{ id: string; name: string; role: string }[]>([]);
  const [notes, setNotes] = useState('');
  const [campaign, setCampaign] = useState('');
  const [hireEmail, setHireEmail] = useState('');
  const [hirePassword, setHirePassword] = useState('');

  useEffect(() => {
    apiService.getAvailableLeaders().then(r => {
      setLeaders(r.data);
      if (r.data.length > 0 && !selectedLeaderId) setSelectedLeaderId(r.data[0].id);
    }).catch(() => {});
  }, []);

  const createMutation = useMutation({
    mutationFn: (data: NewHireCreate) => apiService.createNewHire(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['new-hires'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
      showAlert('Success', 'New starter added successfully!', [
        { text: 'OK', onPress: () => router.back() }
      ]);
    },
    onError: (error: any) => {
      showAlert('Error', error.response?.data?.detail || 'Failed to add new starter');
    },
  });

  const handleSubmit = () => {
    if (!name.trim()) {
      showAlert('Validation', "Please enter the new starter's name");
      return;
    }
    if (!selectedLeaderId) {
      showAlert('Validation', 'Please select a coach');
      return;
    }
    const selectedLeader = leaders.find(l => l.id === selectedLeaderId);

    createMutation.mutate({
      name: name.trim(),
      leader: selectedLeader?.name || '',
      leader_id: selectedLeaderId,
      start_date: format(new Date(), 'yyyy-MM-dd'),
      campaign: campaign.trim(),
      notes: notes.trim() || undefined,
      email: hireEmail.trim() || undefined,
      password: hirePassword || undefined,
    } as any);
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 20 }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.infoCard}>
          <Ionicons name="information-circle" size={24} color={colors.primary} />
          <Text style={styles.infoText}>
            Adding a new starter will automatically create Day 1-8 assessment records and coaching checklists.
          </Text>
        </View>

        <View style={styles.form}>
          <View style={styles.inputGroup}>
            <Text style={styles.label}>New Starter Name *</Text>
            <TextInput
              style={styles.input}
              placeholder="Enter their full name"
              placeholderTextColor={colors.textMuted}
              value={name}
              onChangeText={setName}
              autoCapitalize="words"
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>Assign Coach *</Text>
            <View style={styles.leaderGrid}>
              {leaders.map(l => (
                <TouchableOpacity
                  key={l.id}
                  style={[styles.leaderOption, selectedLeaderId === l.id && styles.leaderOptionActive]}
                  onPress={() => setSelectedLeaderId(l.id)}
                >
                  <Ionicons name={selectedLeaderId === l.id ? 'radio-button-on' : 'radio-button-off'} size={18} color={selectedLeaderId === l.id ? '#D97706' : colors.textMuted} />
                  <View>
                    <Text style={[styles.leaderName, selectedLeaderId === l.id && { color: '#D97706' }]}>{l.name}</Text>
                    <Text style={styles.leaderRole}>{roleWord(l.role)}</Text>
                  </View>
                </TouchableOpacity>
              ))}
              {leaders.length === 0 && (
                <Text style={{ color: colors.textMuted, fontSize: 13, fontStyle: 'italic' }}>Loading coaches...</Text>
              )}
            </View>
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>Start Date</Text>
            <View style={styles.dateDisplay}>
              <Ionicons name="calendar" size={20} color={colors.textSecondary} />
              <Text style={styles.dateText}>
                {format(new Date(), 'MMMM d, yyyy')} (Today)
              </Text>
            </View>
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>Campaign (Optional)</Text>
            <TextInput
              style={styles.input}
              placeholder="Which campaign they'll work on"
              placeholderTextColor={colors.textMuted}
              value={campaign}
              onChangeText={setCampaign}
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>Notes (Optional)</Text>
            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder="Any additional notes about this new starter..."
              placeholderTextColor={colors.textMuted}
              value={notes}
              onChangeText={setNotes}
              multiline
              numberOfLines={4}
              textAlignVertical="top"
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>Login Email (Optional)</Text>
            <TextInput
              style={styles.input}
              placeholder="name@email.com"
              placeholderTextColor={colors.textMuted}
              value={hireEmail}
              onChangeText={setHireEmail}
              autoCapitalize="none"
              keyboardType="email-address"
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>Login Password (Optional)</Text>
            <TextInput
              style={styles.input}
              placeholder="Set a password for them"
              placeholderTextColor={colors.textMuted}
              value={hirePassword}
              onChangeText={setHirePassword}
              secureTextEntry
            />
          </View>
        </View>

        <TouchableOpacity
          style={[
            styles.submitButton,
            createMutation.isPending && styles.submitButtonDisabled
          ]}
          onPress={handleSubmit}
          disabled={createMutation.isPending}
        >
          <Ionicons 
            name={createMutation.isPending ? 'hourglass' : 'checkmark-circle'} 
            size={22} 
            color={colors.textLight} 
          />
          <Text style={styles.submitButtonText}>
            {createMutation.isPending ? 'Adding...' : 'Add New Starter'}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  content: {
    padding: 16,
  },
  infoCard: {
    flexDirection: 'row',
    backgroundColor: colors.background,
    borderRadius: 12,
    padding: 16,
    gap: 12,
    marginBottom: 24,
    borderLeftWidth: 4,
    borderLeftColor: colors.primary,
  },
  infoText: {
    flex: 1,
    fontSize: 14,
    color: colors.textSecondary,
    lineHeight: 20,
  },
  form: {
    gap: 20,
  },
  inputGroup: {
    gap: 8,
  },
  label: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
  },
  input: {
    backgroundColor: colors.background,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    color: colors.text,
  },
  textArea: {
    minHeight: 100,
    paddingTop: 14,
  },
  dateDisplay: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 10,
  },
  dateText: {
    fontSize: 16,
    color: colors.text,
  },
  submitButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 16,
    marginTop: 32,
    gap: 8,
  },
  submitButtonDisabled: {
    opacity: 0.7,
  },
  submitButtonText: {
    color: colors.textLight,
    fontSize: 17,
    fontWeight: '600',
  },
  leaderGrid: { gap: 8 },
  leaderOption: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  leaderOptionActive: { borderColor: '#D97706', backgroundColor: '#D9770608' },
  leaderName: { fontSize: 15, fontWeight: '600', color: colors.text },
  leaderRole: { fontSize: 12, color: colors.textSecondary, textTransform: 'capitalize' },
});

/* __theme_static_fallback__ */
// Fallback static styles (used if a sub-component didn't pick up the
// useColors hook). Always light-mode — won't react to theme changes.
const styles = createStyles(lightColors);
