// The pending / empty / error arm every screen hand-rolled (a centred box, a
// title, a sentence, sometimes a button). One component so the three arms of a
// screen cannot drift apart in spacing or colour.
//
// `role="alert"` is for the ERROR arm: it makes the screen reader announce the
// failure instead of leaving it as silent decoration. Retry lives in `action`,
// so an error is never a dead end (a phone network is flaky by definition).
import type { ReactNode } from 'react';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { themedStyles } from '../theme/themedStyles';

interface EmptyStateProps {
  title: string;
  description?: string;
  /** Usually a `FormButton` — the way out of the state. */
  action?: ReactNode;
  role?: 'alert';
  style?: StyleProp<ViewStyle>;
}

export function EmptyState({ title, description, action, role, style }: EmptyStateProps) {
  const styles = useStyles();
  return (
    <View accessibilityRole={role} style={[styles.box, style]}>
      <Text style={styles.title}>{title}</Text>
      {description ? <Text style={styles.description}>{description}</Text> : null}
      {action ? <View style={styles.action}>{action}</View> : null}
    </View>
  );
}

const useStyles = themedStyles((t) => ({
  box: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: t.spacing.sm,
    paddingHorizontal: t.spacing.lg,
    paddingVertical: t.spacing.xl,
  },
  title: {
    fontSize: t.type.md,
    fontWeight: '600',
    color: t.colors.text,
    textAlign: 'center',
  },
  description: {
    fontSize: t.type.sm,
    color: t.colors.textMuted,
    textAlign: 'center',
  },
  action: {
    marginTop: t.spacing.xs,
  },
}));
