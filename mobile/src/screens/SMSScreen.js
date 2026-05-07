import React, { useState, useCallback } from 'react';
import {
  View, Text, FlatList, Pressable, StyleSheet,
  ActivityIndicator, Modal, TextInput, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { colors, fonts, radius } from '../theme';
import { api } from '../api';

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function SMSScreen() {
  const [status, setStatus] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [modal, setModal] = useState(false);
  const [to, setTo] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [])
  );

  async function load() {
    setLoading(true);
    try {
      const [stat, msgs] = await Promise.all([api.smsStatus(), api.smsMessages(30)]);
      setStatus(stat);
      setMessages(msgs);
    } catch {}
    setLoading(false);
  }

  async function sync() {
    setSyncing(true);
    try {
      const res = await api.smsSync();
      if (res.success) {
        Alert.alert('Synced', `${res.synced} messages synced.`);
        load();
      } else {
        Alert.alert('Sync Failed', res.error || 'Could not sync.');
      }
    } catch (e) {
      Alert.alert('Error', e.message);
    }
    setSyncing(false);
  }

  async function sendSms() {
    if (!to.trim() || !body.trim()) {
      Alert.alert('Missing Fields', 'Please fill in both fields.');
      return;
    }
    setSending(true);
    try {
      const res = await api.smsSend(to.trim(), body.trim());
      Alert.alert('Success', res.message || 'SMS sent.');
      setModal(false);
      setTo('');
      setBody('');
      load();
    } catch (e) {
      Alert.alert('Error', e.message);
    }
    setSending(false);
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>SMS</Text>
        {status && (
          <View style={[styles.statusDot, { backgroundColor: status.connected ? colors.success : colors.textMuted }]} />
        )}
      </View>

      {status && (
        <View style={[styles.statusBar, status.connected ? styles.statusConnected : styles.statusDisconnected]}>
          <Text style={[styles.statusText, { color: status.connected ? colors.success : colors.textMuted }]}>
            {status.connected ? `Connected — ${status.serial || 'device'}` : (status.error || 'No device connected')}
          </Text>
        </View>
      )}

      <View style={styles.btnRow}>
        <Pressable style={[styles.actionBtn, styles.flex]} onPress={sync} disabled={syncing}>
          {syncing ? <ActivityIndicator size="small" color={colors.gold} /> : <Text style={styles.actionBtnText}>Sync from Phone</Text>}
        </Pressable>
        <Pressable style={[styles.actionBtn, styles.flex]} onPress={() => setModal(true)}>
          <Text style={styles.actionBtnText}>Send SMS</Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.gold} />
        </View>
      ) : messages.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.empty}>No messages synced yet.</Text>
          <Text style={styles.emptySub}>Connect your phone and tap Sync.</Text>
        </View>
      ) : (
        <FlatList
          data={messages}
          keyExtractor={m => m.id?.toString() || Math.random().toString()}
          renderItem={({ item }) => {
            const unread = item.read === 0 && item.direction === 'incoming';
            return (
              <View style={styles.smsItem}>
                <View style={styles.smsRow}>
                  <Text style={styles.smsDir}>{item.direction === 'incoming' ? '↙' : '↗'}</Text>
                  <Text style={[styles.smsFrom, unread && styles.smsFromUnread]} numberOfLines={1}>
                    {item.contact_name || item.contact_number}
                  </Text>
                  <Text style={styles.smsTime}>{fmtTime(item.timestamp)}</Text>
                </View>
                <Text style={styles.smsBody} numberOfLines={2}>
                  {item.body}
                </Text>
              </View>
            );
          }}
          contentContainerStyle={{ paddingBottom: 32 }}
          ItemSeparatorComponent={() => (
            <View style={{ height: 1, backgroundColor: 'rgba(196,154,94,0.08)' }} />
          )}
          onRefresh={load}
          refreshing={loading}
        />
      )}

      {/* Send SMS Modal */}
      <Modal visible={modal} animationType="slide" transparent presentationStyle="overFullScreen">
        <Pressable style={styles.modalBackdrop} onPress={() => setModal(false)}>
          <Pressable style={styles.modalSheet} onPress={e => e.stopPropagation()}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Send SMS</Text>
            <View style={styles.modalRule} />

            <Text style={styles.fieldLabel}>Recipient Number</Text>
            <TextInput
              style={styles.fieldInput}
              value={to}
              onChangeText={setTo}
              placeholder="+1 555 000 0000"
              placeholderTextColor={colors.textMuted}
              keyboardType="phone-pad"
              autoCorrect={false}
            />

            <Text style={[styles.fieldLabel, { marginTop: 14 }]}>Message</Text>
            <TextInput
              style={[styles.fieldInput, styles.fieldTextarea]}
              value={body}
              onChangeText={setBody}
              placeholder="Compose your message..."
              placeholderTextColor={colors.textMuted}
              multiline
            />

            <View style={styles.modalBtns}>
              <Pressable style={styles.cancelBtn} onPress={() => setModal(false)}>
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable style={[styles.sendConfirmBtn, sending && { opacity: 0.5 }]} onPress={sendSms} disabled={sending}>
                {sending ? <ActivityIndicator size="small" color={colors.bg} /> : <Text style={styles.sendConfirmText}>Send</Text>}
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6 },

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
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },

  statusBar: {
    marginHorizontal: 16,
    marginTop: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderRadius: radius.sm,
  },
  statusConnected: { borderColor: 'rgba(90,154,106,0.35)' },
  statusDisconnected: { borderColor: colors.goldRule },
  statusText: {
    fontFamily: fonts.uiSemi,
    fontSize: 11,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },

  btnRow: {
    flexDirection: 'row',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 10,
    marginBottom: 4,
  },
  actionBtn: {
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: colors.goldRule,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(255,255,255,0.03)',
    alignItems: 'center',
    minHeight: 42,
    justifyContent: 'center',
  },
  actionBtnText: {
    fontFamily: fonts.uiSemi,
    fontSize: 11,
    color: colors.gold,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },

  smsItem: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 4,
  },
  smsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  smsDir: {
    fontFamily: fonts.ui,
    fontSize: 13,
    color: colors.textMuted,
  },
  smsFrom: {
    flex: 1,
    fontFamily: fonts.uiSemi,
    fontSize: 13,
    color: colors.text,
  },
  smsFromUnread: { color: colors.gold },
  smsTime: {
    fontFamily: fonts.ui,
    fontSize: 11,
    color: colors.textMuted,
    flexShrink: 0,
  },
  smsBody: {
    fontFamily: fonts.ui,
    fontSize: 13,
    color: colors.textSub,
    lineHeight: 19,
    paddingLeft: 20,
  },

  empty: {
    fontFamily: fonts.serifI,
    fontSize: 15,
    color: colors.textSub,
  },
  emptySub: {
    fontFamily: fonts.ui,
    fontSize: 13,
    color: colors.textMuted,
  },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(3,10,8,0.7)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: 28,
    paddingBottom: 40,
    borderTopWidth: 1,
    borderTopColor: colors.goldRule,
  },
  modalHandle: {
    width: 36,
    height: 4,
    backgroundColor: colors.goldRule,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 20,
  },
  modalTitle: {
    fontFamily: fonts.serif,
    fontSize: 20,
    color: colors.gold,
    marginBottom: 6,
  },
  modalRule: {
    height: 1,
    backgroundColor: colors.goldRule,
    marginBottom: 20,
  },

  fieldLabel: {
    fontFamily: fonts.uiSemi,
    fontSize: 10,
    color: colors.textMuted,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  fieldInput: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.goldRule,
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontFamily: fonts.mono,
    fontSize: 14,
    color: colors.text,
  },
  fieldTextarea: {
    height: 90,
    textAlignVertical: 'top',
  },

  modalBtns: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 20,
  },
  cancelBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.goldRule,
    borderRadius: radius.sm,
    minHeight: 40,
    justifyContent: 'center',
  },
  cancelText: {
    fontFamily: fonts.uiSemi,
    fontSize: 12,
    color: colors.textSub,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  sendConfirmBtn: {
    paddingHorizontal: 24,
    paddingVertical: 10,
    backgroundColor: colors.gold,
    borderRadius: radius.sm,
    minHeight: 40,
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 80,
  },
  sendConfirmText: {
    fontFamily: fonts.uiSemi,
    fontSize: 12,
    color: colors.bg,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
});
