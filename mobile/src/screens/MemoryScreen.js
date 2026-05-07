import React, { useState, useCallback } from 'react';
import {
  View, Text, FlatList, Pressable, StyleSheet,
  TextInput, ActivityIndicator, Alert, SectionList,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { colors, fonts, radius } from '../theme';
import { api } from '../api';

const CATEGORY_ORDER = ['identity','preference','goal','value','expertise','project','relationship','context'];

function groupByCategory(mems) {
  const map = {};
  mems.forEach(m => {
    if (!map[m.category]) map[m.category] = [];
    map[m.category].push(m);
  });
  const sections = [];
  CATEGORY_ORDER.forEach(cat => {
    if (map[cat]) sections.push({ title: cat, data: map[cat] });
  });
  Object.keys(map).forEach(cat => {
    if (!CATEGORY_ORDER.includes(cat)) {
      sections.push({ title: cat, data: map[cat] });
    }
  });
  return sections;
}

export default function MemoryScreen() {
  const [sections, setSections] = useState([]);
  const [count, setCount] = useState(0);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [searchTimer, setSearchTimer] = useState(null);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [])
  );

  async function load() {
    setLoading(true);
    try {
      const mems = await api.listMemories();
      setSections(groupByCategory(mems));
      setCount(mems.length);
    } catch {}
    setLoading(false);
  }

  function onSearch(text) {
    setQuery(text);
    clearTimeout(searchTimer);
    if (!text.trim()) {
      load();
      return;
    }
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const mems = await api.searchMemories(text.trim());
        setSections(groupByCategory(mems));
        setCount(mems.length);
      } catch {}
      setLoading(false);
    }, 280);
    setSearchTimer(t);
  }

  async function deleteMemory(id) {
    Alert.alert('Delete Memory', 'Remove this memory permanently?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await api.deleteMemory(id);
          load();
        },
      },
    ]);
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Memory</Text>
        <Text style={styles.count}>{count} stored</Text>
      </View>

      <View style={styles.searchWrap}>
        <TextInput
          style={styles.search}
          value={query}
          onChangeText={onSearch}
          placeholder="Search memories..."
          placeholderTextColor={colors.textMuted}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.gold} />
        </View>
      ) : sections.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.empty}>{query ? `No results for "${query}"` : 'No memories yet.'}</Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={item => item.id}
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>{section.title.toUpperCase()}</Text>
            </View>
          )}
          renderItem={({ item }) => (
            <View style={styles.memItem}>
              <Text style={styles.memText} selectable>{item.content}</Text>
              <Pressable onPress={() => deleteMemory(item.id)} style={styles.delBtn}>
                <Text style={styles.delText}>DEL</Text>
              </Pressable>
            </View>
          )}
          contentContainerStyle={{ paddingBottom: 32 }}
          stickySectionHeadersEnabled={false}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 18,
    borderBottomWidth: 1,
    borderBottomColor: colors.goldRule,
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
    fontSize: 11,
    color: colors.textMuted,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },

  searchWrap: {
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.goldRule,
  },
  search: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: colors.goldRule,
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    paddingVertical: 9,
    fontFamily: fonts.ui,
    fontSize: 14,
    color: colors.text,
  },

  sectionHeader: {
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.goldRule,
  },
  sectionTitle: {
    fontFamily: fonts.uiSemi,
    fontSize: 10,
    color: colors.gold,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },

  memItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(196,154,94,0.06)',
    gap: 8,
  },
  memText: {
    flex: 1,
    fontFamily: fonts.ui,
    fontSize: 13.5,
    color: colors.textSub,
    lineHeight: 20,
  },
  delBtn: {
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 4,
    flexShrink: 0,
  },
  delText: {
    fontFamily: fonts.uiSemi,
    fontSize: 10,
    color: colors.danger,
    letterSpacing: 0.5,
  },

  empty: {
    fontFamily: fonts.serifI,
    fontSize: 15,
    color: colors.textSub,
    textAlign: 'center',
    paddingHorizontal: 32,
  },
});
