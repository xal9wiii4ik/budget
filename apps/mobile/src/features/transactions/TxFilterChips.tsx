// What the list is filtered by, in words, right above the rows it stops applying to
// (catch-up 3, line A) — web's chips row, with the same membership.
//
// Which filters get a chip and which do not is web's rule, kept deliberately:
//   * the ACCOUNT does (its own control is a scrolling chip row and the selected one
//     can be scrolled off screen);
//   * the CATEGORY and the COUNTRY do — they are only visible inside the closed
//     filter sheet;
//   * the SEARCH does not — the box above shows it verbatim and clears it;
//   * the SORT does not — it is not why rows are missing, and the sheet button
//     badges it.
//
// The summary caveat is the last line, and it is tied to the summary being ON SCREEN
// at all: in all-time and custom-period modes there are no totals above to caveat.
import { Pressable, Text, View } from 'react-native';

import { themedStyles } from '../../theme/themedStyles';
import { useT } from '../../i18n/context';

interface TxFilterChipsProps {
  /** The filtered account's NAME, or null when no account filter is on. */
  accountName: string | null;
  onClearAccount: () => void;
  /** The filtered category's name (archived-marked), or null. */
  categoryName: string | null;
  onClearCategory: () => void;
  /** The filtered country's label in the UI language, or null. */
  countryName: string | null;
  onClearCountry: () => void;
  /** Whether the month summary is above this row — the caveat's precondition. */
  summaryOnScreen: boolean;
}

export function TxFilterChips({
  accountName,
  onClearAccount,
  categoryName,
  onClearCategory,
  countryName,
  onClearCountry,
  summaryOnScreen,
}: TxFilterChipsProps) {
  const t = useT();
  const styles = useStyles();

  const anyChip = accountName !== null || categoryName !== null || countryName !== null;
  if (!anyChip) return null;

  return (
    <View style={styles.row}>
      {accountName === null ? null : (
        <ClearChip
          label={t('tx.filterChip', { account: accountName })}
          clearLabel={t('accounts.all')}
          onClear={onClearAccount}
        />
      )}
      {categoryName === null ? null : (
        <ClearChip
          label={t('tx.filterCategoryChip', { category: categoryName })}
          clearLabel={t('tx.clearCategoryFilter')}
          onClear={onClearCategory}
        />
      )}
      {countryName === null ? null : (
        <ClearChip
          label={t('tx.filterCountryChip', { country: countryName })}
          clearLabel={t('tx.clearCountryFilter')}
          onClear={onClearCountry}
        />
      )}
      {/* One caveat for the totals above: GET /transactions/summary is a whole-month
          aggregate over every account and category and takes neither filter. */}
      {summaryOnScreen ? <Text style={styles.note}>{t('tx.filterSummaryNote')}</Text> : null}
    </View>
  );
}

/**
 * One chip: a sentence and the button that takes the filter off. The button is a
 * real 44pt target with its own accessibility label — an `x` sized to the sentence
 * would be a control only a stylus could hit, and "×" is not a name.
 */
function ClearChip({
  label,
  clearLabel,
  onClear,
}: {
  label: string;
  clearLabel: string;
  onClear: () => void;
}) {
  const styles = useStyles();
  return (
    <View accessibilityRole="text" style={styles.chip}>
      <Text style={styles.chipText}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={clearLabel}
        onPress={onClear}
        style={styles.clear}
      >
        <Text style={styles.clearText}>×</Text>
      </Pressable>
    </View>
  );
}

const useStyles = themedStyles((t) => ({
  row: {
    paddingHorizontal: t.spacing.lg,
    paddingBottom: t.spacing.sm,
    gap: t.spacing.xs,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.sm,
  },
  chipText: {
    flex: 1,
    fontSize: t.type.sm,
    color: t.colors.textMuted,
  },
  clear: {
    width: t.TOUCH_TARGET,
    height: t.TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clearText: {
    fontSize: t.type.xl,
    lineHeight: 24,
    color: t.colors.accent,
  },
  note: {
    fontSize: t.type.xs,
    color: t.colors.textMuted,
  },
}));
