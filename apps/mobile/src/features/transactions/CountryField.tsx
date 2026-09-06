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
import { Pressable, Text, TextInput, View } from 'react-native';

import { themedStyles } from '../../theme/themedStyles';
import { useTheme } from '../../theme/useTheme';
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
  const styles = useStyles();
  const { scheme, colors } = useTheme();
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
            placeholderTextColor={colors.textSubtle}
            keyboardAppearance={scheme}
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
  const styles = useStyles();
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

const useStyles = themedStyles((t) => ({
  field: {
    gap: t.spacing.xs,
  },
  summary: {
    minHeight: t.TOUCH_TARGET,
    justifyContent: 'center',
    gap: 2,
  },
  summaryText: {
    fontSize: t.type.md,
    fontWeight: '600',
    color: t.colors.accent,
  },
  summaryValue: {
    fontSize: t.type.sm,
    color: t.colors.textMuted,
  },
  body: {
    gap: t.spacing.sm,
  },
  label: {
    fontSize: t.type.sm,
    fontWeight: '600',
    color: t.colors.text,
  },
  hint: {
    fontSize: t.type.xs,
    fontWeight: '400',
    color: t.colors.textMuted,
  },
  filter: {
    minHeight: t.TOUCH_TARGET,
    borderWidth: 1,
    borderColor: t.colors.borderStrong,
    borderRadius: t.radius.md,
    paddingHorizontal: t.spacing.md,
    fontSize: t.type.md,
    color: t.colors.text,
    backgroundColor: t.colors.surface,
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
}));
