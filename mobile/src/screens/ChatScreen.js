import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, FlatList, Pressable,
  StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { colors, fonts, radius } from '../theme';
import Message from '../components/Message';
import { api } from '../api';

const STARTERS = [
  'What should I focus on today?',
  'What do you remember about me?',
  'Give me a quick life status check.',
];

export default function ChatScreen({ route, navigation }) {
  const convId = route?.params?.convId ?? null;
  const [activeConvId, setActiveConvId] = useState(convId);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(false);
  const flatRef = useRef(null);
  const streamCtrl = useRef(null);

  useFocusEffect(
    useCallback(() => {
      if (convId && convId !== activeConvId) {
        setActiveConvId(convId);
        loadMessages(convId);
      }
    }, [convId])
  );

  useEffect(() => {
    if (activeConvId) loadMessages(activeConvId);
  }, [activeConvId]);

  async function loadMessages(id) {
    setLoading(true);
    try {
      const msgs = await api.getMessages(id);
      setMessages(msgs.map(m => ({ id: m.id, role: m.role, content: m.content, ts: m.created_at })));
    } catch {}
    setLoading(false);
  }

  async function send(text) {
    const msg = (text || input).trim();
    if (!msg || streaming) return;
    setInput('');

    let cid = activeConvId;
    if (!cid) {
      try {
        const conv = await api.createConversation('New conversation');
        cid = conv.id;
        setActiveConvId(cid);
      } catch { return; }
    }

    const userMsg = { id: Date.now().toString(), role: 'user', content: msg, ts: new Date().toISOString() };
    setMessages(prev => [...prev, userMsg]);

    const assistantId = (Date.now() + 1).toString();
    setMessages(prev => [...prev, { id: assistantId, role: 'assistant', content: '', ts: new Date().toISOString(), streaming: true }]);
    setStreaming(true);

    let fullText = '';
    streamCtrl.current = api.streamChat(cid, msg, {
      onChunk(chunk) {
        fullText += chunk;
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, content: fullText } : m
        ));
        flatRef.current?.scrollToEnd({ animated: false });
      },
      onDone() {
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, streaming: false } : m
        ));
        setStreaming(false);
        // Auto-title after first exchange
        if (messages.length === 0) {
          setTimeout(async () => {
            try {
              const conv = await api.getConversation(cid);
              if (conv.title && conv.title !== 'New conversation') {
                navigation.setParams({ title: conv.title });
              }
            } catch {}
          }, 3000);
        }
      },
      onError(err) {
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, content: `Error: ${err}`, streaming: false } : m
        ));
        setStreaming(false);
      },
    });
  }

  function newConversation() {
    streamCtrl.current?.abort();
    setActiveConvId(null);
    setMessages([]);
  }

  const showEmpty = !loading && messages.length === 0;

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {route?.params?.title || 'CLEETUS'}
        </Text>
        <Pressable onPress={newConversation} style={styles.newBtn}>
          <Text style={styles.newBtnText}>NEW</Text>
        </Pressable>
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.gold} />
          </View>
        ) : showEmpty ? (
          <View style={styles.empty}>
            <View style={styles.emptyIcon}>
              <Text style={styles.emptyC}>C</Text>
            </View>
            <Text style={styles.emptyTitle}>CLEETUS</Text>
            <View style={styles.emptyRule} />
            <Text style={styles.emptyDesc}>
              Your personal AI — I remember everything about you and grow sharper with every conversation.
            </Text>
            <View style={styles.starters}>
              {STARTERS.map(s => (
                <Pressable key={s} style={styles.starter} onPress={() => send(s)}>
                  <Text style={styles.starterText}>{s}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : (
          <FlatList
            ref={flatRef}
            data={messages}
            keyExtractor={m => m.id}
            renderItem={({ item }) => (
              <Message role={item.role} content={item.content} ts={item.ts} streaming={item.streaming} />
            )}
            contentContainerStyle={styles.messageList}
            onContentSizeChange={() => flatRef.current?.scrollToEnd({ animated: false })}
            ItemSeparatorComponent={() => <View style={{ height: 16 }} />}
          />
        )}

        <View style={styles.inputArea}>
          <View style={styles.inputWrap}>
            <TextInput
              style={styles.input}
              value={input}
              onChangeText={setInput}
              placeholder="Ask CLEETUS anything..."
              placeholderTextColor={colors.textMuted}
              multiline
              returnKeyType="send"
              onSubmitEditing={() => send()}
              editable={!streaming}
              blurOnSubmit={false}
            />
            <Pressable
              style={[styles.sendBtn, (!input.trim() || streaming) && styles.sendDisabled]}
              onPress={() => send()}
              disabled={!input.trim() || streaming}
            >
              {streaming ? (
                <ActivityIndicator size="small" color={colors.bg} />
              ) : (
                <Text style={styles.sendArrow}>▲</Text>
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.goldRule,
    backgroundColor: 'rgba(11,25,20,0.92)',
    gap: 12,
  },
  headerTitle: {
    flex: 1,
    fontFamily: fonts.serifI,
    fontSize: 17,
    color: colors.text,
  },
  newBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.goldRule,
    borderRadius: radius.sm,
  },
  newBtnText: {
    fontFamily: fonts.uiSemi,
    fontSize: 10,
    color: colors.gold,
    letterSpacing: 1,
  },

  messageList: {
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 8,
  },

  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 14,
  },
  emptyIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.surface3,
    borderWidth: 1,
    borderColor: colors.goldRule,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  emptyC: {
    fontFamily: fonts.serif,
    fontSize: 30,
    color: colors.gold,
  },
  emptyTitle: {
    fontFamily: fonts.serif,
    fontSize: 28,
    color: colors.gold,
    letterSpacing: 2,
  },
  emptyRule: {
    width: 48,
    height: 1,
    backgroundColor: colors.goldRule,
  },
  emptyDesc: {
    fontFamily: fonts.ui,
    fontSize: 14,
    color: colors.textSub,
    textAlign: 'center',
    lineHeight: 21,
    maxWidth: 300,
  },
  starters: { width: '100%', gap: 8, marginTop: 4 },
  starter: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1,
    borderColor: colors.goldRule,
    borderRadius: radius.md,
    padding: 12,
    paddingHorizontal: 16,
  },
  starterText: {
    fontFamily: fonts.ui,
    fontSize: 14,
    color: colors.textSub,
    lineHeight: 20,
  },

  inputArea: {
    padding: 12,
    paddingBottom: 20,
    borderTopWidth: 1,
    borderTopColor: colors.goldRule,
    backgroundColor: 'rgba(11,25,20,0.92)',
  },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.goldRule,
    borderRadius: 22,
    paddingLeft: 16,
    paddingRight: 4,
    paddingVertical: 4,
  },
  input: {
    flex: 1,
    fontFamily: fonts.mono,
    fontSize: 15,
    color: colors.text,
    maxHeight: 120,
    paddingVertical: 8,
    lineHeight: 22,
  },
  sendBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
    marginLeft: 4,
  },
  sendDisabled: { opacity: 0.3 },
  sendArrow: {
    fontSize: 14,
    color: colors.bg,
    fontFamily: fonts.uiSemi,
  },
});
