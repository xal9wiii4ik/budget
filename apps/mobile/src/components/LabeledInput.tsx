// Labeled TextInput with an inline error slot. Presentational: the screen wires it
// to react-hook-form via a Controller and passes value/onChangeText/onBlur. Keeps a
// consistent field layout across every form screen.
import { forwardRef } from 'react';
import { Text, TextInput, type TextInputProps, View } from 'react-native';

import { FieldError } from './FieldError';
import { themedStyles } from '../theme/themedStyles';
import { useTheme } from '../theme/useTheme';

interface LabeledInputProps extends TextInputProps {
  label: string;
  error?: string;
  hint?: string;
}

export const LabeledInput = forwardRef<TextInput, LabeledInputProps>(function LabeledInput(
  { label, error, hint, style, accessibilityLabel, ...inputProps },
  ref,
) {
  const styles = useStyles();
  const { scheme, colors } = useTheme();
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        ref={ref}
        // D-3: the visible <Text> above is a SIBLING, so VoiceOver announced the
        // value with no name at all ("120.00", never "Amount sent"). RN has no
        // htmlFor, so the name has to be handed to the input itself — every call
        // site already passes a string `label`, and one that needs a different
        // spoken name (an abbreviated or symbol label) overrides it explicitly.
        accessibilityLabel={accessibilityLabel ?? label}
        style={[styles.input, error ? styles.inputError : null, style]}
        placeholderTextColor={colors.textSubtle}
        // iOS-only: without it a dark UI still raises the light keyboard.
        // Before the spread so a call site can still override it.
        keyboardAppearance={scheme}
        {...inputProps}
      />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      <FieldError message={error} />
    </View>
  );
});

const useStyles = themedStyles((t) => ({
  field: {
    gap: t.spacing.xs,
  },
  label: {
    fontSize: t.type.sm,
    fontWeight: '600',
    color: t.colors.text,
  },
  input: {
    minHeight: t.TOUCH_TARGET,
    borderWidth: 1,
    // borderStrong, not border: an input's edge is the affordance that says it
    // is typeable, and the hairline surface border does not read as one.
    borderColor: t.colors.borderStrong,
    borderRadius: t.radius.md,
    paddingHorizontal: t.spacing.md,
    paddingVertical: t.spacing.sm,
    fontSize: t.type.md,
    color: t.colors.text,
    backgroundColor: t.colors.surface,
  },
  inputError: {
    borderColor: t.colors.danger,
  },
  hint: {
    fontSize: t.type.xs,
    color: t.colors.textMuted,
  },
}));
