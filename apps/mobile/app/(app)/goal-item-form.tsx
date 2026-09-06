// Create / edit one plan item (mobile-catchup-3, line C) — web's
// GoalItemFormModal, with this client's decisions where the two platforms differ.
//
// The money pair is the transactions mechanism, not a second one: the item is
// priced in ANY currency (the same spend-currency chips the transaction form
// uses), and a second amount in the GOAL's currency appears only when the two
// differ. A typed value is an OVERRIDE and wins; clearing it (explicit `null` in
// the PATCH) hands the number back to the server.
//
// ONE deliberate divergence from web: the conversion preview is TEXT, never
// written into the field — the same call this client already made for the
// transaction form's charged amount (D8: the client does not multiply by rates,
// and an autofilled number is indistinguishable from one the user typed). So
// `converted_minor` goes on the wire only when the user actually typed it.
//
// The reminder is EXACTLY ONE of two intents, or none: a fixed date that stands
// still, or "N days before", which rides the effective deadline. Picking one
// clears the other, and the line under them shows the date the current input
// actually resolves to — otherwise "14 days before" is a number nobody can check.
//
// An inherited deadline is shown as a HINT and never written into the field:
// writing it would freeze an inheritance the user never asked to break.
import { buildGoalItemPatch, type GoalItemFormValues } from '@budget/api-client';
import {
  formatApiDate,
  parseMoney,
  sentenceEnd,
  SUPPORTED_CURRENCIES,
  toInputString,
  todayApiDateUtc,
} from '@budget/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { router, useLocalSearchParams } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Controller, useForm, useWatch, type Resolver } from 'react-hook-form';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { DateField } from '../../src/components/DateField';
import { FieldError } from '../../src/components/FieldError';
import { FormButton } from '../../src/components/FormButton';
import { KeyboardAwareForm } from '../../src/components/KeyboardAwareForm';
import { LabeledInput } from '../../src/components/LabeledInput';
import { themedStyles } from '../../src/theme/themedStyles';
import { describeGoalItemError } from '../../src/data/errors';
import { useFxPreview } from '../../src/data/fx';
import { useGoal } from '../../src/data/goals';
import {
  useCreateGoalItem,
  useGoalItems,
  useUpdateGoalItem,
  type GoalItemRead,
} from '../../src/data/goalItems';
import {
  goalItemFormSchema,
  LINKS_MAX,
  type GoalItemFormInput,
} from '../../src/features/goals/plan/goalItemFormSchema';
import { remindPreview, type RemindMode } from '../../src/features/goals/plan/remindPreview';
import { SpendCurrencyPicker } from '../../src/features/transactions/SpendCurrencyPicker';
import { useLang, useLocale, useT } from '../../src/i18n/context';
import { normalizeAmountInput } from '../../src/lib/amountInput';
import { useDebouncedValue } from '../../src/lib/useDebouncedValue';

const PREVIEW_DEBOUNCE_MS = 300;
const API_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Which of the two reminder intents a stored row expresses (exactly one, or none). */
function remindModeOf(item: GoalItemRead | undefined): RemindMode {
  if (item?.remind_on) return 'on';
  if (item?.remind_days_before !== null && item?.remind_days_before !== undefined) return 'days';
  return 'none';
}

