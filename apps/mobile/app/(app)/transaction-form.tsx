import { zodResolver } from '@hookform/resolvers/zod';
import {
  formatApiDate,
  monthBounds,
  toApiDate,
  toInputString,
  todayApiDate,
  transactionFormSchema,
  type TransactionFormInput,
  type TransactionFormValues,
} from '@budget/shared';
import { buildTransactionPatch, emptyToNull } from '@budget/api-client';
import type { components } from '@budget/api-client';
import DateTimePicker, {
  type DateTimePickerEvent,
} from '@react-native-community/datetimepicker';
import { router, useLocalSearchParams } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { confirmAction } from '../../src/components/confirm';
import { FieldError } from '../../src/components/FieldError';
import { FormButton } from '../../src/components/FormButton';
import { KeyboardAwareForm } from '../../src/components/KeyboardAwareForm';
import { KindSegmented } from '../../src/components/KindSegmented';
import { LabeledInput } from '../../src/components/LabeledInput';
import { colors, spacing, TOUCH_TARGET } from '../../src/components/theme';
import { useCategories } from '../../src/data/categories';
import { sortForDisplay } from '../../src/data/categoryLookup';
import {
  MONTH_LIMIT,
  useCreateTransaction,
  useDeleteTransaction,
  useSummary,
  useTransactions,
  useUpdateTransaction,
} from '../../src/data/transactions';
import { describeTransactionError } from '../../src/data/errors';
import { APP_LOCALE } from '../../src/lib/locale';

type CategoryRead = components['schemas']['CategoryRead'];
type TransactionRead = components['schemas']['TransactionRead'];

// "YYYY-MM-DD" -> a LOCAL Date (component build, no UTC parse — TZ-safe like the
// shared date helpers), for feeding the native picker.
function apiDateToLocalDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export default function TransactionFormScreen() {
  const params = useLocalSearchParams<{ id?: string; month?: string }>();
  const month = params.month ?? todayApiDate().slice(0, 7);
  const id = params.id;
  const isEdit = id !== undefined;

  const categoriesQuery = useCategories();
  const summaryQuery = useSummary(month);

  // Deep-link-safe edit load: locate the row in the already-cached month list by id
  // (same filter slice => same query key => shared cache). No single-row GET exists.
  const bounds = monthBounds(month);
  const txQuery = useTransactions({ from: bounds.from, to: bounds.to, limit: MONTH_LIMIT });
  const transaction: TransactionRead | undefined = isEdit
    ? txQuery.data?.pages.flatMap((page) => page.items).find((tx) => tx.id === id)
    : undefined;

  const categories = categoriesQuery.data ?? [];

  // Edit mode, list still loading: wait rather than mis-render as create.
  if (isEdit && txQuery.isPending) {
    return (
      <Shell title="Edit transaction">
        <Text style={styles.notice}>Loading…</Text>
      </Shell>
    );
  }

  // Cold deep link whose row isn't in the cached month (R4): unavailable + back.
  if (isEdit && transaction === undefined) {
    return (
      <Shell title="Edit transaction">
        <Text accessibilityRole="alert" style={styles.unavailable}>
          This transaction is unavailable.
        </Text>
        <FormButton label="Go back" variant="secondary" onPress={() => router.back()} />
      </Shell>
    );
  }

  const currency = transaction?.currency ?? summaryQuery.data?.currency;

  return (
    <TransactionFormBody
      transaction={transaction}
      categories={categories}
      currency={currency}
    />
  );
}

interface BodyProps {
  transaction: TransactionRead | undefined;
  categories: CategoryRead[];
  currency: string | undefined;
}

