// Create / edit / delete one recurring template (catch-up 3, line B) — web's
// TemplateFormModal decisions on mobile's form pieces.
//
// THREE THINGS THIS FORM KNOWS THAT THE USER CANNOT SEE:
//
//  * `start_date` is only a FLOOR; the ANCHOR (day of month / weekday) decides the
//    day. Pick 23 August with "monthly on day 1" and the first charge lands on
//    1 September. So the date LEADS the anchor (picking a date sets it), and when
//    the two still disagree the form says what will actually happen —
//    `startDateConflict`, which mirrors the server's `domain/recurrence.py`,
//    clamp included. Advisory only: the combination is legal, just surprising.
//  * the CURRENCY is the account's, full stop (architecture §4 — the server
//    refuses a template that disagrees with its own account with 422
//    ACCOUNT_CURRENCY_MISMATCH). So there is no currency control here at all: the
//    field follows the picked account and is shown read-only. That is the one
//    deliberate simplification against web, which offers a picker the server can
//    only ever reject.
//  * the ACCOUNT is create-time only — a deliberate product line both clients hold
//    (a template's currency is stamped from its account, so re-homing one is its
//    own scope), which is why `buildRecurringTemplatePatch` emits no `account_id`
//    key and the edit arm shows the stored account read-only.
//
// The date floor is UTC (`todayApiDateUtc`): the server's `_today()` is UTC, and a
// local-midnight compare disagrees with it for hours in any offset zone. On EDIT
// no floor is passed — the real one is `min(last_materialized_on, today)`, that
// watermark is server-only state, and guessing it would block a legal rewind. The
// 422 is the UX there.
import { zodResolver } from '@hookform/resolvers/zod';
import { ThemedSwitch } from '../../src/components/ThemedSwitch';
import {
  formatApiDate,
  recurringTemplateFormSchema,
  todayApiDate,
  todayApiDateUtc,
  type RecurringTemplateFormInput,
  type RecurringTemplateFormValues,
} from '@budget/shared';
import { buildRecurringTemplatePatch, emptyToNull } from '@budget/api-client';
import type { components } from '@budget/api-client';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState, type ReactNode } from 'react';
import { Controller, useForm, useWatch, type Resolver } from 'react-hook-form';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AccountPicker } from '../../src/components/AccountPicker';
import { confirmAction } from '../../src/components/confirm';
import { DateField } from '../../src/components/DateField';
import { FieldError } from '../../src/components/FieldError';
import { FormButton } from '../../src/components/FormButton';
import { KeyboardAwareForm } from '../../src/components/KeyboardAwareForm';
import { KindSegmented } from '../../src/components/KindSegmented';
import { LabeledInput } from '../../src/components/LabeledInput';
import { themedStyles } from '../../src/theme/themedStyles';
import { useAccounts, type AccountRead } from '../../src/data/accounts';
import {
  buildAccountIndex,
  pickDefaultAccount,
  sortForDisplay as sortAccountsForDisplay,
} from '../../src/data/accountLookup';
import { useCategories } from '../../src/data/categories';
import { sortForDisplay } from '../../src/data/categoryLookup';
import { describeRecurringError } from '../../src/data/errors';
import {
  useCreateTemplate,
  useDeleteTemplate,
  useRecurringTemplates,
  useUpdateTemplate,
  type RecurringTemplateRead,
} from '../../src/data/recurring';
import { anchorsForDate, startDateConflict } from '../../src/features/recurring/firstCharge';
import { weekdayLabels } from '../../src/features/recurring/periodicity';
import { useLang, useLocale, useT } from '../../src/i18n/context';
import { normalizeAmountInput, toLocalInputString } from '../../src/lib/amountInput';

type CategoryRead = components['schemas']['CategoryRead'];

const DAYS_OF_MONTH = Array.from({ length: 31 }, (_, index) => index + 1);
// The only days a short month can clamp. A fixed calendar fact, not math — and
// the hint would be FALSE under "day 5", where no month is shorter.
const CLAMPABLE_DAYS = ['29', '30', '31'];

