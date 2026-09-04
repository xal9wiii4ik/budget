// The country of the operation, folded away.
//
// Web puts it behind a `<details>` because it is a detail of a minority of rows
// and the user asked for it not to crowd the form; mobile has no `<details>`, so
// this is the same disclosure as a Pressable header + a rendered body. No modal
// library, no navigation: the section stays part of the form and the scroll
// position it opens at is where the user already was.
//
// TWO deliberate departures from web's `<select>`, both because 247 options are a
// different animal on a phone:
//
//   * the chips are ORDERED, not alphabetical-only: "Not set", the value the form
//     currently holds and the profile's own country come first, because those are
//     the three answers that are actually likely. The rest follow in the locale's
//     collation (lib/countryLabel).
//   * a filter field narrows the list, and the list is CAPPED until it does.
//     Mounting 247 Pressables on the JS thread is a visible stall on open, and a
//     247-chip wall is unusable anyway. The cap is honest on screen: the section
//     says out loud that more are hidden and that typing narrows them.
//
// A code outside the shared table (another client's row, an omitted territory)
// stays selectable — `countryOptions(locale, include)` keeps it, the same way
// web's `include` does. Silently dropping it would leave the picker reading "Not
// set" while the form state held a country.
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, spacing, TOUCH_TARGET } from '../../components/theme';
import { FieldError } from '../../components/FieldError';
import { useLocale, useT } from '../../i18n/context';
import { countryOptions } from '../../lib/countryLabel';

// How many countries are offered before the user narrows them.
const VISIBLE_LIMIT = 30;

interface CountryFieldProps {
  /** The form's `country` value: "" = not set. */
  value: string;
  onChange: (code: string) => void;
  /** The country the form STARTED on — kept in the list even if out-of-table. */
  initialValue: string | null;
  /** The profile's country, offered first because it is the likely answer. */
  profileCountry: string | null;
  error?: string;
}

export function CountryField({
  value,
  onChange,
  initialValue,
  profileCountry,
  error,
}: CountryFieldProps) {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');

  // Built once per locale/row: the label of every offered code, collated.
  const all = useMemo(() => countryOptions(locale, initialValue), [locale, initialValue]);

  const priority = [value, profileCountry].filter(
    (code): code is string => typeof code === 'string' && code !== '',
  );

  const needle = filter.trim().toLowerCase();
  const matches = all.filter(
    (option) =>
      !priority.includes(option.code) &&
      (needle === '' ||
        option.label.toLowerCase().includes(needle) ||
        option.code.toLowerCase().includes(needle)),
  );
  const shown = matches.slice(0, VISIBLE_LIMIT);
  const hidden = matches.length - shown.length;

  const head = priority
    .map((code) => all.find((option) => option.code === code))
    .filter((option): option is { code: string; label: string } => option !== undefined);
  const selected = value === '' ? undefined : all.find((option) => option.code === value);

  return (
    <View style={styles.field}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((current) => !current)}
        style={styles.summary}
      >
        <Text style={styles.summaryText}>
          {open ? '▾ ' : '▸ '}
          {t('txForm.moreOptions')}
        </Text>
        {/* What is folded away is still visible when it is set: a hidden country
            on a saved row would otherwise be invisible until someone opened the
            section on the off-chance. */}
        <Text style={styles.summaryValue}>
          {t('txForm.country')}: {selected ? selected.label : t('common.notSet')}
        </Text>
      </Pressable>

      {open ? (
        <View style={styles.body}>
          <Text style={styles.label}>
            {t('txForm.country')} <Text style={styles.hint}>{t('common.optional')}</Text>
          </Text>
          <TextInput
            accessibilityLabel={t('txForm.country')}
            style={styles.filter}
            value={filter}
            onChangeText={setFilter}
            autoCorrect={false}
            autoCapitalize="none"
            placeholder={t('txForm.countryFilter')}
            placeholderTextColor={colors.textMuted}
          />
          <View style={styles.chips}>
            <Chip
              label={t('common.notSet')}
              selected={value === ''}
              onPress={() => onChange('')}
            />
            {head.map((option) => (
              <Chip
                key={option.code}
                label={option.label}
                selected={value === option.code}
                onPress={() => onChange(option.code)}
              />
            ))}
            {shown.map((option) => (
              <Chip
                key={option.code}
                label={option.label}
                selected={value === option.code}
                onPress={() => onChange(option.code)}
              />
            ))}
          </View>
          {hidden > 0 ? <Text style={styles.hint}>{t('txForm.countryMore')}</Text> : null}
          <FieldError message={error} />
        </View>
      ) : null}
    </View>
  );
}

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.chip, selected && styles.chipSelected]}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  field: {
    gap: spacing.xs,
  },
  summary: {
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
    gap: 2,
  },
  summaryText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.primary,
  },
  summaryValue: {
    fontSize: 13,
    color: colors.textMuted,
  },
  body: {
    gap: spacing.sm,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
  },
  hint: {
    fontSize: 12,
    fontWeight: '400',
    color: colors.textMuted,
  },
  filter: {
    minHeight: TOUCH_TARGET,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.card,
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
});
