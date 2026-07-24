// Shared keyboard-aware form wrapper (plan Platform concerns): KeyboardAvoidingView
// (padding on iOS, height on Android) around a ScrollView with
// keyboardShouldPersistTaps='handled' so amount/note/password fields aren't covered
// and a tap on a button while the keyboard is open still registers. Respects the
// bottom safe-area inset.
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, spacing } from './theme';

interface KeyboardAwareFormProps {
  children: ReactNode;
}

export function KeyboardAwareForm({ children }: KeyboardAwareFormProps) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        style={styles.flex}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: spacing.lg,
    gap: spacing.lg,
  },
});
