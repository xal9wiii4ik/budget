// A "pick at most one of these" section for the filter sheet (catch-up 3, line A).
//
// Web renders category and country as two `<select>`s. A phone has no such control
// worth the name, and 247 countries are a different animal from 4 sort orders, so
// this section carries the CountryField compromise that shipped in catch-up 2:
//
//   * an optional filter field narrows the options, and the list is CAPPED until it
//     does. Mounting 247 Pressables on the JS thread is a visible stall, and a
//     247-chip wall is unusable anyway. The cap is stated on screen — it is never a
//     silent truncation.
//   * the SELECTED option is pinned first and is never hidden by the cap or the
//     filter. A picker that shows nothing selected while the screen is filtered by
//     it lies about what is on the list below.
//
// Without `search` it is a plain chip row (the sort order), which is why the filter
// field and the cap are optional rather than a second component.
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, spacing, TOUCH_TARGET } from '../../components/theme';
import { FilterChip } from './FilterChip';

export interface ChipOption {
  value: string;
  label: string;
}

interface ChipPickerProps {
  label: string;
  options: ChipOption[];
  /** null = nothing picked; the `allLabel` chip is the one selected. */
  value: string | null;
  onChange: (next: string | null) => void;
  /** The "no filter" chip. */
  allLabel: string;
  /**
   * What to call a value the options do not carry — an id this session cannot
   * resolve. Required, because the alternative (dropping the chip) makes the section
   * read "All" while the list below is filtered, which is a lie about what is on
   * screen. The country picker never reaches it: `countryOptions(locale, include)`
   * keeps an out-of-table code in the list.
   */
  unknownLabel: string;
  /** Present = a narrowing field above the chips, plus the cap below. */
  search?: { placeholder: string; moreHint: string; cap: number };
}

export function ChipPicker({
  label,
  options,
  value,
  onChange,
  allLabel,
  unknownLabel,
  search,
}: ChipPickerProps) {
  const [filter, setFilter] = useState('');

  // The picked option leads, always — see the header.
  const selected = value === null ? undefined : options.find((option) => option.value === value);

  const needle = filter.trim().toLowerCase();
  const rest = options.filter(
    (option) =>
      option.value !== value &&
      (needle === '' ||
        option.label.toLowerCase().includes(needle) ||
        option.value.toLowerCase().includes(needle)),
  );
  const shown = search === undefined ? rest : rest.slice(0, search.cap);
  const hidden = rest.length - shown.length;

  return (
    <View style={styles.section}>
      <Text style={styles.label}>{label}</Text>
      {search === undefined ? null : (
        <TextInput
          accessibilityLabel={label}
          style={styles.filter}
          value={filter}
          onChangeText={setFilter}
          autoCorrect={false}
          autoCapitalize="none"
          placeholder={search.placeholder}
          placeholderTextColor={colors.textMuted}
        />
      )}
      <View style={styles.chips}>
        <FilterChip label={allLabel} selected={value === null} onPress={() => onChange(null)} />
        {/* A filtered value the option list does not carry (an id archived away in
            another session, a country outside the shared table) still gets a chip —
            with an honest label — instead of the section quietly reading "All". */}
        {value !== null && selected === undefined ? (
          <FilterChip label={unknownLabel} selected onPress={() => onChange(null)} />
        ) : null}
        {selected === undefined ? null : (
          <FilterChip label={selected.label} selected onPress={() => onChange(null)} />
        )}
        {shown.map((option) => (
          <FilterChip
            key={option.value}
            label={option.label}
            selected={false}
            onPress={() => onChange(option.value)}
          />
        ))}
      </View>
      {search !== undefined && hidden > 0 ? (
        <Text style={styles.hint}>{search.moreHint}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: spacing.sm,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
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
  hint: {
    fontSize: 12,
    color: colors.textMuted,
  },
});
