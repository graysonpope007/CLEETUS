import React, { useState, useCallback } from 'react';
import {
  View, Text, FlatList, Pressable, StyleSheet,
  ActivityIndicator, TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { colors, fonts, radius } from '../theme';
import { api } from '../api';

export default function ChatsScreen({ navigation }) {
  const [convs, setConvs] = useState([]);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [])
  );

  async function load() {
    setLoading(true);
    try {
      const data = await api.listConversations();
      setConvs(data);
    } catch {}
    setLoading(false);
  }

  async function newConversation() {
    try {
      const conv = await api.createConversation('New conversation');
      navigation.navigate('Chat', { convId: conv.id, title: conv.title });
      setTimeout(load, 500);
    } catch {}
  }

  function openConversation(conv) {
    navigation.navigate('Chat', { convId: conv.id, title: conv.title });
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Conversations</Text>
        <Text style={styles.count}>{convs.length}</Text>
      </View>

      <Pressable style={styles.newBtn} onPress={newConversation}>
        <Text style={styles.newBtnText}>+ New Conversation</Text>
      </Pressable>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.gold} />
        </View>
      ) : convs.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.empty}>No conversations yet.</Text>
          <Text style={styles.emptySub}>Start a new conversation above.</Text>
        </View>
      ) : (
        <FlatList
          data={convs}
          keyExtractor={c => c.id}
          renderItem={({ item }) => (
            <Pressable style={styles.item} onPress={() => openConversation(item)}>
              <View style={styles.itemLeft}>
                <View style={styles.itemDot} />
                <Text style={styles.itemTitle} numberOfLines={1}>{item.title}</Text>
              </View>
              <Text style={styles.itemTime}>{fmtDate(item.updated_at)}</Text>
            </Pressable>
          )}
          contentContainerStyle={{ paddingBottom: 32 }}
          ItemSeparatorComponent={() => (
            <View style={{ height: 1, backgroundColor: 'rgba(196,154,94,0.08)', marginLeft: 42 }} />
          )}
          onRefresh={load}
          refreshing={loading}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 18,
    borderBottomWidth: 1,
    borderBottomColor: colors.goldRule,
    gap: 10,
  },
  title: {
    flex: 1,
    fontFamily: fonts.serif,
    fontSize: 20,
    color: colors.gold,
    letterSpacing: 1,
  },
  count: {
    fontFamily: fonts.uiSemi,
    fontSize: 12,
    color: colors.textMuted,
    letterSpacing: 1,
  },

  newBtn: {
    margin: 16,
    padding: 13,
    backgroundColor: colors.goldDim,
    borderWidth: 1,
    borderColor: colors.goldRule,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  newBtnText: {
    fontFamily: fonts.uiSemi,
    fontSize: 12,
    color: colors.gold,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },

  item: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  itemLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minWidth: 0,
  },
  itemDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.goldRule,
    flexShrink: 0,
  },
  itemTitle: {
    flex: 1,
    fontFamily: fonts.ui,
    fontSize: 15,
    color: colors.textSub,
  },
  itemTime: {
    fontFamily: fonts.ui,
    fontSize: 11,
    color: colors.textMuted,
    flexShrink: 0,
  },

  empty: {
    fontFamily: fonts.serif,
    fontSize: 16,
    color: colors.textSub,
    fontStyle: 'italic',
  },
  emptySub: {
    fontFamily: fonts.ui,
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 4,
  },
});
