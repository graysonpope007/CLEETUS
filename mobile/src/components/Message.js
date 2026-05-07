import React from 'react';
import { View, Text, StyleSheet, Pressable, Clipboard } from 'react-native';
import { colors, fonts, radius } from '../theme';

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function Message({ role, content, ts, streaming }) {
  const isUser = role === 'user';
  const [copied, setCopied] = React.useState(false);

  function copy() {
    Clipboard.setString(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (isUser) {
    return (
      <View style={styles.userRow}>
        <View style={styles.userBubble}>
          <Text style={styles.userText}>{content}</Text>
        </View>
        <Text style={styles.timeRight}>{fmtTime(ts)}</Text>
      </View>
    );
  }

  return (
    <View style={styles.assistantRow}>
      <View style={styles.avatar}>
        <Text style={styles.avatarLetter}>C</Text>
      </View>
      <View style={styles.assistantCol}>
        <Pressable onLongPress={copy} style={styles.assistantBubble}>
          <Text style={styles.assistantText}>
            {streaming ? content + '▌' : content}
          </Text>
          {!streaming && (
            <Text style={styles.copyHint}>{copied ? 'Copied' : ''}</Text>
          )}
        </Pressable>
        <Text style={styles.timeLeft}>{fmtTime(ts)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  userRow: {
    alignSelf: 'flex-end',
    alignItems: 'flex-end',
    maxWidth: '82%',
    gap: 4,
  },
  userBubble: {
    backgroundColor: colors.claret,
    borderTopWidth: 2,
    borderTopColor: colors.gold,
    borderRadius: radius.md,
    borderBottomRightRadius: radius.sm,
    padding: 12,
    paddingHorizontal: 16,
  },
  userText: {
    fontFamily: fonts.mono,
    fontSize: 15,
    lineHeight: 23,
    color: colors.text,
  },
  timeRight: {
    fontFamily: fonts.ui,
    fontSize: 10,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  assistantRow: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    maxWidth: '88%',
  },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.surface3,
    borderWidth: 1,
    borderColor: colors.goldRule,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
    flexShrink: 0,
  },
  avatarLetter: {
    fontFamily: fonts.serif,
    fontSize: 13,
    color: colors.gold,
  },
  assistantCol: {
    flex: 1,
    gap: 4,
  },
  assistantBubble: {
    backgroundColor: colors.surface,
    borderLeftWidth: 2,
    borderLeftColor: colors.gold,
    borderRadius: radius.md,
    borderTopLeftRadius: radius.sm,
    padding: 12,
    paddingHorizontal: 16,
  },
  assistantText: {
    fontFamily: fonts.mono,
    fontSize: 15,
    lineHeight: 24,
    color: colors.text,
  },
  copyHint: {
    fontFamily: fonts.uiSemi,
    fontSize: 10,
    color: colors.gold,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 4,
    textAlign: 'right',
  },
  timeLeft: {
    fontFamily: fonts.ui,
    fontSize: 10,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingLeft: 2,
  },
});
