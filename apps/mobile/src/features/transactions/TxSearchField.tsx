// The transaction list's search box (catch-up 3, line A).
//
// Web's version is a controlled mirror of `?q=` and needs `adoptsUrlSearchText` to
// tell its own debounced commit from a real external change (the back button, a
// shared link). Mobile has no URL, so there is no second writer of the search text:
// this field OWNS its string, and the screen debounces + trims it into the query key
// (`useDebouncedValue`, then `txListFilters`). That is why the render-time resync
// dance is absent here rather than ported.
//
// The clear button is a real 44pt target, not a glyph inside the input: a `×` sized
// to the text would be unhittable on a phone.
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, spacing, TOUCH_TARGET } from '../../components/theme';
import { useT } from '../../i18n/context';

interface TxSearchFieldProps {
  /** The RAW typed text — never the trimmed value that reached the query key. */
  value: string;
  onChange: (next: string) => void;
}

export function TxSearchField({ value, onChange }: TxSearchFieldProps) {
  const t = useT();

  return (
    <View style={styles.row}>
      <TextInput
        accessibilityLabel={t('tx.searchLabel')}
        style={styles.input}
        value={value}
        onChangeText={onChange}
        placeholder={t('tx.searchPlaceholder')}
        placeholderTextColor={colors.textMuted}
        autoCorrect={false}
        autoCapitalize="none"
        // A search field, so the keyboard's return key says so and dismisses
        // instead of inserting a newline; the value is already live.
        returnKeyType="search"
        clearButtonMode="never"
      />
      {value === '' ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('tx.searchClear')}
          onPress={() => onChange('')}
          style={styles.clear}
        >
          <Text style={styles.clearText}>×</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  input: {
    flex: 1,
    minHeight: TOUCH_TARGET,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.card,
  },
  clear: {
    width: TOUCH_TARGET,
    height: TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clearText: {
    fontSize: 24,
    lineHeight: 26,
    color: colors.textMuted,
  },
});
