// The currency the money was SPENT in: chips over the currencies this user deals
// in, plus "Other…" which reveals a three-letter code field.
//
// Chips, not a modal list: the same control the category and account pickers
// already use on these screens, and `spendCurrencyOptions` (@budget/shared) keeps
// the list short and personal — the account's own currency first (the way BACK to
// a one-amount operation, so it must always be one tap away), then the profile
// country's, then the currencies the user holds accounts in, then the tracked
// set.
//
// The escape hatch is load-bearing, exactly as on web: the list is a SUGGESTION,
// not a whitelist (D7). We store six FX pairs, validation is format-only on both
// sides, and a JPY receipt must not become unrepresentable because JPY is not one
// of this user's account currencies.
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, spacing, TOUCH_TARGET } from '../../components/theme';
import { useT } from '../../i18n/context';

interface SpendCurrencyPickerProps {
  /** The code the form currently holds (may be half-typed in "other" mode). */
  value: string;
  /** Codes to offer, in order — `spendCurrencyOptions` from @budget/shared. */
  suggestions: readonly string[];
  /** The new code, already the user's final say for this keystroke/pick. */
  onChange: (code: string) => void;
  /** Spoken name of the free-text field; the chips carry their own code. */
  otherLabel: string;
}

export function SpendCurrencyPicker({
  value,
  suggestions,
  onChange,
  otherLabel,
}: SpendCurrencyPickerProps) {
  const t = useT();
  // The ONE thing this control remembers: "the user asked for the free-text
  // field". Everything else on screen is derived from it and the form's value.
  const [otherRequested, setOtherRequested] = useState(false);

  return (
    <View style={styles.control}>
      <View style={styles.chips}>
        {suggestions.map((code) => (
          <Pressable
            key={code}
            accessibilityRole="button"
            accessibilityState={{ selected: !otherRequested && code === value }}
            onPress={() => {
              setOtherRequested(false);
              onChange(code);
            }}
            style={[
              styles.chip,
              !otherRequested && code === value ? styles.chipSelected : null,
            ]}
          >
            <Text
              style={[
                styles.chipText,
                !otherRequested && code === value ? styles.chipTextSelected : null,
              ]}
            >
              {code}
            </Text>
          </Pressable>
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: otherRequested }}
          // No value change: the code stays what it was until the user types one,
          // so asking for "other" can never write half a currency into the form
          // (and never flips the amount fields on its own).
          onPress={() => setOtherRequested(true)}
          style={[styles.chip, otherRequested ? styles.chipSelected : null]}
        >
          <Text style={[styles.chipText, otherRequested ? styles.chipTextSelected : null]}>
            {t('txForm.spendCurrencyOther')}
          </Text>
        </Pressable>
      </View>
      {otherRequested ? (
        <TextInput
          accessibilityLabel={otherLabel}
          style={styles.code}
          maxLength={3}
          autoCapitalize="characters"
          autoCorrect={false}
          spellCheck={false}
          placeholder="JPY"
          placeholderTextColor={colors.textMuted}
          value={value}
          // Uppercased on the way in so a typed "eur" is the same choice as a
          // tapped "EUR" (the schema and the server are both uppercase-only).
          onChangeText={(text) => onChange(text.toUpperCase())}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  control: {
    gap: spacing.sm,
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
  code: {
    minHeight: TOUCH_TARGET,
    width: 120,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.card,
  },
});
