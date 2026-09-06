// A labelled DATE control (mobile-catchup-3, line C): the button + native picker
// the transaction form already uses, extracted because the goals screens need it
// four times over (a goal deadline, an item deadline, a reminder date, a
// contribution date) and three of them are CLEARABLE — an empty date is a real
// value there ("no deadline of its own", "no fixed reminder"), not a missing one.
//
// The value on the wire is always an API date string ("YYYY-MM-DD") or "" for
// none; `Date` exists only between the picker and `toApiDate`. Calendar
// components are built with `new Date(y, m - 1, d)` (the house `dates.ts`
// pattern) — never an ISO parse, which would shift the day in negative offsets.
//
// It is the ONLY date control in the app: the recurring form's own copy folded into
// it (catch-up 3 close), which is where `notice` comes from — an advisory sentence
// about a LEGAL value ("the first charge will actually land on…", "that end date has
// passed"). It is deliberately not styled as an error: it never blocks Save, so it
// reads in the accent tone under the hint, and the error line stays below it.
import DateTimePicker, {
  type DateTimePickerChangeEvent,
} from '@react-native-community/datetimepicker';
import { formatApiDate, toApiDate, todayApiDate } from '@budget/shared';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { FieldError } from './FieldError';
import { FormButton } from './FormButton';
import { colors, spacing, TOUCH_TARGET } from './theme';
import { useLocale, useT } from '../i18n/context';

interface DateFieldProps {
  label: string;
  /** "YYYY-MM-DD", or "" for "no date". */
  value: string;
  onChange: (next: string) => void;
  hint?: string;
  /** Advisory, about a legal value — never a reason Save is blocked (see above). */
  notice?: string;
  error?: string;
  /** Offer "clear": only where an empty date is a meaningful answer. */
  clearable?: boolean;
}

function apiDateToLocalDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function DateField({
  label,
  value,
  onChange,
  hint,
  notice,
  error,
  clearable = false,
}: DateFieldProps) {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);

  const onPicked = (_event: DateTimePickerChangeEvent, date: Date) => {
    if (Platform.OS !== 'ios') setOpen(false);
    onChange(toApiDate(date));
  };

  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={() => setOpen(true)}
          style={styles.button}
        >
          <Text style={value === '' ? styles.placeholder : styles.value}>
            {value === '' ? t('common.notSet') : formatApiDate(value, { locale })}
          </Text>
        </Pressable>
        {clearable && value !== '' ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setOpen(false);
              onChange('');
            }}
            style={styles.clear}
          >
            <Text style={styles.clearText}>{t('common.remove')}</Text>
          </Pressable>
        ) : null}
      </View>
      {open ? (
        <>
          <DateTimePicker
            // With no date yet, the picker has to open SOMEWHERE: today is the
            // only honest starting point, and it is not written anywhere until
            // the user actually picks.
            value={apiDateToLocalDate(value === '' ? todayApiDate() : value)}
            mode="date"
            // D-3: without an explicit locale the native picker follows the DEVICE
            // language ("September 2026", "MON TUE") under a Russian UI. The prop is
            // iOS-only in this library; Android's dialog reads the app's own locale,
            // so there is nothing to pass there.
            locale={locale}
            display={Platform.OS === 'ios' ? 'inline' : 'default'}
            onValueChange={onPicked}
            onDismiss={() => setOpen(false)}
          />
          {Platform.OS === 'ios' ? (
            <FormButton
              label={t('common.done')}
              variant="secondary"
              onPress={() => setOpen(false)}
            />
          ) : null}
        </>
      ) : null}
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      {notice ? (
        <Text accessibilityRole="alert" style={styles.notice}>
          {notice}
        </Text>
      ) : null}
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  button: {
    flex: 1,
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.card,
  },
  value: {
    fontSize: 16,
    color: colors.text,
  },
  placeholder: {
    fontSize: 16,
    color: colors.textMuted,
  },
  clear: {
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
  },
  clearText: {
    fontSize: 14,
    color: colors.primary,
  },
  hint: {
    fontSize: 12,
    color: colors.textMuted,
  },
  notice: {
    fontSize: 13,
    color: colors.primary,
  },
});
