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
import { Text, TextInput, View } from 'react-native';

import { themedStyles } from '../../theme/themedStyles';
import { useTheme } from '../../theme/useTheme';
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
  const styles = useStyles();
  const { scheme, colors } = useTheme();
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
          placeholderTextColor={colors.textSubtle}
          keyboardAppearance={scheme}
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

const useStyles = themedStyles((t) => ({
  section: {
    gap: t.spacing.sm,
  },
  label: {
    fontSize: t.type.sm,
    fontWeight: '600',
    color: t.colors.text,
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
  hint: {
    fontSize: t.type.xs,
    color: t.colors.textMuted,
  },
}));
