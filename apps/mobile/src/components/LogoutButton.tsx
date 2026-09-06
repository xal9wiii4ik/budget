// Header logout control for the app shell. Reveals the signed-in email inline (like
// web's shell) and a Log out button; the guard reacts to the flipped snapshot and
// useAuthListener clears the cache. A me-query error surfaces a compact retry rather
// than a silent blank.
import { Pressable, Text, View } from 'react-native';

import { useLogout } from '../auth/useAuth';
import { useMe } from '../auth/useMe';
import { useT } from '../i18n/context';
import { FormButton } from './FormButton';
import { themedStyles } from '../theme/themedStyles';

export function LogoutButton() {
  const styles = useStyles();
  const t = useT();
  const me = useMe();
  const logout = useLogout();

  return (
    <View style={styles.container}>
      {me.isError ? (
        <Pressable accessibilityRole="button" onPress={() => me.refetch()} hitSlop={8}>
          <Text style={styles.retry}>{t('shell.retryAccount')}</Text>
        </Pressable>
      ) : me.data ? (
        <Text style={styles.email} numberOfLines={1}>
          {me.data.email}
        </Text>
      ) : null}
      {/* The header's text action, as the primitive: same look, but with the
          button role, the busy state and the >= 44pt hitSlop the hand-rolled
          Pressable never had (`ghost` exists for exactly these). */}
      <FormButton
        label={t('shell.logout')}
        variant="ghost"
        size="sm"
        pending={logout.isPending}
        onPress={() => logout.mutate()}
      />
    </View>
  );
}

const useStyles = themedStyles((t) => ({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.sm,
    paddingRight: t.spacing.md,
    maxWidth: 220,
  },
  email: {
    fontSize: t.type.xs,
    color: t.colors.textMuted,
    flexShrink: 1,
  },
  retry: {
    fontSize: t.type.sm,
    color: t.colors.danger,
    fontWeight: '600',
  },
}));
