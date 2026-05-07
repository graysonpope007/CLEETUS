import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { colors, fonts, radius } from '../theme';
import { api } from '../api';

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning, Grayson.';
  if (h < 17) return 'Good afternoon, Grayson.';
  return 'Good evening, Grayson.';
}

function formatDate() {
  return new Date().toLocaleDateString([], {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  }).toUpperCase();
}

export default function DashboardScreen({ navigation }) {
  const [memCount, setMemCount]   = useState('—');
  const [convCount, setConvCount] = useState('—');
  const [recent, setRecent]       = useState([]);
  const [loading, setLoading]     = useState(true);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [])
  );

  async function load() {
    setLoading(true);
    try {
      const [countData, convs] = await Promise.all([
        api.memoryCount(),
        api.listConversations(),
      ]);
      setMemCount(countData.count);
      setConvCount(convs.length);
      setRecent(convs.slice(0, 5));
    } catch {}
    setLoading(false);
  }

  function openConv(conv) {
    navigation.navigate('Chat', { convId: conv.id, title: conv.title });
  }

  async function newConversation() {
    try {
      const conv = await api.createConversation('New conversation');
      navigation.navigate('Chat', { convId: conv.id, title: conv.title });
    } catch {}
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>

        <View style={styles.topSection}>
          <Text style={styles.greet}>{greeting()}</Text>
          <Text style={styles.date}>{formatDate()}</Text>
        </View>

        <View style={styles.rule} />

        <Text style={styles.sectionLabel}>Overview</Text>
        {loading ? (
          <ActivityIndicator color={colors.gold} style={{ marginVertical: 16 }} />
        ) : (
          <View style={styles.stats}>
            <Pressable style={styles.stat} onPress={() => navigation.navigate('Memory')}>
              <Text style={styles.statNum}>{memCount}</Text>
              <Text style={styles.statLabel}>Memories</Text>
            </Pressable>
            <Pressable style={styles.stat} onPress={() => navigation.navigate('Chats')}>
              <Text style={styles.statNum}>{convCount}</Text>
              <Text style={styles.statLabel}>Conversations</Text>
            </Pressable>
          </View>
        )}

        <Text style={[styles.sectionLabel, { marginTop: 8 }]}>Recent Chats</Text>
        {recent.length === 0 && !loading ? (
          <Text style={styles.empty}>No conversations yet.</Text>
        ) : (
          recent.map(c => (
            <Pressable key={c.id} style={styles.recentItem} onPress={() => openConv(c)}>
              <View style={styles.recentDot} />
              <Text style={styles.recentTitle} numberOfLines={1}>{c.title}</Text>
            </Pressable>
          ))
        )}

        <Text style={[styles.sectionLabel, { marginTop: 8 }]}>Quick Actions</Text>
        <Pressable style={styles.quickBtn} onPress={newConversation}>
          <Text style={styles.quickBtnText}>+ New Conversation</Text>
        </Pressable>
        <Pressable style={styles.quickBtn} onPress={() => navigation.navigate('Memory')}>
          <Text style={styles.quickBtnText}>Browse Memory</Text>
        </Pressable>
        <Pressable style={styles.quickBtn} onPress={() => navigation.navigate('SMS')}>
          <Text style={styles.quickBtnText}>View SMS</Text>
        </Pressable>

      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 20, gap: 6, paddingBottom: 40 },

  topSection: { gap: 4, marginBottom: 6 },
  greet: {
    fontFamily: fonts.serifI,
    fontSize: 18,
    color: colors.gold,
    lineHeight: 26,
  },
  date: {
    fontFamily: fonts.uiSemi,
    fontSize: 10,
    color: colors.textMuted,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginTop: 2,
  },

  rule: {
    height: 1,
    backgroundColor: colors.goldRule,
    marginVertical: 6,
  },

  sectionLabel: {
    fontFamily: fonts.uiSemi,
    fontSize: 9,
    color: colors.textMuted,
    letterSpacing: 2,
    textTransform: 'uppercase',
    paddingVertical: 4,
  },

  stats: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 4,
  },
  stat: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1,
    borderColor: colors.goldRule,
    borderRadius: radius.md,
    padding: 14,
  },
  statNum: {
    fontFamily: fonts.serif,
    fontSize: 28,
    color: colors.gold,
    lineHeight: 32,
  },
  statLabel: {
    fontFamily: fonts.uiSemi,
    fontSize: 9,
    color: colors.textMuted,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginTop: 4,
  },

  recentItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: radius.sm,
    gap: 10,
    marginVertical: 1,
  },
  recentDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.goldRule,
    flexShrink: 0,
  },
  recentTitle: {
    flex: 1,
    fontFamily: fonts.ui,
    fontSize: 14,
    color: colors.textSub,
  },

  quickBtn: {
    paddingVertical: 11,
    paddingHorizontal: 14,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1,
    borderColor: colors.goldRule,
    borderRadius: radius.sm,
    marginVertical: 3,
  },
  quickBtnText: {
    fontFamily: fonts.uiSemi,
    fontSize: 12,
    color: colors.gold,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },

  empty: {
    fontFamily: fonts.ui,
    fontSize: 13,
    color: colors.textMuted,
    paddingVertical: 8,
    paddingLeft: 4,
  },
});