export default function GoalItemFormScreen() {
  const t = useT();
  const styles = useStyles();
  const params = useLocalSearchParams<{ goalId?: string; id?: string; parentId?: string }>();
  const goalId = params.goalId;
  const itemId = params.id;

  const goalQuery = useGoal(goalId ?? '', goalId !== undefined);
  const itemsQuery = useGoalItems(goalId ?? '', goalId !== undefined);

  if (goalId === undefined) {
    return (
      <Shell title={t('goalItemForm.newTitle')}>
        <Text accessibilityRole="alert" style={styles.unavailable}>
          {t('goalItemForm.unavailable')}
        </Text>
        <FormButton
          label={t('common.goBack')}
          variant="secondary"
          onPress={() => router.back()}
        />
      </Shell>
    );
  }

  if (goalQuery.isPending || itemsQuery.isPending) {
    return (
      <Shell title={t(itemId ? 'goalItemForm.editTitle' : 'goalItemForm.newTitle')}>
        <Text style={styles.notice}>{t('common.loading')}</Text>
      </Shell>
    );
  }

  const goal = goalQuery.data;
  const list = itemsQuery.data;
  const item = itemId !== undefined ? list?.items.find((row) => row.id === itemId) : undefined;

  // Deep-link-safe: both reads are per-goal and single, so a cold link resolves
  // them itself. A missing item (deleted elsewhere) says so rather than silently
  // becoming a create.
  if (goal === undefined || list === undefined || (itemId !== undefined && item === undefined)) {
    return (
      <Shell title={t(itemId ? 'goalItemForm.editTitle' : 'goalItemForm.newTitle')}>
        <Text accessibilityRole="alert" style={styles.unavailable}>
          {t('goalItemForm.unavailable')}
        </Text>
        <FormButton
          label={t('common.goBack')}
          variant="secondary"
          onPress={() => router.back()}
        />
      </Shell>
    );
  }

  // What this node's date resolves to WITHOUT one of its own: its parent's
  // effective date, else the goal's. Never the node's own effective date — that
  // would count the value being edited.
  const parentId = item ? item.parent_id : (params.parentId ?? null);
  const inheritedDeadline =
    (parentId === null
      ? goal.deadline
      : (list.items.find((row) => row.id === parentId)?.effective_deadline ?? goal.deadline)) ??
    null;

  return (
    <GoalItemFormBody
      goalId={goalId}
      goalCurrency={list.goal_currency}
      item={item}
      parentId={parentId}
      inheritedDeadline={inheritedDeadline}
      // The account currencies this user deals in are not known on this screen;
      // the goal's own currency plus the tracked set is the honest suggestion
      // list, and the "Other…" escape hatch keeps every well-formed code
      // reachable (D7 — the list is a SUGGESTION, not a whitelist).
      currencyOptions={[
        list.goal_currency,
        ...SUPPORTED_CURRENCIES.filter((code) => code !== list.goal_currency),
      ]}
    />
  );
}

