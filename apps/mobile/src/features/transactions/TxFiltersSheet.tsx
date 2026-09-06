// The transactions list's filter sheet (catch-up 3, line A) — web's
// `TxFiltersPopover` plus the range control web keeps in its toolbar.
//
// The range mode moves IN here because a phone toolbar has room for one control, and
// that one has to be the month stepper (the mode people are in ~always). The other
// two windows are a deliberate choice, made rarely, and they belong beside the other
// deliberate choices.
//
// Built on React Native's own `Modal` — no library, and `onRequestClose` is what
// makes the ANDROID BACK BUTTON close the sheet instead of leaving the screen under
// it. Category, country and sort apply LIVE (the list behind updates as they are
// picked, which is the whole point of a filter); only the custom period is a DRAFT,
// because an incomplete or inverted pair must never become a query key.
//
// SAFE AREA (defect D-1, mobile-catchup-3 simulator pass): a `Modal` is its own
// native window, and `SafeAreaView` inside one measures THAT window — it came back
// with a zero top inset, so the title sat over the clock and "Done" sat under the
// status-bar indicators, which swallow the touch. There is no swipe-dismiss on a
// full-screen Modal and no iOS back gesture, so that was a trap with no exit but a
// restart. The insets are therefore read with `useSafeAreaInsets()` HERE, in the
// tab's tree where the provider's numbers are real, and applied as padding on the
// sheet's own container. This is the one place that owns them: the host screen's
// `SafeAreaView edges={['bottom']}` is outside the Modal and does not reach in, so
// nothing is padded twice (the forms' rule from D-4, applied to a window instead of
// a footer). The Android flags below make the modal's window edge-to-edge for the
// same reason — one source of truth for the insets on both platforms.
import { formatApiDate, monthBounds, toApiDate } from '@budget/shared';
import type { components } from '@budget/api-client';
import DateTimePicker, {
  type DateTimePickerChangeEvent,
} from '@react-native-community/datetimepicker';
import { useMemo, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FormButton } from '../../components/FormButton';
import { themedStyles } from '../../theme/themedStyles';
// The two inline paddings below are LAYOUT, not colour: they scale the safe-area
// inset and the Done button's slop, and neither follows the scheme.
import { spacing } from '../../theme/tokens';
import { useTheme } from '../../theme/useTheme';
import { useLocale, useT } from '../../i18n/context';
import type { SimpleKey } from '../../i18n/t';
import { countryOptions } from '../../lib/countryLabel';
import { ChipPicker, type ChipOption } from './ChipPicker';
import { FilterChip } from './FilterChip';
import {
  customRange,
  DEFAULT_TX_SORT,
  isValidRangeDate,
  toTxSort,
  TX_SORTS,
  type TxRangeMode,
} from './txFilters';
import type { TxSort } from '../../data/queryKeys';

type CategoryRead = components['schemas']['CategoryRead'];

// A Record over the CONTRACT's sort union: the day the server grows a fifth order,
// this object fails typecheck instead of the picker quietly missing it.
const SORT_LABEL_KEYS: Record<TxSort, SimpleKey> = {
  date_desc: 'tx.sortDateDesc',
  date_asc: 'tx.sortDateAsc',
  amount_desc: 'tx.sortAmountDesc',
  amount_asc: 'tx.sortAmountAsc',
};

// How many options a searchable section offers before the user narrows them (the
// CountryField number, for the same JS-thread reason: 247 mounted Pressables are a
// visible stall, and a 247-chip wall is unusable anyway).
const OPTION_CAP = 30;

interface TxFiltersSheetProps {
  visible: boolean;
  onClose: () => void;
  /** The archived-INCLUSIVE category list, already display-sorted. */
  categories: CategoryRead[];
  mode: TxRangeMode;
  /**
   * The month the stepper is on. It is kept while all-time or a custom period is in
   * force, so leaving either mode returns to the month that was being read rather
   * than to today — and it seeds the custom draft.
   */
  month: string;
  categoryId: string | null;
  country: string | null;
  sort: TxSort | null;
  onModeChange: (next: TxRangeMode) => void;
  onCategoryChange: (next: string | null) => void;
  onCountryChange: (next: string | null) => void;
  onSortChange: (next: TxSort | null) => void;
  onReset: () => void;
}

