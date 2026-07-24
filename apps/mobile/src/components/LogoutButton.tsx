// Header logout control for the app shell. Reveals the signed-in email inline (like
// web's shell) and a Log out button; the guard reacts to the flipped snapshot and
// useAuthListener clears the cache. A me-query error surfaces a compact retry rather
// than a silent blank.
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useLogout } from '../auth/useAuth';
import { useMe } from '../auth/useMe';
import { colors, spacing, TOUCH_TARGET } from './theme';

export function LogoutButton() {
  const me = useMe();
  const logout = useLogout();

  return (
    <View style={styles.container}>
      {me.isError ? (
        <Pressable accessibilityRole="button" onPress={() => me.refetch()} hitSlop={8}>
          <Text style={styles.retry}>Retry account</Text>
        </Pressable>
      ) : me.data ? (
        <Text style={styles.email} numberOfLines={1}>
          {me.data.email}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        disabled={logout.isPending}
        onPress={() => logout.mutate()}
        style={styles.button}
        hitSlop={8}
      >
        <Text style={styles.buttonText}>{logout.isPending ? '…' : 'Log out'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingRight: spacing.md,
    maxWidth: 220,
  },
  email: {
    fontSize: 12,
    color: colors.textMuted,
    flexShrink: 1,
  },
  retry: {
    fontSize: 13,
    color: colors.danger,
    fontWeight: '600',
  },
  button: {
    minHeight: TOUCH_TARGET - 12,
    justifyContent: 'center',
  },
  buttonText: {
    fontSize: 14,
    color: colors.primary,
    fontWeight: '600',
  },
});
