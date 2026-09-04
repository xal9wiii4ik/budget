// Shared keyboard-aware form wrapper (plan Platform concerns): KeyboardAvoidingView
// (padding on iOS, height on Android) around a ScrollView with
// keyboardShouldPersistTaps='handled' so amount/note/password fields aren't covered
// and a tap on a button while the keyboard is open still registers. The bottom
// safe-area inset is the host screen's SafeAreaView's job, not this wrapper's.
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, spacing } from './theme';

interface KeyboardAwareFormProps {
  children: ReactNode;
  /**
   * D-4: the form's primary actions (Save, and Delete/Archive next to it),
   * rendered OUTSIDE the ScrollView but INSIDE the KeyboardAvoidingView.
   *
   * Inside the scroll content they sat at the very bottom of the tallest forms,
   * i.e. in the home-indicator gesture strip (Save at y 829 of 874 on the
   * transfer edit form), and they were only reachable after a scroll nobody
   * expects to need. Outside it they are pinned above that strip and
   * still lifted by the keyboard, because the avoiding view still wraps them.
   *
   * The footer pays NO safe-area inset of its own: every host screen already
   * wraps this in a SafeAreaView whose `edges` include 'bottom', so adding the
   * inset here would pay it twice and leave a dead band under Save.
   *
   * Optional: the non-form screens that use this wrapper have no such actions.
   */
  footer?: ReactNode;
}

export function KeyboardAwareForm({ children, footer }: KeyboardAwareFormProps) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        style={styles.flex}
        contentContainerStyle={[
          styles.content,
          // With a pinned footer the scroll content only needs breathing room —
          // the footer below it is what sits against the screen's bottom edge.
          { paddingBottom: footer ? spacing.xl : insets.bottom + spacing.xl },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
      {footer ? <View style={styles.footer}>{footer}</View> : null}
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
  footer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
  },
});
