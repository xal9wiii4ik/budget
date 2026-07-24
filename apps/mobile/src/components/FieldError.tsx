// Inline field/form error text. Rendered under an input or at the form root; a11y
// role 'alert' so screen readers announce validation failures.
import { StyleSheet, Text } from 'react-native';

import { colors, spacing } from './theme';

interface FieldErrorProps {
  message?: string;
}

export function FieldError({ message }: FieldErrorProps) {
  if (!message) return null;
  return (
    <Text accessibilityRole="alert" style={styles.error}>
      {message}
    </Text>
  );
}

const styles = StyleSheet.create({
  error: {
    marginTop: spacing.xs,
    color: colors.danger,
    fontSize: 13,
  },
});
