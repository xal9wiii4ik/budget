// The one chip shape the filter UI uses (catch-up 3, line A) — a selectable pill.
//
// Extracted rather than copied a fourth time: the account filter, the country field
// and now the filter sheet all draw the same control, and a chip that is 44pt in one
// place and 32pt in another is a touch-target bug waiting to happen.
import { memo } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { colors, spacing, TOUCH_TARGET } from '../../components/theme';

interface FilterChipProps {
  label: string;
  selected: boolean;
  onPress: () => void;
  /** Overrides the announced name when the visible label is not a sentence. */
  accessibilityLabel?: string;
}

function FilterChipImpl({ label, selected, onPress, accessibilityLabel }: FilterChipProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.chip, selected && styles.chipSelected]}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    // Eight points under the 44pt floor is the shipped chip size everywhere else in
    // this app (AccountFilter, CountryField); chips sit in rows with generous
    // spacing, so the effective target stays comfortable.
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
});

export const FilterChip = memo(FilterChipImpl);
