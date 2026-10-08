import React, { useMemo } from 'react';
import { showAlert } from '../../src/utils/showAlert';
import { promptText } from '../../src/utils/promptText';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, TextInput, KeyboardAvoidingView, Platform,  } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { colors, getStatusColor } from '../../src/theme/colors';
import { useColors, lightColors } from '../../src/theme/ThemeContext';
import { apiService, DailyAssessment, NewHire } from '../../src/api/client';
import { useAuth } from '../../src/auth/AuthContext';
import { format } from 'date-fns';
import { BrandLoader } from '../../src/components/ui/BrandLoader';
import { useTabBarClearance } from '../../src/customization/CustomTabBar';
import { ScrollReveal } from '../../src/components/ui/ScrollFx';
import { useParallaxScroll } from '../../src/components/ui/Parallax';
import { Breathe } from '../../src/components/ui/Breathe';

export default function NewHireDetailScreen() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const tabBarClearance = useTabBarClearance();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const { data: hire, isLoading: hireLoading } = useQuery({
    queryKey: ['new-hire', id],
    queryFn: () => apiService.getNewHire(id!).then(res => res.data),
    enabled: !!id,
  });

  const { data: assessments, isLoading: assessmentsLoading } = useQuery({
    queryKey: ['assessments', id],
    queryFn: () => apiService.getAssessments(id!).then(res => res.data),
    enabled: !!id,
  });

  const outcomeMutation = useMutation({
    mutationFn: ({ hireId, outcome }: { hireId: string; outcome: string }) =>
      apiService.setFinalOutcome(hireId, outcome),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['new-hire', id] });
      queryClient.invalidateQueries({ queryKey: ['new-hires'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
      showAlert('Success', 'Outcome has been recorded');
    },
    onError: () => {
      showAlert('Error', 'Failed to update outcome');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (hireId: string) => apiService.deleteNewHire(hireId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['new-hires'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
      router.back();
    },
    onError: () => {
      showAlert('Error', 'Failed to delete new starter');
    },
  });

  const reassignMutation = useMutation({
    mutationFn: ({ hireId, leader }: { hireId: string; leader: string }) =>
      apiService.reassignLeader(hireId, leader),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['new-hire', id] });
      queryClient.invalidateQueries({ queryKey: ['new-hires'] });
      showAlert('Success', `Coach changed to ${variables.leader}`);
    },
    onError: () => {
      showAlert('Error', 'Failed to reassign coach');
    },
  });

  const handleReassignLeader = async () => {
    const leader = await promptText(
      'Reassign Coach',
      `Current coach: ${hire?.leader}\n\nEnter the new coach's name:`,
      hire?.leader || '',
    );
    if (leader) reassignMutation.mutate({ hireId: id!, leader });
  };

  const handleSetOutcome = () => {
    showAlert(
      'Set Final Outcome',
      'Select the final outcome for this new starter',
      [
        {
          text: 'Ready',
          onPress: () => outcomeMutation.mutate({ hireId: id!, outcome: 'Ready' }),
        },
        {
          text: 'Needs More Training',
          onPress: () => outcomeMutation.mutate({ hireId: id!, outcome: 'Needs More Training' }),
        },
        {
          text: 'Not Ready',
          onPress: () => outcomeMutation.mutate({ hireId: id!, outcome: 'Not Ready' }),
          style: 'destructive',
        },
        { text: 'Cancel', style: 'cancel' },
      ]
    );
  };

  const handleDelete = () => {
    showAlert(
      'Delete New Starter',
      'Are you sure you want to delete this new starter and all their assessments?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => deleteMutation.mutate(id!),
        },
      ]
    );
  };

  const isLoading = hireLoading || assessmentsLoading;

  const scrollRef = React.useRef<ScrollView>(null);
  const { scrollY, onScroll } = useParallaxScroll();
  const [showReassignInput, setShowReassignInput] = React.useState(false);
  const [reassignName, setReassignName] = React.useState('');

  const getScoreColor = (score: number | null) => {
    if (score === null) return colors.textMuted;
    if (score >= 10) return colors.sgreen;
    if (score >= 9) return colors.green;
    if (score >= 7) return colors.yellow;
    return colors.red;
  };

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <BrandLoader size={56} />
      </View>
    );
  }

  if (!hire) {
    return (
      <View style={styles.errorContainer}>
        <Ionicons name="alert-circle" size={48} color={colors.red} />
        <Text style={styles.errorText}>New starter not found</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        ref={scrollRef}
        style={styles.scrollInner}
        contentContainerStyle={[styles.content, { paddingBottom: tabBarClearance + 40 }]}
        keyboardShouldPersistTaps="handled"
        onScroll={onScroll}
        scrollEventThrottle={16}
      >
      {/* Profile Card */}
      <View style={styles.profileCard}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>
            {hire.name.charAt(0).toUpperCase()}
          </Text>
        </View>
        <Text style={styles.name}>{hire.name}</Text>
        <Text style={styles.leader}>Coach: {hire.leader}</Text>
        <View style={styles.metaRow}>
          <View style={styles.metaItem}>
            <Ionicons name="calendar" size={16} color={colors.textSecondary} />
            <Text style={styles.metaText}>
              Started {format(new Date(hire.start_date), 'MMM d, yyyy')}
            </Text>
          </View>
          <View style={[
            styles.statusBadge,
            { backgroundColor: getStatusColor(hire.current_status).bg }
          ]}>
            <Text style={[
              styles.statusText,
              { color: getStatusColor(hire.current_status).text }
            ]}>
              {hire.current_status}
            </Text>
          </View>
        </View>
        {hire.final_outcome && (
          <View style={[
            styles.outcomeBadge,
            { backgroundColor: hire.final_outcome === 'Ready' ? colors.greenBg : colors.yellowBg }
          ]}>
            <Ionicons 
              name={hire.final_outcome === 'Ready' ? 'checkmark-circle' : 'time'} 
              size={18} 
              color={hire.final_outcome === 'Ready' ? colors.green : colors.yellow} 
            />
            <Text style={[
              styles.outcomeText,
              { color: hire.final_outcome === 'Ready' ? colors.green : colors.yellow }
            ]}>
              Outcome: {hire.final_outcome}
            </Text>
          </View>
        )}
      </View>

      {/* Progress Overview */}
      <ScrollReveal scrollY={scrollY}>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Training Progress</Text>
        <View style={styles.progressCard}>
          {assessments?.map((assessment: DailyAssessment) => (
            <React.Fragment key={assessment.id}>
              <TouchableOpacity
                style={styles.dayRow}
                onPress={() => router.push(`/assessment/${assessment.id}`)}
              >
                <View style={styles.dayInfo}>
                  <View style={[
                    styles.dayBadge,
                    assessment.completed && { backgroundColor: colors.primary }
                  ]}>
                    <Text style={[
                      styles.dayBadgeText,
                      assessment.completed && { color: colors.onPrimary }
                    ]}>
                      {assessment.day_number}
                    </Text>
                  </View>
                  <View>
                    <Text style={styles.dayTitle}>Day {assessment.day_number}</Text>
                    <Text style={styles.daySubtitle}>
                      {assessment.completed 
                        ? `Completed ${assessment.assessment_date ? format(new Date(assessment.assessment_date), 'MMM d') : ''}`
                        : 'Not yet assessed'
                      }
                    </Text>
                  </View>
                </View>
                
                <View style={styles.dayScores}>
                  {assessment.completed ? (
                    <>
                      <View style={styles.scoreItem}>
                        <Text style={styles.scoreLabel}>Score</Text>
                        <Text style={[
                          styles.scoreValue,
                          { color: getScoreColor(assessment.overall_score) }
                        ]}>
                          {assessment.overall_score?.toFixed(1) || '-'}
                        </Text>
                      </View>
                      {assessment.checklist_grade_score != null && (
                        <View style={styles.scoreItem}>
                          <Text style={styles.scoreLabel}>Grade</Text>
                          <Text style={[
                            styles.scoreValue,
                            { color: getScoreColor(assessment.checklist_grade_score), fontSize: 14 }
                          ]}>
                            {assessment.checklist_grade_score.toFixed(1)}
                          </Text>
                        </View>
                      )}
                      <View style={[
                        styles.miniStatusBadge,
                        { backgroundColor: getStatusColor(assessment.status).bg }
                      ]}>
                        <Text style={[
                          styles.miniStatusText,
                          { color: getStatusColor(assessment.status).text }
                        ]}>
                          {assessment.status}
                        </Text>
                      </View>
                    </>
                  ) : (
                    <View style={styles.pendingBadge}>
                      <Text style={styles.pendingText}>Pending</Text>
                    </View>
                  )}
                  <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
                </View>
              </TouchableOpacity>
            </React.Fragment>
          ))}
        </View>
      </View>
      </ScrollReveal>

      {/* Score Breakdown */}
      {assessments?.some(a => a.completed) && (
        <ScrollReveal scrollY={scrollY}>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Score Trend</Text>
          <View style={styles.trendCard}>
            <View style={styles.trendRow}>
              <Text style={styles.trendLabel}>Day</Text>
              {assessments.map((a: DailyAssessment) => (
                <Text key={a.id} style={styles.trendDay}>{a.day_number}</Text>
              ))}
            </View>
            <View style={styles.trendRow}>
              <Text style={styles.trendLabel}>Score</Text>
              {assessments.map((a: DailyAssessment) => (
                <Text 
                  key={a.id} 
                  style={[
                    styles.trendScore,
                    { color: getScoreColor(a.overall_score) }
                  ]}
                >
                  {a.overall_score?.toFixed(1) || '-'}
                </Text>
              ))}
            </View>
          </View>
        </View>
        </ScrollReveal>
      )}

      {/* Actions */}
      <ScrollReveal scrollY={scrollY}>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Actions</Text>
        
        {/* Leader assignment is now done via Admin → Users → Leader badge */}

        {!hire.final_outcome && hire.current_status === 'Awaiting Outcome' && (
          <Breathe>
          <TouchableOpacity
            style={[styles.actionButton, styles.actionButtonPrimary]}
            onPress={handleSetOutcome}
          >
            <Ionicons name="flag" size={20} color={colors.onPrimary} />
            <Text style={styles.actionButtonTextPrimary}>Set Final Outcome</Text>
          </TouchableOpacity>
          </Breathe>
        )}

        {isAdmin && (
          <TouchableOpacity
            style={[styles.actionButton, styles.actionButtonDanger]}
            onPress={handleDelete}
          >
            <Ionicons name="trash" size={20} color={colors.red} />
            <Text style={styles.actionButtonTextDanger}>Delete New Starter</Text>
          </TouchableOpacity>
        )}
      </View>
      </ScrollReveal>
    </ScrollView>
    </KeyboardAvoidingView>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollInner: {
    flex: 1,
  },
  content: {
    padding: 16,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  errorText: {
    fontSize: 16,
    color: colors.textSecondary,
  },
  profileCard: {
    backgroundColor: colors.background,
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    marginBottom: 20,
  },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  avatarText: {
    fontSize: 28,
    fontWeight: '600',
    color: colors.onPrimary,
  },
  name: {
    fontSize: 22,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 4,
  },
  leader: {
    fontSize: 15,
    color: colors.textSecondary,
    marginBottom: 12,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  metaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  metaText: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '600',
  },
  outcomeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    marginTop: 16,
  },
  outcomeText: {
    fontSize: 14,
    fontWeight: '600',
  },
  section: {
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 12,
  },
  progressCard: {
    backgroundColor: colors.background,
    borderRadius: 12,
    overflow: 'hidden',
  },
  dayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  dayInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  dayBadge: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayBadgeText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  dayTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
  },
  daySubtitle: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  dayScores: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  scoreItem: {
    alignItems: 'flex-end',
  },
  scoreLabel: {
    fontSize: 11,
    color: colors.textMuted,
  },
  scoreValue: {
    fontSize: 16,
    fontWeight: '700',
  },
  miniStatusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  miniStatusText: {
    fontSize: 11,
    fontWeight: '600',
  },
  pendingBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 4,
  },
  pendingText: {
    fontSize: 12,
    color: colors.textMuted,
  },
  gradeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    marginHorizontal: 16,
    marginBottom: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  gradeButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent,
  },
  trendCard: {
    backgroundColor: colors.background,
    borderRadius: 12,
    padding: 16,
  },
  trendRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
  },
  trendLabel: {
    fontSize: 13,
    color: colors.textSecondary,
    width: 50,
  },
  trendDay: {
    fontSize: 13,
    color: colors.textSecondary,
    width: 40,
    textAlign: 'center',
  },
  trendScore: {
    fontSize: 14,
    fontWeight: '600',
    width: 40,
    textAlign: 'center',
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    paddingVertical: 14,
    marginBottom: 10,
    gap: 8,
  },
  actionButtonPrimary: {
    backgroundColor: colors.primary,
  },
  actionButtonTextPrimary: {
    color: colors.onPrimary,
    fontSize: 16,
    fontWeight: '600',
  },
  actionButtonDanger: {
    backgroundColor: colors.redBg,
    borderWidth: 1,
    borderColor: colors.red,
  },
  actionButtonTextDanger: {
    color: colors.red,
    fontSize: 16,
    fontWeight: '600',
  },
  actionButtonAccent: {
    backgroundColor: '#EAF2DA',
    borderWidth: 1,
    borderColor: colors.accent,
  },
  actionButtonTextAccent: {
    color: colors.accent,
    fontSize: 16,
    fontWeight: '600',
  },
  reassignCard: {
    backgroundColor: colors.background,
    borderRadius: 12,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  reassignLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.text,
    marginBottom: 8,
  },
  reassignInput: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.text,
    marginBottom: 12,
  },
  reassignActions: {
    flexDirection: 'row',
    gap: 10,
  },
  reassignCancel: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  reassignCancelText: {
    color: colors.textSecondary,
    fontWeight: '600',
  },
  reassignConfirm: {
    flex: 2,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: colors.accent,
    alignItems: 'center',
  },
  reassignConfirmText: {
    color: colors.onAccent,
    fontWeight: '600',
  },
});

/* __theme_static_fallback__ */
// Fallback static styles (used if a sub-component didn't pick up the
// useColors hook). Always light-mode — won't react to theme changes.
const styles = createStyles(lightColors);