export default function RecurringFormScreen() {
  const t = useT();
  const styles = useStyles();
  const params = useLocalSearchParams<{ id?: string }>();
  const id = params.id;
  const isEdit = id !== undefined;

  const templatesQuery = useRecurringTemplates();
  const accountsQuery = useAccounts();
  const categoriesQuery = useCategories();
  const template = isEdit
    ? templatesQuery.data?.items.find((item) => item.id === id)
    : undefined;

  // The ACCOUNT decides this template's currency, so the form waits for the list
  // instead of binding its defaults to an empty one (which is also why
  // AccountPicker has no loading arm). Normally a cache hit.
  if (accountsQuery.isPending || (isEdit && templatesQuery.isPending)) {
    return (
      <Shell title={t(isEdit ? 'templateForm.editTitle' : 'templateForm.newTitle')}>
        <Text style={styles.notice}>{t('common.loading')}</Text>
      </Shell>
    );
  }

  // Deep-link-safe: the template list is the single source, and a missing id (a
  // cold deep link, or a template deleted in another session) shows unavailable +
  // back rather than a form that would silently CREATE something new.
  if (isEdit && template === undefined) {
    return (
      <Shell title={t('templateForm.editTitle')}>
        <Text accessibilityRole="alert" style={styles.unavailable}>
          {t('templateForm.unavailable')}
        </Text>
        <FormButton
          label={t('common.goBack')}
          variant="secondary"
          onPress={() => router.back()}
        />
      </Shell>
    );
  }

  return (
    <TemplateFormBody
      template={template}
      accounts={accountsQuery.data ?? []}
      accountsError={accountsQuery.isError}
      onRetryAccounts={() => accountsQuery.refetch()}
      categories={categoriesQuery.data ?? []}
    />
  );
}

interface BodyProps {
  template: RecurringTemplateRead | undefined;
  accounts: AccountRead[];
  accountsError: boolean;
  onRetryAccounts: () => void;
  categories: CategoryRead[];
}