function GoalItemFormBody({
  goalId,
  goalCurrency,
  item,
  parentId,
  inheritedDeadline,
  currencyOptions,
}: {
  goalId: string;
  goalCurrency: string;
  item: GoalItemRead | undefined;
  parentId: string | null;
  inheritedDeadline: string | null;
  currencyOptions: string[];
}) {
  const t = useT();
  const styles = useStyles();
  const lang = useLang();
  const locale = useLocale();
  const isEdit = item !== undefined;

  const createItem = useCreateGoalItem(goalId);
  const updateItem = useUpdateGoalItem(goalId);

  const storedCurrency = item?.currency ?? goalCurrency;
  const storedConverted =
    item?.converted_minor !== null &&
    item?.converted_minor !== undefined &&
    item.converted_currency === goalCurrency
      ? toInputString(item.converted_minor, goalCurrency)
      : '';

  const defaultValues: GoalItemFormInput = {
    name: item?.name ?? '',
    description: item?.description ?? '',
    links: item?.links ?? [],
    // AM-5: the amount decodes with the ITEM's own currency, never the goal's.
    amount:
      item?.amount_minor === null || item?.amount_minor === undefined
        ? ''
        : toInputString(item.amount_minor, storedCurrency),
    currency: storedCurrency,
    converted: storedConverted,
    // The stored column only — an inherited date is a hint, never a value.
    deadline: item?.deadline ?? '',
    remind_mode: remindModeOf(item),
    remind_on: item?.remind_on ?? '',
    remind_days_before:
      item?.remind_days_before === null || item?.remind_days_before === undefined
        ? ''
        : String(item.remind_days_before),
  };

  // The output-shaped baseline for the PATCH diff: what the server stores today.
  const initial: GoalItemFormValues = {
    name: item?.name ?? '',
    description: item?.description ?? null,
    links: item?.links ?? [],
    amount_minor: item?.amount_minor ?? null,
    currency: storedCurrency,
    converted_minor:
      item?.converted_currency === goalCurrency ? (item?.converted_minor ?? null) : null,
    deadline: item?.deadline ?? null,
    remind_on: item?.remind_on ?? null,
    remind_days_before: item?.remind_days_before ?? null,
  };

  // F-1: the decimal-pad's separator key is the DEVICE locale's (',' on ru-RU)
  // while the shared parser accepts '.' only. Both money fields go through it.
  const resolver: Resolver<GoalItemFormInput, unknown, GoalItemFormValues> = (
    values,
    context,
    options,
  ) =>
    zodResolver(goalItemFormSchema(goalCurrency, t))(
      {
        ...values,
        amount: normalizeAmountInput(values.amount),
        converted: normalizeAmountInput(values.converted),
      },
      context,
      options,
    );

  const {
    control,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<GoalItemFormInput, unknown, GoalItemFormValues>({ resolver, defaultValues });

  const currency = useWatch({ control, name: 'currency' });
  const amountRaw = useWatch({ control, name: 'amount' });
  const links = useWatch({ control, name: 'links' }) ?? [];
  const deadlineRaw = useWatch({ control, name: 'deadline' });
  const remindMode = useWatch({ control, name: 'remind_mode' });
  const remindOnRaw = useWatch({ control, name: 'remind_on' });
  const remindDaysRaw = useWatch({ control, name: 'remind_days_before' });

  // "Has a human typed in the converted field?" — the transactions rule: only
  // then is the value sent as an override.
  const [convertedEdited, setConvertedEdited] = useState(false);

  // The second amount exists only while the item is denominated in a foreign
  // currency (the transactions rule, D8).
  const showConverted = currency !== goalCurrency;

  // A conversion ESTIMATE at the rate the SERVER will use: its `_today()` is UTC
  // and an item has no date of its own, so a local date would preview a different
  // day's rate around midnight. TEXT ONLY — the client never multiplies by a
  // rate, and `parseMoney` here only ENCODES the query parameter at the exponent
  // of the currency the user picked (never a hardcoded x100).
  const debouncedAmount = useDebouncedValue(amountRaw, PREVIEW_DEBOUNCE_MS);
  const previewAmount = parseMoney(normalizeAmountInput(debouncedAmount), currency);
  const preview = useFxPreview(
    showConverted && previewAmount.ok && previewAmount.minor > 0
      ? {
          amountMinor: previewAmount.minor,
          from: currency,
          to: goalCurrency,
          date: todayApiDateUtc(),
        }
      : null,
  );
  const previewResult = preview.data;

  const effectiveDeadline = deadlineRaw.trim() !== '' ? deadlineRaw.trim() : inheritedDeadline;
  const reminder = remindPreview({
    mode: remindMode,
    remindOn: remindOnRaw,
    remindDaysBefore:
      remindDaysRaw.trim() === '' || !/^\d+$/.test(remindDaysRaw.trim())
        ? null
        : Number(remindDaysRaw.trim()),
    effectiveDeadline,
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      if (isEdit && item) {
        const patch = buildGoalItemPatch(values, initial);
        if (Object.keys(patch).length > 0) {
          await updateItem.mutateAsync({ itemId: item.id, body: patch });
        }
      } else {
        await createItem.mutateAsync({
          parent_id: parentId,
          name: values.name,
          description: values.description,
          links: values.links,
          amount_minor: values.amount_minor,
          currency: values.currency,
          // An untouched estimate is NOT the user's override: it is omitted and
          // the server computes the snapshot at its own stored rate.
          converted_minor: convertedEdited ? values.converted_minor : null,
          deadline: values.deadline,
          remind_on: values.remind_on,
          remind_days_before: values.remind_days_before,
        });
      }
      router.back();
    } catch (error) {
      const { field, message } = describeGoalItemError(error, lang);
      // `parent_id` has no control in THIS form (the parent is chosen when the
      // item is created, and changed in the move sheet), so it lands at form
      // level rather than on an input the user cannot see.
      const target =
        field === 'form' || field === 'parent_id'
          ? 'root'
          : field === 'amount_minor'
            ? 'amount'
            : field === 'converted_minor'
              ? 'converted'
              : field;
      setError(target, { message });
    }
  });

  const setLinks = (next: string[]) => setValue('links', next, { shouldDirty: true });
  const pending = isSubmitting || createItem.isPending || updateItem.isPending;

  return (
    <Shell
      title={t(isEdit ? 'goalItemForm.editTitle' : 'goalItemForm.newTitle')}
      footer={<FormButton label={t('common.save')} onPress={onSubmit} pending={pending} />}
    >
      <FieldError message={errors.root?.message} />

      <Controller
        control={control}
        name="name"
        render={({ field }) => (
          <LabeledInput
            label={t('common.name')}
            maxLength={100}
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={errors.name?.message}
          />
        )}
      />

      <Controller
        control={control}
        name="amount"
        render={({ field }) => (
          <LabeledInput
            label={`${t('goalItemForm.amount', { currency })} ${t('common.optional')}`}
            keyboardType="decimal-pad"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            hint={t('goalItemForm.amountHint')}
            error={errors.amount?.message}
          />
        )}
      />

      <View style={styles.field}>
        <Text style={styles.label}>{t('common.currency')}</Text>
        <SpendCurrencyPicker
          value={currency}
          suggestions={currencyOptions}
          otherLabel={t('txForm.spendCurrencyOtherLabel')}
          onChange={(code) => {
            setValue('currency', code, { shouldDirty: true });
            // The stored second amount belongs to the OLD currency pair — keeping
            // it on screen would claim an override the server is about to
            // recompute away.
            setValue('converted', '', { shouldDirty: true });
            setConvertedEdited(false);
          }}
        />
        <FieldError message={errors.currency?.message} />
      </View>

      {showConverted ? (
        <Controller
          control={control}
          name="converted"
          render={({ field }) => (
            <LabeledInput
              label={t('goalItemForm.converted', { currency: goalCurrency })}
              keyboardType="decimal-pad"
              value={field.value}
              onChangeText={(text) => {
                setConvertedEdited(true);
                field.onChange(text);
              }}
              onBlur={field.onBlur}
              hint={
                // Four honest arms, in the order the user meets them. Every one of
                // them is TEXT — none of them fills the field.
                preview.isPending && previewAmount.ok
                  ? t('goalItemForm.converting')
                  : previewResult && previewResult.converted_minor === null
                    ? t('goalItemForm.convertedNoRate', {
                        from: currency,
                        to: goalCurrency,
                      })
                    : previewResult &&
                        previewResult.rate !== null &&
                        previewResult.rate_as_of !== null
                      ? // The rate is a SERVER string, rendered verbatim; only its
                        // date goes through the locale formatter.
                        t('goalItemForm.convertedRate', {
                          rate: previewResult.rate,
                          date: API_DATE_PATTERN.test(previewResult.rate_as_of)
                            ? formatApiDate(previewResult.rate_as_of, { locale })
                            : previewResult.rate_as_of,
                        })
                      : t('goalItemForm.convertedHint', { currency: goalCurrency })
              }
              error={errors.converted?.message}
            />
          )}
        />
      ) : null}

      <Controller
        control={control}
        name="deadline"
        render={({ field }) => (
          <DateField
            label={`${t('goalItemForm.deadline')} ${t('common.optional')}`}
            value={field.value}
            onChange={field.onChange}
            clearable
            hint={
              inheritedDeadline
                ? // The sentence ENDS on a date, and ru dates already end in "г."
                  // — `sentenceEnd` keeps that from rendering as "г..".
                  `${sentenceEnd(
                    t('goalItemForm.deadlineInheritHint', {
                      date: formatApiDate(inheritedDeadline, { locale }),
                    }),
                  )} ${t('goalItemForm.deadlineInheritMove')}`
                : t('goalItemForm.deadlineNoneHint')
            }
            error={errors.deadline?.message}
          />
        )}
      />

      <View style={styles.field}>
        <Text style={styles.label}>{t('goalItemForm.remindLegend')}</Text>
        <View style={styles.chips}>
          <Chip
            label={t('goalItemForm.remindNone')}
            selected={remindMode === 'none'}
            onPress={() => {
              setValue('remind_mode', 'none', { shouldDirty: true });
              setValue('remind_on', '', { shouldDirty: true });
              setValue('remind_days_before', '', { shouldDirty: true });
            }}
          />
          <Chip
            label={t('goalItemForm.remindOn')}
            selected={remindMode === 'on'}
            onPress={() => {
              // Exactly ONE intent is stored: choosing a fixed date clears "N
              // days before" instead of leaving a row the server refuses.
              setValue('remind_mode', 'on', { shouldDirty: true });
              setValue('remind_days_before', '', { shouldDirty: true });
            }}
          />
          <Chip
            label={t('goalItemForm.remindDays')}
            selected={remindMode === 'days'}
            onPress={() => {
              setValue('remind_mode', 'days', { shouldDirty: true });
              setValue('remind_on', '', { shouldDirty: true });
            }}
          />
        </View>

        {remindMode === 'on' ? (
          <Controller
            control={control}
            name="remind_on"
            render={({ field }) => (
              <DateField
                label={t('goalItemForm.remindOn')}
                value={field.value}
                onChange={field.onChange}
                error={errors.remind_on?.message}
              />
            )}
          />
        ) : null}

        {remindMode === 'days' ? (
          <Controller
            control={control}
            name="remind_days_before"
            render={({ field }) => (
              <LabeledInput
                label={t('goalItemForm.remindDays')}
                keyboardType="number-pad"
                value={field.value}
                onChangeText={field.onChange}
                onBlur={field.onBlur}
                error={errors.remind_days_before?.message}
              />
            )}
          />
        ) : null}

        {/* The FIRING date, computed from what is typed right now. */}
        {remindMode !== 'none' ? (
          <Text style={styles.hint}>
            {reminder.status === 'date'
              ? sentenceEnd(
                  t('goalItemForm.remindPreview', {
                    date: formatApiDate(reminder.date, { locale }),
                  }),
                )
              : reminder.status === 'no-deadline'
                ? t('goalItemForm.remindNoDeadline')
                : t('goalItemForm.remindPreviewPending')}
          </Text>
        ) : null}
      </View>

      <Controller
        control={control}
        name="description"
        render={({ field }) => (
          <LabeledInput
            label={`${t('goalItemForm.description')} ${t('common.optional')}`}
            multiline
            maxLength={2000}
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={errors.description?.message}
            style={styles.multiline}
          />
        )}
      />

      {/* One input per link, not web's newline-separated textarea: a phone
          keyboard has no comfortable multi-line paste, and an empty row is simply
          dropped by the schema (as the server's own `clean_links` does). */}
      <View style={styles.field}>
        <Text style={styles.label}>
          {t('goalItemForm.links')} {t('common.optional')}
        </Text>
        {links.map((link, index) => (
          <View key={index} style={styles.linkRow}>
            {/* The flex lives on a WRAPPER: LabeledInput's `style` reaches its
                TextInput, and a flexed input inside an unflexed field box would
                not grow. */}
            <View style={styles.linkInput}>
              <LabeledInput
                label={t('goalItemForm.linkNumber', { number: index + 1 })}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                value={link}
                onChangeText={(text) =>
                  setLinks(links.map((value, i) => (i === index ? text : value)))
                }
              />
            </View>
            <FormButton
              label={t('common.remove')}
              variant="ghost"
              size="sm"
              onPress={() => setLinks(links.filter((_value, i) => i !== index))}
              style={styles.linkRemove}
            />
          </View>
        ))}
        {links.length < LINKS_MAX ? (
          <FormButton
            label={t('goalItemForm.addLink')}
            variant="secondary"
            onPress={() => setLinks([...links, ''])}
          />
        ) : null}
        <Text style={styles.hint}>{t('goalItemForm.linksHint')}</Text>
        <FieldError message={errors.links?.message} />
      </View>
    </Shell>
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

function Shell({
  title,
  children,
  footer,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const t = useT();
  const styles = useStyles();
  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} hitSlop={8}>
          <Text style={styles.cancel}>{t('common.cancel')}</Text>
        </Pressable>
        <Text style={styles.title}>{title}</Text>
        <View style={styles.headerSpacer} />
      </View>
      <KeyboardAwareForm footer={footer}>{children}</KeyboardAwareForm>
    </SafeAreaView>
  );
}

const useStyles = themedStyles((t) => ({
  safe: {
    flex: 1,
    backgroundColor: t.colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: t.spacing.lg,
    paddingVertical: t.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: t.colors.border,
    backgroundColor: t.colors.surface,
  },
  title: {
    fontSize: t.type.lg,
    fontWeight: '700',
    color: t.colors.text,
  },
  cancel: {
    fontSize: t.type.md,
    color: t.colors.accent,
    minWidth: 60,
  },
  headerSpacer: {
    minWidth: 60,
  },
  field: {
    gap: t.spacing.xs,
  },
  label: {
    fontSize: t.type.sm,
    fontWeight: '600',
    color: t.colors.text,
  },
  hint: {
    fontSize: t.type.xs,
    color: t.colors.textMuted,
    ...t.tnum,
  },
  notice: {
    fontSize: t.type.sm,
    color: t.colors.textMuted,
  },
  unavailable: {
    fontSize: t.type.md,
    color: t.colors.danger,
  },
  multiline: {
    minHeight: 80,
    textAlignVertical: 'top',
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
  // Soft fill plus an ACCENT BORDER — the border is what states the choice on a
  // phone, which has neither hover nor a focus ring to lean on.
  chipSelected: t.selected.chip,
  chipText: {
    fontSize: t.type.sm,
    color: t.colors.text,
  },
  chipTextSelected: t.selected.text,
  linkRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: t.spacing.sm,
  },
  linkInput: {
    flex: 1,
  },
  // Bottom-aligned against the input beside it: a `sm` ghost is 36pt tall and its
  // hitSlop carries the rest of the 44pt target.
  linkRemove: {
    marginBottom: t.spacing.xs,
  },
}));
