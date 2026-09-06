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
import { Pressable, Text, TextInput, View } from 'react-native';

import { themedStyles } from '../../theme/themedStyles';
import { useTheme } from '../../theme/useTheme';
import { useT } from '../../i18n/context';

interface TxSearchFieldProps {
  /** The RAW typed text — never the trimmed value that reached the query key. */
  value: string;
  onChange: (next: string) => void;
}

export function TxSearchField({ value, onChange }: TxSearchFieldProps) {
  const t = useT();
  const styles = useStyles();
  const { scheme, colors } = useTheme();

  return (
    <View style={styles.row}>
      <TextInput
        accessibilityLabel={t('tx.searchLabel')}
        style={styles.input}
        value={value}
        onChangeText={onChange}
        placeholder={t('tx.searchPlaceholder')}
        placeholderTextColor={colors.textSubtle}
        keyboardAppearance={scheme}
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

const useStyles = themedStyles((t) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.sm,
    paddingHorizontal: t.spacing.lg,
    paddingBottom: t.spacing.sm,
  },
  input: {
    flex: 1,
    minHeight: t.TOUCH_TARGET,
    borderWidth: 1,
    borderColor: t.colors.borderStrong,
    borderRadius: t.radius.md,
    paddingHorizontal: t.spacing.md,
    fontSize: t.type.md,
    color: t.colors.text,
    backgroundColor: t.colors.surface,
  },
  clear: {
    width: t.TOUCH_TARGET,
    height: t.TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clearText: {
    fontSize: t.type.xxl,
    lineHeight: 30,
    color: t.colors.textSubtle,
  },
}));
