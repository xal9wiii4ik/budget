// Inline field/form error text. Rendered under an input or at the form root; a11y
// role 'alert' so screen readers announce validation failures.
//
// It is ALSO the anchor for scroll-to-first-error (N-2 / N-1): a rendered
// FieldError registers itself with the surrounding KeyboardAwareForm for as long
// as it has a message, so the wrapper can measure where the topmost error is
// without every form having to tag its fields. Outside a KeyboardAwareForm the
// registration is a no-op — the component keeps working unchanged.
import { useEffect, useRef } from 'react';
import { Text } from 'react-native';

import { useFormScroll, type MeasurableNode } from './KeyboardAwareForm';
import { themedStyles } from '../theme/themedStyles';

interface FieldErrorProps {
  message?: string;
}

export function FieldError({ message }: FieldErrorProps) {
  const styles = useStyles();
  const { registerError } = useFormScroll();
  const node = useRef<MeasurableNode | null>(null);

  useEffect(() => {
    // `message` is in the deps because this component returns null without one:
    // the ref is filled by the render that shows the text and cleared by the one
    // that hides it, and the registration has to follow.
    const current = node.current;
    if (!message || !current) return;
    return registerError(current);
  }, [message, registerError]);

  if (!message) return null;
  return (
    <Text
      accessibilityRole="alert"
      ref={(instance) => {
        node.current = instance;
      }}
      style={styles.error}
    >
      {message}
    </Text>
  );
}

const useStyles = themedStyles((t) => ({
  error: {
    marginTop: t.spacing.xs,
    color: t.colors.danger,
    fontSize: t.type.sm,
  },
}));
