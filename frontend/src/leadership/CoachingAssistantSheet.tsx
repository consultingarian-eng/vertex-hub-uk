/**
 * Leadership Hub — AI Coaching Assistant chat sheet.
 *
 * Slide-up modal triggered by the Ask AI floating button. Threaded chat —
 * remembers context across messages within a conversation, persisted on
 * the server. Shows citations to specific impacts the assistant referenced.
 */
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { showAlert } from '../utils/showAlert';
import { Modal, View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, ActivityIndicator, KeyboardAvoidingView, Platform,  } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { apiService } from '../api/client';
import { useColors } from '../theme/ThemeContext';
import { haptics } from '../utils/haptics';

type Message = {
  role: 'user' | 'assistant';
  text: string;
  citations?: string[];
  at?: string;
};

type Citation = {
  id: string;
  title: string;
  stage: number;
  category: string;
  source: string;
  summary: string;
};

type ConvStub = {
  id: string;
  title: string;
  updated_at: string;
  message_count: number;
};

type Props = {
  visible: boolean;
  onClose: () => void;
};

const SUGGESTIONS = [
  "How do I coach the objection cycle?",
  "My new starter struggles with closing. What should I run?",
  "What's the best way to teach the 5 steps of the sign-up?",
  "How do I get a new BA to believe in L.O.A.?",
  "What should I run on a slow day to lift the team?",
];