export function TxFiltersSheet({
  visible,
  onClose,
  categories,
  mode,
  month,
  categoryId,
  country,
  sort,
  onModeChange,
  onCategoryChange,
  onCountryChange,
  onSortChange,
  onReset,
}: TxFiltersSheetProps) {
  const t = useT();
  const styles = useStyles();
  const locale = useLocale();
  const insets = useSafeAreaInsets();

  const categoryOptions = useMemo<ChipOption[]>(
    () =>
      categories.map((category) => ({
        value: category.id,
        // The category NAME is the user's own text; only the archived marker is copy.
        label: category.archived
          ? `${category.name} ${t('common.archivedParens')}`
          : category.name,
      })),
    [categories, t],
  );

  // Built once per locale, and only while the sheet is mounted — the country table
  // is 247 rows and collating it is not work the tab should do on every render.
  const countries = useMemo<ChipOption[]>(
    () =>
      countryOptions(locale, country).map((option) => ({
        value: option.code,
        label: option.label,
      })),
    [locale, country],
  );

  return (
    <Modal
      visible={visible}
      animationType="slide"
      // Android's hardware/gesture back must close the SHEET, not pop the screen
      // behind it. iOS has no such event; the Done button is its way out.
      onRequestClose={onClose}
      // Android-only: make the modal's window edge-to-edge so the padding below is
      // the ONLY inset applied there too (without these, the window fits the system
      // bars itself and the same padding would count twice).
      statusBarTranslucent
      navigationBarTranslucent
    >
      <View
        style={[
          styles.safe,
          // A floor under the top inset: on a device that reports none, the header
          // still must not touch the very edge of the screen.
          { paddingTop: Math.max(insets.top, spacing.sm), paddingBottom: insets.bottom },
        ]}
      >
        <View style={styles.header}>
          <Text style={styles.title}>{t('tx.filters')}</Text>
          {/* The only way out on iOS (Android also has back → `onRequestClose`), so
              it is a ≥44pt target with slop on top of that. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('common.done')}
            onPress={onClose}
            hitSlop={spacing.sm}
            style={styles.headerButton}
          >
            <Text style={styles.headerButtonText}>{t('common.done')}</Text>
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <RangeSection mode={mode} month={month} onModeChange={onModeChange} />

          <ChipPicker
            label={t('tx.filterCategoryLabel')}
            allLabel={t('tx.allCategories')}
            options={categoryOptions}
            value={categoryId}
            onChange={onCategoryChange}
            unknownLabel={t('common.unknownCategory')}
            search={{
              placeholder: t('categories.searchPlaceholder'),
              moreHint: t('tx.filterMoreHidden'),
              // Categories are the user's own and rarely this many; the cap only
              // bites on an unusually long list, and the hint says so out loud.
              cap: OPTION_CAP,
            }}
          />

          <ChipPicker
            label={t('tx.filterCountryLabel')}
            allLabel={t('tx.allCountries')}
            options={countries}
            value={country}
            onChange={onCountryChange}
            // Unreachable here — an out-of-table code is kept by `countryOptions`.
            unknownLabel={t('common.notSet')}
            search={{
              placeholder: t('tx.filterCountrySearch'),
              moreHint: t('tx.filterMoreHidden'),
              cap: OPTION_CAP,
            }}
          />

          <View style={styles.section}>
            <Text style={styles.sectionLabel}>{t('tx.sortLabel')}</Text>
            <View style={styles.chips}>
              {TX_SORTS.map((value) => (
                <FilterChip
                  key={value}
                  label={t(SORT_LABEL_KEYS[value])}
                  selected={(sort ?? DEFAULT_TX_SORT) === value}
                  // The default order travels as NO parameter (toTxSort maps it to
                  // null), so picking it back returns to exactly the cache key of an
                  // untouched list.
                  onPress={() => onSortChange(toTxSort(value))}
                />
              ))}
            </View>
          </View>

          <FormButton label={t('tx.filtersReset')} variant="secondary" onPress={onReset} />
        </ScrollView>
      </View>
    </Modal>
  );
}

/**
 * The three range modes, mutually exclusive. Picking "month" or "all time" applies
 * at once; "custom period" opens the two-date draft below and applies on its own
 * button — the list keeps showing the window it was showing until then.
 */
function RangeSection({
  mode,
  month,
  onModeChange,
}: {
  mode: TxRangeMode;
  month: string;
  onModeChange: (next: TxRangeMode) => void;
}) {
  const t = useT();
  const styles = useStyles();
  // Whether the two-date form is on screen. In `custom` mode it always is — the form
  // IS that mode's UI — so this only covers "opened it, has not applied yet".
  const [composing, setComposing] = useState(false);
  const showCustom = mode.kind === 'custom' || composing;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{t('period.unitGroup')}</Text>
      <View style={styles.chips}>
        <FilterChip
          label={t('period.month')}
          selected={mode.kind === 'month' && !composing}
          onPress={() => {
            setComposing(false);
            onModeChange({ kind: 'month', month });
          }}
        />
        <FilterChip
          label={t('tx.rangeAllTime')}
          selected={mode.kind === 'all' && !composing}
          onPress={() => {
            setComposing(false);
            onModeChange({ kind: 'all' });
          }}
        />
        <FilterChip
          label={t('tx.rangeCustom')}
          selected={showCustom}
          onPress={() => setComposing(true)}
        />
      </View>
      {showCustom ? (
        <CustomRange
          applied={mode.kind === 'custom' ? mode : null}
          month={month}
          onApply={(range) => {
            setComposing(false);
            onModeChange({ kind: 'custom', ...range });
          }}
        />
      ) : null}
    </View>
  );
}

// "YYYY-MM-DD" -> a LOCAL Date (component build, no UTC parse — TZ-safe like the
// shared date helpers), for feeding the native picker. Same helper as the forms'.
function apiDateToLocalDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * The two-date form. The draft is local until it is APPLIED: an incomplete or
 * inverted pair never becomes a query key, so the list keeps showing the window it
 * was showing and the message sits under the fields that are wrong.
 */
function CustomRange({
  applied,
  month,
  onApply,
}: {
  applied: { from: string; to: string } | null;
  month: string;
  onApply: (range: { from: string; to: string }) => void;
}) {
  const t = useT();
  const styles = useStyles();
  const { scheme } = useTheme();
  const locale = useLocale();
  // Opened from a month or from all-time: the month on screen is the window the user
  // is looking at, so it is the honest starting pair to narrow or widen.
  const [draft, setDraft] = useState(() => applied ?? monthBounds(month));
  // The message appears on SUBMIT, not per keystroke: a half-picked pair is not a
  // mistake yet.
  const [submitted, setSubmitted] = useState(false);
  const [editing, setEditing] = useState<'from' | 'to' | null>(null);

  const valid = customRange(draft.from, draft.to);
  const incomplete = !isValidRangeDate(draft.from) || !isValidRangeDate(draft.to);
  const error =
    !submitted || valid !== null ? null : t(incomplete ? 'tx.rangeIncomplete' : 'tx.rangeInverted');

  // F-3 (the forms' rule): `onChange` is deprecated in
  // @react-native-community/datetimepicker 9.x; onValueChange/onDismiss are the two
  // branches. Android closes the dialog either way, iOS keeps the inline picker up.
  const onPicked = (edge: 'from' | 'to') => (_event: DateTimePickerChangeEvent, date: Date) => {
    if (Platform.OS !== 'ios') setEditing(null);
    setSubmitted(false);
    // `toApiDate` is LOCAL-time (never toISOString, which shifts the day for half
    // the planet) — the same helper both forms use.
    const value = toApiDate(date);
    setDraft((previous) => ({ ...previous, [edge]: value }));
  };

  return (
    <View style={styles.customRange}>
      {(['from', 'to'] as const).map((edge) => (
        <View key={edge} style={styles.dateField}>
          <Text style={styles.dateLabel}>{t(edge === 'from' ? 'period.from' : 'period.to')}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(edge === 'from' ? 'period.from' : 'period.to')}
            onPress={() => setEditing(edge)}
            style={styles.dateButton}
          >
            <Text style={styles.dateText}>{formatApiDate(draft[edge], { locale })}</Text>
          </Pressable>
          {editing === edge ? (
            <>
              <DateTimePicker
                value={apiDateToLocalDate(draft[edge])}
                mode="date"
                // D-3: the picker follows the UI language, not the device's
                // (see components/DateField.tsx for the whole rule).
                locale={locale}
                display={Platform.OS === 'ios' ? 'inline' : 'default'}
                // iOS-only: without it the inline picker paints its own light
                // calendar inside a dark sheet.
                themeVariant={scheme}
                onValueChange={onPicked(edge)}
                onDismiss={() => setEditing(null)}
              />
              {Platform.OS === 'ios' ? (
                <FormButton
                  label={t('common.done')}
                  variant="secondary"
                  onPress={() => setEditing(null)}
                />
              ) : null}
            </>
          ) : null}
        </View>
      ))}
      {error === null ? null : (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      <FormButton
        label={t('tx.rangeApply')}
        onPress={() => {
          setSubmitted(true);
          if (valid !== null) onApply(valid);
        }}
      />
    </View>
  );
}

const useStyles = themedStyles((t) => ({
  safe: {
    flex: 1,
    // A sheet sits ON the screen it covers: surfaceRaised is the tone that says so
    // in dark (in light it equals surface, as on web).
    backgroundColor: t.colors.surfaceRaised,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: t.spacing.lg,
    paddingVertical: t.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: t.colors.border,
  },
  title: {
    fontSize: t.type.lg,
    fontWeight: '700',
    color: t.colors.text,
  },
  headerButton: {
    minHeight: t.TOUCH_TARGET,
    minWidth: t.TOUCH_TARGET,
    alignItems: 'flex-end',
    justifyContent: 'center',
    paddingHorizontal: t.spacing.sm,
  },
  headerButtonText: {
    fontSize: t.type.md,
    fontWeight: '600',
    color: t.colors.accent,
  },
  body: {
    padding: t.spacing.lg,
    gap: t.spacing.xl,
    paddingBottom: t.spacing.xl * 2,
  },
  section: {
    gap: t.spacing.sm,
  },
  sectionLabel: {
    fontSize: t.type.sm,
    fontWeight: '600',
    color: t.colors.text,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: t.spacing.sm,
  },
  customRange: {
    gap: t.spacing.md,
    paddingTop: t.spacing.sm,
  },
  dateField: {
    gap: t.spacing.xs,
  },
  dateLabel: {
    fontSize: t.type.sm,
    color: t.colors.textMuted,
  },
  dateButton: {
    minHeight: t.TOUCH_TARGET,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: t.colors.borderStrong,
    borderRadius: t.radius.md,
    paddingHorizontal: t.spacing.md,
    backgroundColor: t.colors.surface,
  },
  dateText: {
    fontSize: t.type.md,
    color: t.colors.text,
  },
  error: {
    fontSize: t.type.sm,
    color: t.colors.danger,
  },
}));
