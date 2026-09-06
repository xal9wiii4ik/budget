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
import { Pressable, Text, View } from 'react-native';

import { EmptyState } from './EmptyState';
import { FieldError } from './FieldError';
import { FormButton } from './FormButton';
import { themedStyles } from '../theme/themedStyles';
import type { AccountRead } from '../data/accounts';
import { selectableAccounts } from '../data/accountLookup';
import { useT } from '../i18n/context';

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
  const styles = useStyles();
  const t = useT();
  const options = selectableAccounts(accounts, currentId);

  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>

      {isError ? (
        <EmptyState
          role="alert"
          style={styles.stateBox}
          title={t('accounts.loadFailed')}
          action={
            <FormButton label={t('common.retry')} variant="secondary" onPress={onRetry} />
          }
        />
      ) : options.length === 0 ? (
        <Text style={styles.notice}>{t('accounts.noneToRecordOn')}</Text>
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
                {account.archived ? ` ${t('common.archivedParens')}` : ''}
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

const useStyles = themedStyles((t) => ({
  field: {
    gap: t.spacing.xs,
  },
  label: {
    fontSize: t.type.sm,
    fontWeight: '600',
    color: t.colors.text,
  },
  // The error arm sits INSIDE a form field, not on an empty screen: the shared
  // vertical padding would push the fields below it out of reach.
  stateBox: {
    alignItems: 'flex-start',
    paddingHorizontal: 0,
    paddingVertical: t.spacing.sm,
  },
  notice: {
    color: t.colors.textMuted,
    fontSize: t.type.sm,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: t.spacing.sm,
  },
  chip: {
    minHeight: t.TOUCH_TARGET - 8,
    paddingHorizontal: t.spacing.md,
    paddingVertical: t.spacing.sm,
    borderRadius: t.radius.full,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
    justifyContent: 'center',
  },
  chipSelected: t.selected.chip,
  chipText: {
    fontSize: t.type.sm,
    color: t.colors.text,
  },
  chipTextSelected: t.selected.text,
  hint: {
    fontSize: t.type.xs,
    color: t.colors.textMuted,
  },
}));