export default function CoachingAssistantSheet({ visible, onClose }: Props) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [convId, setConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [citations, setCitations] = useState<Record<string, Citation>>({}); // id → impact
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [conversations, setConversations] = useState<ConvStub[]>([]);
  const [loadingConv, setLoadingConv] = useState(false);
  const scrollRef = useRef<ScrollView | null>(null);

  // Reset on close
  useEffect(() => {
    if (!visible) {
      // Keep the conversation in memory so reopening within the session continues — but if a user wants a fresh chat they tap the New button.
    }
  }, [visible]);

  // Auto scroll on new messages
  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 80);
    return () => clearTimeout(t);
  }, [messages.length, sending, visible]);

  const startNew = useCallback(() => {
    haptics.light();
    setConvId(null);
    setMessages([]);
    setCitations({});
    setShowHistory(false);
  }, []);

  const loadHistory = useCallback(async () => {
    setLoadingConv(true);
    try {
      const { data } = await apiService.coachingAssistantConversations();
      setConversations(data?.conversations || []);
    } catch (e: any) {
      showAlert('Failed to load history', e?.response?.data?.detail || e?.message || '');
    } finally {
      setLoadingConv(false);
    }
  }, []);

  const openConversation = useCallback(async (id: string) => {
    setLoadingConv(true);
    try {
      const { data } = await apiService.coachingAssistantConversation(id);
      setConvId(id);
      setMessages(data?.messages || []);
      setCitations({});
      setShowHistory(false);
    } catch (e: any) {
      showAlert('Failed to open', e?.response?.data?.detail || e?.message || '');
    } finally {
      setLoadingConv(false);
    }
  }, []);

  const deleteConversation = useCallback((id: string) => {
    showAlert('Delete chat?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try {
          await apiService.coachingAssistantDeleteConversation(id);
          setConversations((c) => c.filter((x) => x.id !== id));
          if (convId === id) startNew();
        } catch (e: any) {
          showAlert('Delete failed', e?.response?.data?.detail || e?.message || '');
        }
      }},
    ]);
  }, [convId, startNew]);

  const send = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || sending) return;
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', text }]);
    setSending(true);
    haptics.medium();
    try {
      const { data } = await apiService.coachingAssistantAsk({
        message: text,
        conversation_id: convId || undefined,
      });
      const newConvId = data?.conversation_id || convId;
      setConvId(newConvId);
      const am: Message = data?.assistant_message || { role: 'assistant', text: '' };
      setMessages((prev) => [...prev, am]);
      // Cache citations by id for inline rendering
      const citList: Citation[] = data?.citations || [];
      setCitations((prev) => {
        const next = { ...prev };
        for (const c of citList) next[c.id] = c;
        return next;
      });
      haptics.light();
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e?.message || 'Something went wrong.';
      setMessages((prev) => [...prev, { role: 'assistant', text: `Sorry — ${msg}` }]);
    } finally {
      setSending(false);
    }
  }, [input, sending, convId]);

  const isEmpty = messages.length === 0;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
        keyboardVerticalOffset={0}
      >
        <View style={styles.overlay}>
          <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>
            {/* Header */}
            <View style={styles.header}>
              <View style={styles.handle} />
              <View style={styles.headerRow}>
                <View style={styles.titleWrap}>
                  <View style={[styles.iconCircle, { backgroundColor: `${colors.primary}22` }]}>
                    <Ionicons name="sparkles" size={16} color={colors.primary} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.title} numberOfLines={1}>Coaching Assistant</Text>
                    <Text style={styles.subtitle} numberOfLines={1}>
                      Grounded in your Leadership Hub impacts
                    </Text>
                  </View>
                </View>
                <TouchableOpacity
                  style={styles.headerBtn}
                  onPress={() => { setShowHistory((v) => !v); if (!showHistory) loadHistory(); }}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="time-outline" size={20} color={colors.textSecondary} />
                </TouchableOpacity>
                <TouchableOpacity style={styles.headerBtn} onPress={startNew} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="create-outline" size={20} color={colors.textSecondary} />
                </TouchableOpacity>
                <TouchableOpacity style={styles.headerBtn} onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="close" size={22} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>
            </View>

            {/* History panel (slides over messages when open) */}
            {showHistory ? (
              <View style={{ flex: 1 }}>
                <Text style={styles.sectionLabel}>RECENT CHATS</Text>
                {loadingConv ? (
                  <View style={styles.loadingBlock}><ActivityIndicator color={colors.primary} /></View>
                ) : conversations.length === 0 ? (
                  <View style={styles.empty}>
                    <Ionicons name="chatbubbles-outline" size={40} color={colors.textMuted} />
                    <Text style={styles.emptyText}>No chats yet. Ask your first question to get started.</Text>
                  </View>
                ) : (
                  <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16 }}>
                    {conversations.map((c) => (
                      <View key={c.id} style={styles.convRow}>
                        <TouchableOpacity style={{ flex: 1 }} onPress={() => openConversation(c.id)} activeOpacity={0.7}>
                          <Text style={styles.convTitle} numberOfLines={1}>{c.title || 'Untitled chat'}</Text>
                          <Text style={styles.convMeta} numberOfLines={1}>
                            {c.message_count} message{c.message_count === 1 ? '' : 's'}
                          </Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => deleteConversation(c.id)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                          <Ionicons name="trash-outline" size={18} color="#dc2626" />
                        </TouchableOpacity>
                      </View>
                    ))}
                  </ScrollView>
                )}
              </View>
            ) : (
              <ScrollView
                ref={scrollRef}
                style={{ flex: 1 }}
                contentContainerStyle={styles.messagesWrap}
                keyboardShouldPersistTaps="handled"
              >
                {isEmpty ? (
                  <View style={styles.welcome}>
                    <View style={[styles.welcomeBadge, { backgroundColor: `${colors.primary}1a` }]}>
                      <Ionicons name="bulb" size={26} color={colors.primary} />
                    </View>
                    <Text style={styles.welcomeTitle}>Ask anything about coaching</Text>
                    <Text style={styles.welcomeSub}>
                      I'll answer in coach-tone, grounded in the impacts you have access to.
                    </Text>
                    <View style={styles.suggestionList}>
                      {SUGGESTIONS.map((s, i) => (
                        <TouchableOpacity
                          key={i}
                          style={styles.suggestionRow}
                          activeOpacity={0.7}
                          onPress={() => send(s)}
                          disabled={sending}
                        >
                          <Ionicons name="arrow-forward-circle-outline" size={18} color={colors.primary} />
                          <Text style={styles.suggestionText}>{s}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>
                ) : (
                  messages.map((m, idx) => (
                    <Bubble
                      key={`${idx}-${m.at || ''}`}
                      role={m.role}
                      text={m.text}
                      citationIds={m.citations || []}
                      citations={citations}
                      colors={colors}
                    />
                  ))
                )}
                {sending && (
                  <View style={styles.typingRow}>
                    <ActivityIndicator color={colors.primary} size="small" />
                    <Text style={styles.typingText}>Coach is thinking…</Text>
                  </View>
                )}
              </ScrollView>
            )}

            {/* Composer */}
            {!showHistory && (
              <View style={styles.composer}>
                <TextInput
                  value={input}
                  onChangeText={setInput}
                  placeholder="Ask the coach…"
                  placeholderTextColor={colors.textMuted}
                  style={styles.composerInput}
                  multiline
                  maxLength={2000}
                  editable={!sending}
                  onSubmitEditing={() => send()}
                  blurOnSubmit={false}
                />
                <TouchableOpacity
                  onPress={() => send()}
                  disabled={!input.trim() || sending}
                  style={[
                    styles.sendBtn,
                    { backgroundColor: input.trim() && !sending ? colors.primary : colors.border },
                  ]}
                  activeOpacity={0.85}
                >
                  {sending ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Ionicons name="arrow-up" size={20} color="#fff" />
                  )}
                </TouchableOpacity>
              </View>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}


// ──────────────────────── Bubble ─────────────────────────────────────
function Bubble({ role, text, citationIds, citations, colors }: {
  role: 'user' | 'assistant';
  text: string;
  citationIds: string[];
  citations: Record<string, Citation>;
  colors: any;
}) {
  const styles = useMemo(() => createStyles(colors), [colors]);
  const cited = citationIds.map((id) => citations[id]).filter(Boolean) as Citation[];
  const isUser = role === 'user';

  if (isUser) {
    return (
      <View style={[styles.bubbleRow, { justifyContent: 'flex-end' }]}>
        <View style={[styles.bubble, styles.userBubble, { backgroundColor: colors.primary }]}>
          <Text style={[styles.bubbleText, { color: colors.onPrimary }]}>{text}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.bubbleRow}>
      <View style={[styles.bubble, styles.assistantBubble, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <FormattedText text={text} colors={colors} />
        {cited.length > 0 && (
          <View style={styles.citationsBox}>
            <Text style={styles.citationsLabel}>SOURCES</Text>
            <View style={styles.citationsList}>
              {cited.map((c) => (
                <View key={c.id} style={[styles.citationChip, { borderColor: colors.border, backgroundColor: colors.background }]}>
                  <Text style={[styles.citationStage, { color: colors.primary }]}>S{c.stage}</Text>
                  <Text style={[styles.citationTitle, { color: colors.text }]} numberOfLines={1}>{c.title}</Text>
                </View>
              ))}
            </View>
          </View>
        )}
      </View>
    </View>
  );
}


// Minimal markdown-ish formatter — bold (**…**) and bullet lines (- …)
function FormattedText({ text, colors }: { text: string; colors: any }) {
  const lines = (text || '').split('\n');
  return (
    <View style={{ gap: 4 }}>
      {lines.map((ln, i) => {
        const trimmed = ln.trim();
        if (!trimmed) return <View key={i} style={{ height: 6 }} />;
        const isBullet = trimmed.startsWith('- ') || trimmed.startsWith('• ');
        const content = isBullet ? trimmed.slice(2) : trimmed;
        return (
          <View key={i} style={[styles.lineRow, isBullet && { paddingLeft: 8 }]}>
            {isBullet ? (
              <Text style={[styles.bulletDot, { color: colors.primary }]}>•</Text>
            ) : null}
            <Text style={[styles.lineText, { color: colors.text }]}>
              {renderInline(content, colors)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function renderInline(s: string, colors: any) {
  // Split on **bold** segments
  const parts = s.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) {
      return (
        <Text key={i} style={{ fontWeight: '900', color: colors.text }}>
          {p.slice(2, -2)}
        </Text>
      );
    }
    return <Text key={i}>{p}</Text>;
  });
}


const styles = StyleSheet.create({
  lineRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  lineText: { fontSize: 14, lineHeight: 21, flex: 1 },
  bulletDot: { fontSize: 18, lineHeight: 21, fontWeight: '900', width: 10 },
});


const createStyles = (colors: any) => StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.background, borderTopLeftRadius: 20, borderTopRightRadius: 20, height: '88%', overflow: 'hidden' },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginTop: 8, marginBottom: 6 },
  header: { paddingHorizontal: 16, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  titleWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  iconCircle: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 16, fontWeight: '900', color: colors.text },
  subtitle: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  headerBtn: { padding: 8, borderRadius: 8 },

  messagesWrap: { paddingHorizontal: 12, paddingTop: 12, paddingBottom: 16, gap: 10 },

  welcome: { paddingHorizontal: 12, paddingTop: 16, gap: 12, alignItems: 'center' },
  welcomeBadge: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  welcomeTitle: { fontSize: 17, fontWeight: '900', color: colors.text, textAlign: 'center', marginTop: 4 },
  welcomeSub: { fontSize: 13, color: colors.textSecondary, textAlign: 'center', maxWidth: 320, lineHeight: 19 },
  suggestionList: { width: '100%', marginTop: 8, gap: 8 },
  suggestionRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  suggestionText: { flex: 1, fontSize: 13, fontWeight: '600', color: colors.text, lineHeight: 18 },

  bubbleRow: { flexDirection: 'row', width: '100%' },
  bubble: { maxWidth: '88%', padding: 12, borderRadius: 14 },
  userBubble: { borderBottomRightRadius: 4 },
  assistantBubble: { borderBottomLeftRadius: 4, borderWidth: 1 },
  bubbleText: { fontSize: 14, lineHeight: 20, fontWeight: '600' },

  citationsBox: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border, gap: 6 },
  citationsLabel: { fontSize: 9, fontWeight: '900', color: colors.textMuted, letterSpacing: 0.6 },
  citationsList: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  citationChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 12, borderWidth: 1, maxWidth: '100%' },
  citationStage: { fontSize: 10, fontWeight: '900' },
  citationTitle: { fontSize: 11, fontWeight: '700', flexShrink: 1 },

  typingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 8 },
  typingText: { fontSize: 12, color: colors.textMuted, fontWeight: '600' },

  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.background },
  composerInput: { flex: 1, minHeight: 40, maxHeight: 110, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10, borderRadius: 20, borderWidth: 1, borderColor: colors.border, fontSize: 14, color: colors.text, backgroundColor: colors.surface },
  sendBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },

  sectionLabel: { fontSize: 10, fontWeight: '900', color: colors.textMuted, letterSpacing: 0.6, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6, textTransform: 'uppercase' },
  loadingBlock: { padding: 30, alignItems: 'center' },
  convRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, marginBottom: 8 },
  convTitle: { fontSize: 13, fontWeight: '800', color: colors.text },
  convMeta: { fontSize: 11, color: colors.textMuted, fontWeight: '600', marginTop: 2 },
  empty: { alignItems: 'center', padding: 36, gap: 10 },
  emptyText: { color: colors.textMuted, fontSize: 13, textAlign: 'center', maxWidth: 280 },
});