function TemplateFormBody({
  template,
  accounts,
  accountsError,
  onRetryAccounts,
  categories,
}: BodyProps) {
  const t = useT();
  const styles = useStyles();
  const lang = useLang();
  const locale = useLocale();
  const isEdit = template !== undefined;

  const createTemplate = useCreateTemplate();
  const updateTemplate = useUpdateTemplate();
  const deleteTemplate = useDeleteTemplate();

  const sortedAccounts = useMemo(
    () => sortAccountsForDisplay(accounts, locale),
    [accounts, locale],
  );
  const accountsById = useMemo(() => buildAccountIndex(accounts), [accounts]);
  const sortedCategories = useMemo(
    () => sortForDisplay(categories, locale),
    [categories, locale],
  );

  // A template's kind is expense|income by CHECK (a transfer is not templatable),
  // so the narrow is a fact, not a fallback.
  const templateKind = template?.kind === 'income' ? 'income' : 'expense';
  const defaultAccountId = template?.account_id ?? pickDefaultAccount(accounts, []);
  const startingCurrency =
    template?.currency ?? accountsById.get(defaultAccountId)?.currency ?? '';

  const defaultValues: RecurringTemplateFormInput = template
    ? {
        name: template.name,
        account_id: template.account_id,
        // AM-5: the amount decodes with the TEMPLATE's own currency, never a
        // base. N-5: written with the separator this language's keyboard types.
        amount: toLocalInputString(template.amount_minor, template.currency, lang),
        currency: template.currency,
        kind: templateKind,
        category_id: template.category_id ?? '',
        merchant: template.merchant ?? '',
        note: template.note ?? '',
        interval_unit: template.interval_unit,
        day_of_month: template.day_of_month === null ? '' : String(template.day_of_month),
        weekday: template.weekday === null ? '' : String(template.weekday),
        start_date: template.start_date ?? '',
        end_date: template.end_date ?? '',
      }
    : {
        name: '',
        account_id: defaultAccountId,
        amount: '',
        currency: startingCurrency,
        kind: 'expense',
        category_id: '',
        merchant: '',
        note: '',
        interval_unit: 'month',
        day_of_month: '1',
        weekday: '',
        start_date: '',
        end_date: '',
      };

  // Output-shaped baseline for the PATCH diff.
  const initial: RecurringTemplateFormValues = {
    name: template?.name ?? '',
    account_id: template?.account_id ?? defaultAccountId,
    amount_minor: template?.amount_minor ?? 0,
    kind: templateKind,
    // Diff BASELINE, not a decode fallback: the create branch never reaches the
    // patch builder at all.
    currency: template?.currency ?? startingCurrency,
    category_id: template?.category_id ?? '',
    merchant: template?.merchant ?? '',
    note: template?.note ?? '',
    interval_unit: template?.interval_unit ?? 'month',
    day_of_month: template?.day_of_month ?? null,
    weekday: template?.weekday ?? null,
    start_date: template?.start_date ?? null,
    end_date: template?.end_date ?? null,
  };

  // F-1: the device keyboard's separator is the locale's (',' on ru-RU) while the
  // shared parser accepts '.' only. Normalize at this boundary — the field keeps
  // showing what was typed.
  const resolver: Resolver<RecurringTemplateFormInput, unknown, RecurringTemplateFormValues> = (
    values,
    context,
    options,
  ) =>
    zodResolver(
      recurringTemplateFormSchema(isEdit ? undefined : { minStartDate: todayApiDateUtc() }),
    )({ ...values, amount: normalizeAmountInput(values.amount) }, context, options);

  const {
    control,
    handleSubmit,
    setError,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<RecurringTemplateFormInput, unknown, RecurringTemplateFormValues>({
    resolver,
    defaultValues,
  });

  // The pause flag is NOT part of the shared form schema (it is a one-field PATCH
  // on web, and the row has its own button here), so it is local state diffed
  // explicitly in onSubmit — the same treatment `merchant` gets in the tx form.
  const [paused, setPaused] = useState(template?.paused ?? false);

  const kind = useWatch({ control, name: 'kind' });
  const accountId = useWatch({ control, name: 'account_id' });
  const currency = useWatch({ control, name: 'currency' });
  const categoryId = useWatch({ control, name: 'category_id' });
  const intervalUnit = useWatch({ control, name: 'interval_unit' });
  const dayOfMonth = useWatch({ control, name: 'day_of_month' });
  const weekday = useWatch({ control, name: 'weekday' });
  const startDate = useWatch({ control, name: 'start_date' });
  const endDate = useWatch({ control, name: 'end_date' });

  const weekdays = weekdayLabels(locale);
  const kindCategories = sortedCategories.filter(
    (category) => category.kind === kind && (!category.archived || category.id === categoryId),
  );

  // ADVISORY, about the USER'S INPUT — never a re-derivation of server state. Both
  // strings are "YYYY-MM-DD", so a lexicographic compare IS a date compare. A past
  // end date is legal, so this never blocks.
  const endDateHasPassed = endDate !== '' && endDate < todayApiDate();
  // Gated on a start date that is still ahead: for a template already running the
  // real floor is the server-only watermark, so "the first transaction will be
  // created on X" would be a claim we cannot make. The list already shows
  // `next_due_on`, which IS the server's answer.
  const conflictFirstCharge =
    startDate >= todayApiDateUtc()
      ? startDateConflict({ unit: intervalUnit, dayOfMonth, weekday }, startDate)
      : null;
  const scheduleLabel =
    intervalUnit === 'month'
      ? t('periodicity.monthlyOnDay', { day: Number(dayOfMonth) })
      : t('periodicity.weeklyOn', { weekday: weekdays[Number(weekday)] ?? '' });

  const onKindChange = (next: 'expense' | 'income') => {
    setValue('kind', next);
    // Flipping the kind clears a category whose kind no longer matches.
    const selected = categories.find((category) => category.id === getValues('category_id'));
    if (selected && selected.kind !== next) setValue('category_id', '');
  };

  // §4: the currency IS the account's, so picking an account restamps it. On an
  // exponent-0 account (JPY) this is what keeps "5000" from being read as ¥50.00.
  const onAccountChange = (nextId: string) => {
    setValue('account_id', nextId, { shouldValidate: true });
    const nextCurrency = accountsById.get(nextId)?.currency;
    if (nextCurrency) setValue('currency', nextCurrency);
  };

  // Switching the unit gives the newly relevant anchor a usable default so the
  // control is never submitted empty; the schema drops the other one anyway. A
  // picked start date IS that default — switching units means "redefine the
  // schedule", and re-deriving from the date keeps the two from contradicting
  // each other again in the newly chosen unit.
  const onUnitChange = (unit: 'month' | 'week') => {
    setValue('interval_unit', unit);
    const anchors = anchorsForDate(getValues('start_date'));
    if (unit === 'month' && (anchors !== null || getValues('day_of_month') === '')) {
      setValue('day_of_month', String(anchors?.dayOfMonth ?? 1));
    }
    if (unit === 'week' && (anchors !== null || getValues('weekday') === '')) {
      setValue('weekday', String(anchors?.weekday ?? 0));
    }
  };

  // THE DATE LEADS THE ANCHOR: picking 23 August sets "day 23" / that weekday, so
  // the obvious reading of the form — "it starts then and repeats from then" —
  // becomes the true one. Only the anchor of the CURRENT unit moves. Both stay
  // editable: a hand-picked day that disagrees is a legal schedule and gets the
  // advisory notice, not a reset.
  //
  // `iso` is "" when the field is CLEARED (the shared DateField's own clear button):
  // no date means no anchor to derive, and the anchor already picked stays — it is
  // the schedule, and clearing the floor does not redefine it.
  const onStartDateChange = (iso: string) => {
    setValue('start_date', iso, { shouldDirty: true });
    const anchors = anchorsForDate(iso);
    if (anchors === null) return;
    if (getValues('interval_unit') === 'month') {
      setValue('day_of_month', String(anchors.dayOfMonth), { shouldDirty: true });
    } else {
      setValue('weekday', String(anchors.weekday), { shouldDirty: true });
    }
  };

  const onEndDateChange = (iso: string) => {
    setValue('end_date', iso, { shouldDirty: true });
  };

  const routeError = (error: unknown) => {
    // The 404 list refetch is the mutation's own onError (data/recurring.ts); here
    // we only route the message onto the right control.
    const { field, message } = describeRecurringError(error, lang);
    const target =
      field === 'form' ? 'root' : field === 'amount_minor' ? 'amount' : field;
    setError(target, { message });
  };

  const onSubmit = handleSubmit(async (values) => {
    try {
      if (isEdit && template) {
        const patch = buildRecurringTemplatePatch(values, initial);
        // `paused` is not in the shared form values, so its diff is explicit.
        const body = paused === template.paused ? patch : { ...patch, paused };
        if (Object.keys(body).length > 0) {
          await updateTemplate.mutateAsync({ id: template.id, body });
        }
      } else {
        await createTemplate.mutateAsync({
          name: values.name,
          account_id: values.account_id,
          amount_minor: values.amount_minor,
          kind: values.kind,
          currency: values.currency,
          category_id: emptyToNull(values.category_id),
          merchant: emptyToNull(values.merchant),
          note: emptyToNull(values.note),
          interval_unit: values.interval_unit,
          day_of_month: values.day_of_month,
          weekday: values.weekday,
          start_date: values.start_date,
          end_date: values.end_date,
          paused,
        });
      }
      router.back();
    } catch (error) {
      routeError(error);
    }
  });

  const onDelete = () => {
    if (!template) return;
    // The asymmetry a user cannot guess: the schedule stops, the money stays, and
    // the label comes off the rows it already created. So the dialog says it.
    confirmAction({
      cancelLabel: t('common.cancel'),
      title: t('recurring.deleteTitle'),
      message: t('recurring.deleteMessage'),
      confirmLabel: t('common.delete'),
      destructive: true,
      onConfirm: () => {
        deleteTemplate.mutate(
          { id: template.id },
          { onSuccess: () => router.back(), onError: routeError },
        );
      },
    });
  };

  const pending = isSubmitting || createTemplate.isPending || updateTemplate.isPending;
  // Only a CREATE picks an account (the edit arm shows the stored one read-only),
  // so only a create can be blocked by an empty or unavailable list.
  const noAccounts = !isEdit && (accountsError || sortedAccounts.length === 0);
  const currentAccount = accountsById.get(accountId);

  return (
    <Shell
      title={t(isEdit ? 'templateForm.editTitle' : 'templateForm.newTitle')}
      footer={
        <>
          <FormButton
            label={t('common.save')}
            onPress={onSubmit}
            pending={pending}
            disabled={noAccounts}
          />
          {isEdit ? (
            <FormButton
              label={t('common.delete')}
              variant="danger"
              onPress={onDelete}
              pending={deleteTemplate.isPending}
            />
          ) : null}
        </>
      }
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
            hint={t('templateForm.nameHint')}
            error={errors.name?.message}
          />
        )}
      />

      {/* The kind comes first: it decides which categories are offered and which
          way the amount is signed in the list. */}
      <View style={styles.field}>
        <Text style={styles.label}>{t('common.type')}</Text>
        <KindSegmented value={kind} onChange={onKindChange} />
      </View>

      {isEdit ? (
        // Read-only on edit: `buildRecurringTemplatePatch` emits no account key,
        // so a picker here could only ever look like it worked. Moving a template
        // to another account is delete + re-create.
        <View style={styles.field}>
          <Text style={styles.label}>{t('templateForm.account')}</Text>
          <Text style={styles.readonlyValue}>
            {currentAccount
              ? `${currentAccount.name} · ${currentAccount.currency}`
              : t('templateForm.accountUnknown')}
          </Text>
          <Text style={styles.hint}>{t('templateForm.accountReadOnlyHint')}</Text>
        </View>
      ) : (
        <AccountPicker
          label={t('templateForm.account')}
          accounts={sortedAccounts}
          isError={accountsError}
          onRetry={onRetryAccounts}
          value={accountId}
          onChange={onAccountChange}
          hint={t('templateForm.accountHint')}
          error={errors.account_id?.message}
        />
      )}

      <Controller
        control={control}
        name="amount"
        render={({ field }) => (
          <LabeledInput
            label={t('templateForm.amountIn', { currency: currency || '—' })}
            keyboardType="decimal-pad"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={errors.amount?.message ?? errors.currency?.message}
          />
        )}
      />

      <View style={styles.field}>
        <Text style={styles.label}>
          {t('txForm.category')} {t('common.optional')}
        </Text>
        <View style={styles.chips}>
          <Chip
            label={t('common.uncategorized')}
            selected={categoryId === ''}
            onPress={() => setValue('category_id', '')}
          />
          {kindCategories.map((category) => (
            <Chip
              key={category.id}
              label={`${category.icon ? `${category.icon} ` : ''}${category.name}${
                category.archived ? ` ${t('common.archivedParens')}` : ''
              }`}
              selected={categoryId === category.id}
              onPress={() => setValue('category_id', category.id)}
            />
          ))}
        </View>
        <FieldError message={errors.category_id?.message} />
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>{t('templateForm.repeats')}</Text>
        <View style={styles.chips}>
          <Chip
            label={t('periodicity.monthly')}
            selected={intervalUnit === 'month'}
            onPress={() => onUnitChange('month')}
          />
          <Chip
            label={t('periodicity.weekly')}
            selected={intervalUnit === 'week'}
            onPress={() => onUnitChange('week')}
          />
        </View>

        {intervalUnit === 'month' ? (
          <>
            <Text style={styles.subLabel}>{t('templateForm.dayOfMonth')}</Text>
            <View style={styles.chips}>
              {DAYS_OF_MONTH.map((day) => (
                <Chip
                  key={day}
                  label={String(day)}
                  compact
                  selected={dayOfMonth === String(day)}
                  onPress={() => setValue('day_of_month', String(day))}
                />
              ))}
            </View>
            {CLAMPABLE_DAYS.includes(dayOfMonth) ? (
              // The clamp is a SERVER rule: the client STATES it, never computes
              // it — and the line would be false under a day every month has.
              <Text style={styles.hint}>{t('templateForm.clampHint')}</Text>
            ) : null}
            <FieldError message={errors.day_of_month?.message} />
          </>
        ) : (
          <>
            <Text style={styles.subLabel}>{t('templateForm.weekday')}</Text>
            <View style={styles.chips}>
              {/* The INDEX is the wire value: ISO 0 = Monday, never
                  `Date.getDay()`'s 0 = Sunday. */}
              {weekdays.map((label, index) => (
                <Chip
                  key={label}
                  label={label}
                  selected={weekday === String(index)}
                  onPress={() => setValue('weekday', String(index))}
                />
              ))}
            </View>
            <FieldError message={errors.weekday?.message} />
          </>
        )}
      </View>

      <DateField
        label={`${t('templateForm.startDate')} ${t('common.optional')}`}
        value={startDate}
        clearable
        hint={t('templateForm.startDateHint')}
        error={errors.start_date?.message}
        onChange={onStartDateChange}
        notice={
          conflictFirstCharge === null
            ? undefined
            : t('templateForm.startDateConflict', {
                startDate: formatApiDate(startDate, { locale }),
                schedule: scheduleLabel,
                firstCharge: formatApiDate(conflictFirstCharge, { locale }),
              })
        }
      />

      <DateField
        label={`${t('templateForm.endDate')} ${t('common.optional')}`}
        value={endDate}
        clearable
        hint={t('templateForm.endDateHint')}
        error={errors.end_date?.message}
        onChange={onEndDateChange}
        notice={endDateHasPassed ? t('templateForm.endDatePassed') : undefined}
      />

      <View style={styles.switchRow}>
        <View style={styles.switchText}>
          <Text style={styles.label}>{t('templateForm.paused')}</Text>
          <Text style={styles.hint}>{t('recurring.pausedNote')}</Text>
        </View>
        <ThemedSwitch value={paused} onValueChange={setPaused} />
      </View>

      <Controller
        control={control}
        name="merchant"
        render={({ field }) => (
          <LabeledInput
            label={`${t('templateForm.merchant')} ${t('common.optional')}`}
            maxLength={255}
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={errors.merchant?.message}
          />
        )}
      />

      <Controller
        control={control}
        name="note"
        render={({ field }) => (
          <LabeledInput
            label={t('common.noteOptional')}
            multiline
            maxLength={500}
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            hint={t('templateForm.noteHint')}
            error={errors.note?.message}
            style={styles.noteInput}
          />
        )}
      />
    </Shell>
  );
}

