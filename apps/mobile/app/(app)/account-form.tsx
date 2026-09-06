// Create / edit / archive one account (accounts-and-transfers MOB) — the
// category-form screen's shape, with the account rules on top:
//
//   * the CURRENCY is chosen once, at creation, and is read-only afterwards
//     (architecture §4): every row on the account is denominated in it and the
//     balance is a plain integer sum, so changing it would silently reinterpret
//     history. The read-only arm says what to do instead.
//   * there is no DELETE at all (§9) — only archive, behind a confirmation.
//   * `starting_balance` is the only SIGNED money input in the app (a credit card
//     legitimately starts in the minus); the shared schema owns that sign rule and
//     `toLocalSignedInputString` prefills it (N-5: with the separator the
//     interface language can type).
import { zodResolver } from '@hookform/resolvers/zod';
import {
  accountFormSchema,
  currentMonth,
  SUPPORTED_CURRENCIES,
  type AccountFormInput,
  type AccountFormValues,
} from '@budget/shared';
import { buildAccountPatch } from '@budget/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { type ReactNode } from 'react';
import { Controller, useForm, useWatch, type Resolver } from 'react-hook-form';
import { Platform, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { confirmAction } from '../../src/components/confirm';
import { FieldError } from '../../src/components/FieldError';
import { FormButton } from '../../src/components/FormButton';
import { KeyboardAwareForm } from '../../src/components/KeyboardAwareForm';
import { LabeledInput } from '../../src/components/LabeledInput';
import { themedStyles } from '../../src/theme/themedStyles';
import {
  useAccounts,
  useCreateAccount,
  useUpdateAccount,
  type AccountRead,
  type AccountType,
} from '../../src/data/accounts';
import { describeAccountError } from '../../src/data/errors';
import { qk } from '../../src/data/queryKeys';
import { useLang, useT } from '../../src/i18n/context';
import type { SimpleKey } from '../../src/i18n/t';
import { normalizeAmountInput, toLocalSignedInputString } from '../../src/lib/amountInput';
import type { components } from '@budget/api-client';

type SummaryRead = components['schemas']['SummaryRead'];

const TYPES: { value: AccountType; emoji: string; labelKey: SimpleKey }[] = [
  { value: 'card', emoji: '💳', labelKey: 'accounts.typeCard' },
  { value: 'cash', emoji: '💵', labelKey: 'accounts.typeCash' },
];

export default function AccountFormScreen() {
  const t = useT();
  const styles = useStyles();
  const params = useLocalSearchParams<{ id?: string }>();
  const id = params.id;
  const isEdit = id !== undefined;

  const accountsQuery = useAccounts();
  const account = isEdit ? accountsQuery.data?.find((a) => a.id === id) : undefined;

  // The profile base currency, used ONLY as the default pick for a new account.
  // Read from the cache WITHOUT subscribing: the transactions tab has normally
  // already fetched this month's summary, and a cosmetic default is not worth a
  // request of its own on a mobile connection. It decodes nothing (nothing is
  // parsed before the user picks), so falling back to the first supported code is
  // a default rather than an AM-5 guess.
  const queryClient = useQueryClient();
  const cachedSummary = queryClient.getQueryData<SummaryRead>(qk.txSummary(currentMonth()));

  if (isEdit && accountsQuery.isPending) {
    return (
      <Shell title={t('accountForm.editTitle')}>
        <Text style={styles.notice}>{t('common.loading')}</Text>
      </Shell>
    );
  }

  // Deep-link-safe: the accounts cache is the single source; a missing id (cold
  // deep link, or an account gone in another session) shows unavailable + back
  // rather than a form that would create something new.
  if (isEdit && account === undefined) {
    return (
      <Shell title={t('accountForm.editTitle')}>
        <Text accessibilityRole="alert" style={styles.unavailable}>
          {t('accountForm.unavailable')}
        </Text>
        <FormButton
          label={t('common.goBack')}
          variant="secondary"
          onPress={() => router.back()}
        />
      </Shell>
    );
  }

  return <AccountFormBody account={account} defaultCurrency={cachedSummary?.currency} />;
}

function AccountFormBody({
  account,
  defaultCurrency,
}: {
  account: AccountRead | undefined;
  defaultCurrency: string | undefined;
}) {
  const t = useT();
  const styles = useStyles();
  // The error copy is shared with web and rendered in the language on screen.
  const lang = useLang();
  const isEdit = account !== undefined;
  const startingCurrency = account?.currency ?? defaultCurrency ?? SUPPORTED_CURRENCIES[0];

  const createAccount = useCreateAccount();
  const updateAccount = useUpdateAccount();
  const archiveAccount = useUpdateAccount();

  const defaultValues: AccountFormInput = account
    ? {
        name: account.name,
        type: account.type,
        currency: account.currency,
        // AM-5: decoded with the account's OWN currency, never a base. SIGNED:
        // a card's stored balance is legitimately negative, and the unsigned
        // helper throws on one.
        // N-5 (catch-up 3, line B): the separator follows the INTERFACE
        // language, because that is the keyboard the user has — a ru decimal-pad
        // cannot type the '.' the machine string carries. `normalizeAmountInput`
        // in the resolver maps it back before the shared schema sees it.
        starting_balance: toLocalSignedInputString(
          account.starting_balance_minor,
          account.currency,
          lang,
        ),
      }
    : { name: '', type: 'card', currency: startingCurrency, starting_balance: '' };

  // Output-shaped baseline for the PATCH diff.
  const initial: AccountFormValues = {
    name: account?.name ?? '',
    type: account?.type ?? 'card',
    // Diff BASELINE, not a decode fallback: the create branch never reaches the
    // patch builder, and the builder emits no `currency` key at all (§4).
    currency: startingCurrency,
    starting_balance_minor: account?.starting_balance_minor ?? 0,
  };

  // F-1: the numeric keyboard's separator key is the DEVICE locale's (',' on
  // ru-RU) while the shared parser accepts '.' only. Normalize at this boundary —
  // the field keeps showing what was typed; only the validated value is
  // normalized. A leading '-' passes through untouched (the shared schema strips
  // the sign before parsing the magnitude).
  const resolver: Resolver<AccountFormInput, unknown, AccountFormValues> = (
    values,
    context,
    options,
  ) =>
    zodResolver(accountFormSchema)(
      { ...values, starting_balance: normalizeAmountInput(values.starting_balance) },
      context,
      options,
    );

  const {
    control,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<AccountFormInput, unknown, AccountFormValues>({ resolver, defaultValues });

  const type = useWatch({ control, name: 'type' });
  // The exponent the starting balance is parsed with follows this value, so the
  // amount field is labelled with the currency the user has actually picked.
  const currency = useWatch({ control, name: 'currency' });

  const routeError = (error: unknown) => {
    const { field, message } = describeAccountError(error, lang);
    const target =
      field === 'form'
        ? 'root'
        : field === 'starting_balance_minor'
          ? 'starting_balance'
          : field;
    setError(target, { message });
  };

  const onSubmit = handleSubmit(async (values) => {
    try {
      if (isEdit && account) {
        const patch = buildAccountPatch(values, initial);
        if (Object.keys(patch).length > 0) {
          await updateAccount.mutateAsync({ id: account.id, body: patch });
        }
      } else {
        await createAccount.mutateAsync({
          name: values.name,
          type: values.type,
          currency: values.currency,
          starting_balance_minor: values.starting_balance_minor,
        });
      }
      router.back();
    } catch (error) {
      routeError(error);
    }
  });

  const onArchiveToggle = () => {
    if (!account) return;
    const archiving = !account.archived;
    confirmAction({
      cancelLabel: t('common.cancel'),
      title: t(archiving ? 'accountForm.archiveTitle' : 'accountForm.unarchiveTitle'),
      // The account NAME is interpolated, never translated.
      message: t(
        archiving ? 'accountForm.archiveMessage' : 'accountForm.unarchiveMessage',
        { name: account.name },
      ),
      confirmLabel: t(archiving ? 'common.archive' : 'common.unarchive'),
      destructive: archiving,
      onConfirm: () => {
        archiveAccount.mutate(
          { id: account.id, body: { archived: archiving } },
          { onSuccess: () => router.back(), onError: routeError },
        );
      },
    });
  };

  const pending = isSubmitting || createAccount.isPending || updateAccount.isPending;
  // Only the SUPPORTED set, plus whatever this account is already denominated in
  // (a code that left the set must still render as the selected one, and it is
  // read-only here anyway).
  const currencyOptions: string[] = SUPPORTED_CURRENCIES.includes(
    currency as (typeof SUPPORTED_CURRENCIES)[number],
  )
    ? [...SUPPORTED_CURRENCIES]
    : [...SUPPORTED_CURRENCIES, currency];

  return (
    <Shell
      title={t(isEdit ? 'accountForm.editTitle' : 'accountForm.newTitle')}
      footer={
        <>
          <FormButton label={t('common.save')} onPress={onSubmit} pending={pending} />
          {isEdit && account ? (
            <FormButton
              label={t(account.archived ? 'common.unarchive' : 'common.archive')}
              variant={account.archived ? 'secondary' : 'danger'}
              onPress={onArchiveToggle}
              pending={archiveAccount.isPending}
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
            error={errors.name?.message}
          />
        )}
      />

      <View style={styles.field}>
        <Text style={styles.label}>{t('common.type')}</Text>
        <View style={styles.chips}>
          {TYPES.map((option) => (
            <Chip
              key={option.value}
              label={`${option.emoji} ${t(option.labelKey)}`}
              selected={type === option.value}
              onPress={() => setValue('type', option.value)}
            />
          ))}
        </View>
        <FieldError message={errors.type?.message} />
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>{t('common.currency')}</Text>
        {isEdit ? (
          <>
            <Text style={styles.readonlyValue}>{currency}</Text>
            <Text style={styles.hint}>{t('accountForm.currencyImmutableHint')}</Text>
          </>
        ) : (
          <View style={styles.chips}>
            {currencyOptions.map((code) => (
              <Chip
                key={code}
                label={code}
                selected={currency === code}
                onPress={() => setValue('currency', code)}
              />
            ))}
          </View>
        )}
        <FieldError message={errors.currency?.message} />
      </View>

      <Controller
        control={control}
        name="starting_balance"
        render={({ field }) => (
          <LabeledInput
            label={t('accountForm.startingBalance', { currency })}
            // iOS's decimal-pad has no minus key, and a card in the red starts
            // negative — so the punctuation keyboard is the one that can express
            // this field. Android's numeric pad already carries '-'.
            keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'numeric'}
            placeholder="0"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            hint={t('accountForm.startingBalanceHint')}
            error={errors.starting_balance?.message}
          />
        )}
      />

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
    color: t.colors.textMuted,
    fontSize: t.type.sm,
  },
  unavailable: {
    color: t.colors.danger,
    fontSize: t.type.md,
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
