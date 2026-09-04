// Labeled TextInput with an inline error slot. Presentational: the screen wires it
// to react-hook-form via a Controller and passes value/onChangeText/onBlur. Keeps a
// consistent field layout across every form screen.
import { forwardRef } from 'react';
import { StyleSheet, Text, TextInput, type TextInputProps, View } from 'react-native';

import { FieldError } from './FieldError';
import { colors, spacing, TOUCH_TARGET } from './theme';

interface LabeledInputProps extends TextInputProps {
  label: string;
  error?: string;
  hint?: string;
}

export const LabeledInput = forwardRef<TextInput, LabeledInputProps>(function LabeledInput(
  { label, error, hint, style, accessibilityLabel, ...inputProps },
  ref,
) {
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
        placeholderTextColor={colors.textMuted}
        {...inputProps}
      />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      <FieldError message={error} />
    </View>
  );
});

const styles = StyleSheet.create({
  field: {
    gap: spacing.xs,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
  },
  input: {
    minHeight: TOUCH_TARGET,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.card,
  },
  inputError: {
    borderColor: colors.danger,
  },
  hint: {
    fontSize: 12,
    color: colors.textMuted,
  },
});