function Chip({
  label,
  selected,
  compact,
  onPress,
}: {
  label: string;
  selected: boolean;
  compact?: boolean;
  onPress: () => void;
}) {
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.chip, compact && styles.chipCompact, selected && styles.chipSelected]}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </Pressable>
  );
}

// `footer` is the form's primary actions, pinned above the home-indicator strip
// by KeyboardAwareForm (D-4) instead of scrolling away at the end of the fields.
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
  subLabel: {
    fontSize: t.type.sm,
    color: t.colors.textMuted,
    marginTop: t.spacing.xs,
  },
  readonlyValue: {
    fontSize: t.type.md,
    color: t.colors.text,
    paddingVertical: t.spacing.sm,
  },
  hint: {
    fontSize: t.type.xs,
    color: t.colors.textMuted,
  },
  notice: {
    fontSize: t.type.sm,
    color: t.colors.accent,
  },
  unavailable: {
    color: t.colors.danger,
    fontSize: t.type.md,
  },
  noteInput: {
    minHeight: 88,
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
  // A 1..31 grid: still >= 36pt tall and wide enough for two digits, so the day
  // chips stay tappable without pushing every other field off the screen.
  chipCompact: {
    minWidth: 44,
    paddingHorizontal: t.spacing.sm,
    alignItems: 'center',
  },
  chipSelected: t.selected.chip,
  chipText: {
    fontSize: t.type.sm,
    color: t.colors.text,
  },
  chipTextSelected: t.selected.text,
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.md,
  },
  switchText: {
    flex: 1,
    gap: 2,
  },
}));
