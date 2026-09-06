// The one chip shape the filter UI uses (catch-up 3, line A) — a selectable pill.
//
// Extracted rather than copied a fourth time: the account filter, the country field
// and now the filter sheet all draw the same control, and a chip that is 44pt in one
// place and 32pt in another is a touch-target bug waiting to happen.
import { memo } from 'react';
import { Pressable, Text } from 'react-native';

import { themedStyles } from '../../theme/themedStyles';

interface FilterChipProps {
  label: string;
  selected: boolean;
  onPress: () => void;
  /** Overrides the announced name when the visible label is not a sentence. */
  accessibilityLabel?: string;
}

function FilterChipImpl({ label, selected, onPress, accessibilityLabel }: FilterChipProps) {
  const styles = useStyles();
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

const useStyles = themedStyles((t) => ({
  chip: {
    // Eight points under the 44pt floor is the shipped chip size everywhere else in
    // this app (AccountFilter, CountryField); chips sit in rows with generous
    // spacing, so the effective target stays comfortable.
    minHeight: t.TOUCH_TARGET - 8,
    paddingHorizontal: t.spacing.md,
    paddingVertical: t.spacing.sm,
    borderRadius: t.radius.full,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
    justifyContent: 'center',
  },
  // Soft fill + an accent BORDER: dark accentSoft on a raised surface is a 1.04
  // contrast on its own, and a finger has no hover to fall back on.
  chipSelected: t.selected.chip,
  chipText: {
    fontSize: t.type.sm,
    color: t.colors.text,
  },
  chipTextSelected: t.selected.text,
}));

export const FilterChip = memo(FilterChipImpl);
