// One labelled account picker for the money forms (accounts-and-transfers MOB).
// The RN analogue of web's AccountField: it renders the states a money form can be
// in, once, so no form re-decides them —
//
//   error        — the message with a Retry next to it (a flaky mobile network is
//                  a recoverable state, never a dead end);
//   empty        — the dead end with the way out on it (there is no valid body to
//                  submit without an account, so the host form disables Save);
//   ready        — the chips.
//
// LOADING is deliberately not an arm here: an account decides the currency the
// whole form is denominated in, so the host screen holds the form back until the
// list has landed (and its defaults are then computed from real data instead of
// from an empty list).
//
// NOT memoized: this is a form field, not a virtualized-list row — its host
// re-renders only when a watched form value changes.
//
// Chips rather than a modal list: the same control the category picker already
// uses on these screens, and the account count is small by nature. Archived
// accounts are NOT offered — except the one already selected on an edit, which
// stays visible so changing a note does not force the row onto another account.
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { FieldError } from './FieldError';
import { FormButton } from './FormButton';
import { colors, spacing, TOUCH_TARGET } from './theme';
import type { AccountRead } from '../data/accounts';
import { selectableAccounts } from '../data/accountLookup';

interface AccountPickerProps {
  label: string;
  /** Already display-sorted (data/accountLookup sortForDisplay). */
  accounts: AccountRead[];
  isError: boolean;
  onRetry: () => void;
  value: string;
  onChange: (accountId: string) => void;
  /** The account stored on the row being edited — kept selectable when archived. */
  currentId?: string | null;
  hint?: string;
  error?: string;
}

export function AccountPicker({
  label,
  accounts,
  isError,
  onRetry,
  value,
  onChange,
  currentId,
  hint,
  error,
}: AccountPickerProps) {
  const options = selectableAccounts(accounts, currentId);

  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>

      {isError ? (
        <View style={styles.stateBox}>
          <Text accessibilityRole="alert" style={styles.errorText}>
            Couldn&apos;t load your accounts.
          </Text>
          <FormButton label="Retry" variant="secondary" onPress={onRetry} />
        </View>
      ) : options.length === 0 ? (
        <Text style={styles.notice}>
          You have no account to record this on — add one on the Accounts tab first.
        </Text>
      ) : (
        <View style={styles.chips}>
          {options.map((account) => (
            <Pressable
              key={account.id}
              accessibilityRole="button"
              accessibilityState={{ selected: account.id === value }}
              onPress={() => onChange(account.id)}
              style={[styles.chip, account.id === value && styles.chipSelected]}
            >
              <Text
                style={[styles.chipText, account.id === value && styles.chipTextSelected]}
              >
                {account.type === 'cash' ? '💵 ' : '💳 '}
                {account.name} · {account.currency}
                {account.archived ? ' (archived)' : ''}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      <FieldError message={error} />
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    gap: spacing.xs,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
  },
  stateBox: {
    gap: spacing.sm,
  },
  errorText: {
    color: colors.danger,
    fontSize: 14,
  },
  notice: {
    color: colors.textMuted,
    fontSize: 14,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chip: {
    minHeight: TOUCH_TARGET - 8,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    justifyContent: 'center',
  },
  chipSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  chipText: {
    fontSize: 14,
    color: colors.text,
  },
  chipTextSelected: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  hint: {
    fontSize: 12,
    color: colors.textMuted,
  },
});
