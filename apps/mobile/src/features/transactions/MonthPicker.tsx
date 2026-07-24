// Prev/next month stepper. Shifts via the shared shiftMonth (year rollover handled
// there) and shows the localized month label. Chevron targets are >= 44pt.
import { formatMonthLabel, shiftMonth } from '@budget/shared';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, TOUCH_TARGET } from '../../components/theme';
import { APP_LOCALE } from '../../lib/locale';

interface MonthPickerProps {
  month: string; // "YYYY-MM"
  onChange: (month: string) => void;
}

function MonthPickerImpl({ month, onChange }: MonthPickerProps) {
  return (
    <View style={styles.picker}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Previous month"
        onPress={() => onChange(shiftMonth(month, -1))}
        style={styles.nav}
      >
        <Text style={styles.chevron}>‹</Text>
      </Pressable>
      <Text style={styles.label}>{formatMonthLabel(month, { locale: APP_LOCALE })}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Next month"
        onPress={() => onChange(shiftMonth(month, 1))}
        style={styles.nav}
      >
        <Text style={styles.chevron}>›</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  picker: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  nav: {
    width: TOUCH_TARGET,
    height: TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chevron: {
    fontSize: 28,
    color: colors.primary,
    lineHeight: 30,
  },
  label: {
    flex: 1,
    textAlign: 'center',
    fontSize: 17,
    fontWeight: '600',
    color: colors.text,
  },
});

export const MonthPicker = memo(MonthPickerImpl);
