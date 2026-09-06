// Prev/next month stepper. Shifts via the shared shiftMonth (year rollover handled
// there) and shows the localized month label. Chevron targets are >= 44pt.
import { formatMonthLabel, shiftMonth } from '@budget/shared';
import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';

import { themedStyles } from '../../theme/themedStyles';
import { useLocale, useT } from '../../i18n/context';

interface MonthPickerProps {
  month: string; // "YYYY-MM"
  onChange: (month: string) => void;
}

function MonthPickerImpl({ month, onChange }: MonthPickerProps) {
  const t = useT();
  const styles = useStyles();
  const locale = useLocale();

  return (
    <View style={styles.picker}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('tx.previousMonth')}
        onPress={() => onChange(shiftMonth(month, -1))}
        style={styles.nav}
      >
        <Text style={styles.chevron}>‹</Text>
      </Pressable>
      <Text style={styles.label}>{formatMonthLabel(month, { locale })}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('tx.nextMonth')}
        onPress={() => onChange(shiftMonth(month, 1))}
        style={styles.nav}
      >
        <Text style={styles.chevron}>›</Text>
      </Pressable>
    </View>
  );
}

const useStyles = themedStyles((t) => ({
  picker: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  nav: {
    width: t.TOUCH_TARGET,
    height: t.TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chevron: {
    fontSize: t.type.xxl,
    color: t.colors.accent,
    lineHeight: 30,
  },
  label: {
    flex: 1,
    textAlign: 'center',
    fontSize: t.type.lg,
    fontWeight: '600',
    color: t.colors.text,
  },
}));

export const MonthPicker = memo(MonthPickerImpl);