function TransactionFormBody({ transaction, categories, currency }: BodyProps) {
  const isEdit = transaction !== undefined;

  // Currency is display-only and never collected (W7). Until the create form's
  // currency resolves from the month summary, the form is degraded: submit disabled.
  const currencyKnown = currency !== undefined;
  const schemaCurrency = currency ?? 'USD';
  const createDegraded = !isEdit && !currencyKnown;

  const createTransaction = useCreateTransaction();
  const updateTransaction = useUpdateTransaction();
  const deleteTransaction = useDeleteTransaction();
  const [showDatePicker, setShowDatePicker] = useState(false);

  const defaultValues: TransactionFormInput = transaction
    ? {
        amount: toInputString(transaction.amount_minor, transaction.currency),
        kind: transaction.kind,
        category_id: transaction.category_id ?? '',
        occurred_at: transaction.occurred_at,
        note: transaction.note ?? '',
      }
    : { amount: '', kind: 'expense', category_id: '', occurred_at: todayApiDate(), note: '' };

  // Output-shaped initial values for the PATCH diff (amount as parsed minor units).
  const initial: TransactionFormValues = {
    amount: transaction?.amount_minor ?? 0,
    kind: transaction?.kind ?? 'expense',
    category_id: transaction?.category_id ?? '',
    occurred_at: transaction?.occurred_at ?? '',
    note: transaction?.note ?? '',
  };

  const {
    control,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<TransactionFormInput, unknown, TransactionFormValues>({
    resolver: zodResolver(transactionFormSchema(schemaCurrency)),
    defaultValues,
  });

  const kind = useWatch({ control, name: 'kind' });
  const selectedCategoryId = useWatch({ control, name: 'category_id' });
  const occurredAt = useWatch({ control, name: 'occurred_at' });

  // The picker shows the SELECTED KIND's categories (kind-segmented). An edit whose
  // saved category is archived keeps it selectable as the current value.
  const nonArchived = categories.filter((category) => !category.archived);
  const currentCategory = transaction?.category_id
    ? categories.find((category) => category.id === transaction.category_id)
    : undefined;
  const options = currentCategory?.archived ? [...nonArchived, currentCategory] : nonArchived;
  const kindOptions = sortForDisplay(options, APP_LOCALE).filter(
    (category) => category.kind === kind,
  );

  const onKindChange = (next: 'expense' | 'income') => {
    setValue('kind', next);
    // Flipping the segment clears a selected category whose kind no longer matches.
    const selected = categories.find((category) => category.id === selectedCategoryId);
    if (selected && selected.kind !== next) setValue('category_id', '');
  };

  const onPickCategory = (category: CategoryRead) => {
    setValue('category_id', category.id);
    // Picking a category sets kind by direct assignment (W5).
    setValue('kind', category.kind);
  };

  const onDateChange = (event: DateTimePickerEvent, date?: Date) => {
    if (Platform.OS !== 'ios') setShowDatePicker(false);
    if (event.type === 'set' && date) setValue('occurred_at', toApiDate(date));
    else if (event.type === 'dismissed') setShowDatePicker(false);
  };

  const routeError = (error: unknown) => {
    const { field, message } = describeTransactionError(error);
    const target = field === 'form' ? 'root' : field === 'amount_minor' ? 'amount' : field;
    setError(target, { message });
  };

  const onSubmit = handleSubmit(async (values) => {
    try {
      if (isEdit && transaction) {
        const patch = buildTransactionPatch(values, initial);
        if (Object.keys(patch).length > 0) {
          await updateTransaction.mutateAsync({
            id: transaction.id,
            body: patch,
            previousOccurredAt: transaction.occurred_at,
          });
        }
      } else {
        await createTransaction.mutateAsync({
          amount_minor: values.amount,
          kind: values.kind,
          category_id: emptyToNull(values.category_id),
          occurred_at: values.occurred_at,
          note: emptyToNull(values.note),
        });
      }
      router.back();
    } catch (error) {
      routeError(error);
    }
  });

  const onDelete = () => {
    if (!transaction) return;
    confirmAction({
      title: 'Delete transaction',
      message: "Delete this transaction? This can't be undone.",
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: () => {
        deleteTransaction.mutate(
          { id: transaction.id, occurredAt: transaction.occurred_at },
          {
            onSuccess: () => router.back(),
            onError: routeError,
          },
        );
      },
    });
  };

  const pending = isSubmitting || createTransaction.isPending || updateTransaction.isPending;

  return (
    <Shell title={isEdit ? 'Edit transaction' : 'New transaction'}>
      <FieldError message={errors.root?.message} />
      {createDegraded ? <Text style={styles.notice}>Loading account currency…</Text> : null}

      <Controller
        control={control}
        name="amount"
        render={({ field }) => (
          <LabeledInput
            label={currencyKnown ? `Amount (${currency})` : 'Amount'}
            keyboardType="decimal-pad"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={errors.amount?.message}
          />
        )}
      />

      <View style={styles.field}>
        <Text style={styles.label}>Type</Text>
        <KindSegmented value={kind} onChange={onKindChange} />
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Category</Text>
        <View style={styles.chips}>
          <Chip
            label="Uncategorized"
            selected={selectedCategoryId === ''}
            onPress={() => setValue('category_id', '')}
          />
          {kindOptions.map((category) => (
            <Chip
              key={category.id}
              label={`${category.icon ? `${category.icon} ` : ''}${category.name}${
                category.archived ? ' (archived)' : ''
              }`}
              selected={selectedCategoryId === category.id}
              onPress={() => onPickCategory(category)}
            />
          ))}
        </View>
        <FieldError message={errors.category_id?.message} />
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Date</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => setShowDatePicker(true)}
          style={styles.dateButton}
        >
          <Text style={styles.dateText}>
            {formatApiDate(occurredAt, { locale: APP_LOCALE })}
          </Text>
        </Pressable>
        {showDatePicker ? (
          <>
            <DateTimePicker
              value={apiDateToLocalDate(occurredAt)}
              mode="date"
              display={Platform.OS === 'ios' ? 'inline' : 'default'}
              onChange={onDateChange}
            />
            {Platform.OS === 'ios' ? (
              <FormButton
                label="Done"
                variant="secondary"
                onPress={() => setShowDatePicker(false)}
              />
            ) : null}
          </>
        ) : null}
        <FieldError message={errors.occurred_at?.message} />
      </View>

      <Controller
        control={control}
        name="note"
        render={({ field }) => (
          <LabeledInput
            label="Note (optional)"
            multiline
            maxLength={500}
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={errors.note?.message}
            style={styles.noteInput}
          />
        )}
      />

      <FormButton
        label="Save"
        onPress={onSubmit}
        pending={pending}
        disabled={createDegraded}
      />
      {isEdit ? (
        <FormButton
          label="Delete"
          variant="danger"
          onPress={onDelete}
          pending={deleteTransaction.isPending}
        />
      ) : null}
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

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} hitSlop={8}>
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
        <Text style={styles.title}>{title}</Text>
        <View style={styles.headerSpacer} />
      </View>
      <KeyboardAwareForm>{children}</KeyboardAwareForm>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.text,
  },
  cancel: {
    fontSize: 16,
    color: colors.primary,
    minWidth: 60,
  },
  headerSpacer: {
    minWidth: 60,
  },
  field: {
    gap: spacing.xs,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
  },
  notice: {
    color: colors.textMuted,
    fontSize: 14,
  },
  unavailable: {
    color: colors.danger,
    fontSize: 15,
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
  dateButton: {
    minHeight: TOUCH_TARGET,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    backgroundColor: colors.card,
  },
  dateText: {
    fontSize: 16,
    color: colors.text,
  },
  noteInput: {
    minHeight: 88,
    textAlignVertical: 'top',
  },
});
