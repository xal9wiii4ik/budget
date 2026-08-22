import { zodResolver } from '@hookform/resolvers/zod';
import {
  currentMonth,
  recurringTemplateFormSchema,
  toInputString,
  todayApiDate,
  type RecurringTemplateFormInput,
  type RecurringTemplateFormValues,
} from '@budget/shared';
import { buildRecurringTemplatePatch, emptyToNull } from '@budget/api-client';
import type { components } from '@budget/api-client';
import type { ChangeEvent } from 'react';
import { useForm, useWatch } from 'react-hook-form';

import { CurrencySelect } from '../../components/CurrencySelect';
import { Modal } from '../../components/Modal';
import { useAccounts } from '../../data/accounts';
import { sortForDisplay } from '../../data/categoryLookup';
import {
  useCreateTemplate,
  useUpdateTemplate,
  type RecurringTemplateRead,
} from '../../data/recurring';
import { useSummary } from '../../data/transactions';
import { useLang } from '../../i18n/context';
import { localeFor } from '../../i18n/lang';
import { describeRecurringError } from '../../lib/errors';
import { queryPhase } from '../../lib/queryPhase';
import { AccountField } from '../accounts/AccountField';
import { accountFieldBlocked } from '../accounts/accountOptions';
import { pickDefaultAccount, readLastAccountId } from '../accounts/lastAccount';
import { weekdayLabels } from './periodicity';
import styles from './TemplateFormModal.module.css';

type CategoryRead = components['schemas']['CategoryRead'];

const DAYS_OF_MONTH = Array.from({ length: 31 }, (_, index) => index + 1);
// The only days a short month can clamp (D3). A fixed calendar fact, not math.
const CLAMPABLE_DAYS = ['29', '30', '31'];

interface TemplateFormModalProps {
  // `undefined` = create mode; a template = edit mode.
  template?: RecurringTemplateRead;
  categories: CategoryRead[]; // archived-inclusive set
  onClose: () => void;
}

/**
 * Create/edit a recurring template.
 *
 * CREATE goes through a SHELL that resolves the profile base currency first
 * (the shipped `TransactionFormModal` pattern, for the same reason): the currency
 * decides which exponent the amount parses with, there is no `/profile` endpoint
 * on the wire, and a guessed base is the AM-5 sin. EDIT needs no such wait — the
 * template carries its own stored `currency`, which is both the default pick and
 * the decode currency — so it does not fetch a summary at all.
 */
export function TemplateFormModal({ template, categories, onClose }: TemplateFormModalProps) {
  if (template) {
    return (
      <TemplateForm
        template={template}
        defaultCurrency={template.currency}
        categories={categories}
        onClose={onClose}
      />
    );
  }
  return <CreateTemplateShell categories={categories} onClose={onClose} />;
}

function CreateTemplateShell({
  categories,
  onClose,
}: {
  categories: CategoryRead[];
  onClose: () => void;
}) {
  // Usually a cache hit: the transactions screen fetches this same month summary.
  const summary = useSummary(currentMonth());
  const baseCurrency = summary.data?.currency;

  if (baseCurrency === undefined) {
    return (
      <Modal title="New template" onClose={onClose}>
        {summary.isError ? (
          <p className={styles.formError} role="alert">
            Couldn&apos;t load your account currency. Close this and try again.
          </p>
        ) : (
          <p className={styles.notice} role="status">
            Loading account currency…
          </p>
        )}
      </Modal>
    );
  }

  return (
    <TemplateForm defaultCurrency={baseCurrency} categories={categories} onClose={onClose} />
  );
}

interface TemplateFormProps {
  template?: RecurringTemplateRead;
  defaultCurrency: string;
  categories: CategoryRead[];
  onClose: () => void;
}

function TemplateForm({ template, defaultCurrency, categories, onClose }: TemplateFormProps) {
  const lang = useLang();
  const isEdit = template !== undefined;
  const createTemplate = useCreateTemplate();
  const updateTemplate = useUpdateTemplate();

  // The same 60s-cached archived-inclusive list every money form reads.
  const accountsQuery = useAccounts();
  const accounts = accountsQuery.data ?? [];
  const accountsPhase = queryPhase(accountsQuery);

  // A template's kind is expense|income by CHECK (transfers are not templatable,
  // §7); the narrow states that rather than widening the form's union.
  const templateKind = template?.kind === 'income' ? 'income' : 'expense';

  const defaultValues: RecurringTemplateFormInput = template
    ? {
        name: template.name,
        account_id: template.account_id,
        // AM-5: the amount decodes with the TEMPLATE's own currency, never a base.
        amount: toInputString(template.amount_minor, template.currency),
        currency: template.currency,
        kind: templateKind,
        category_id: template.category_id ?? '',
        merchant: template.merchant ?? '',
        note: template.note ?? '',
        interval_unit: template.interval_unit,
        day_of_month: template.day_of_month === null ? '' : String(template.day_of_month),
        weekday: template.weekday === null ? '' : String(template.weekday),
        end_date: template.end_date ?? '',
      }
    : {
        name: '',
        account_id: pickDefaultAccount(accounts, readLastAccountId()),
        amount: '',
        currency: defaultCurrency,
        kind: 'expense',
        category_id: '',
        merchant: '',
        note: '',
        interval_unit: 'month',
        day_of_month: '1',
        weekday: '',
        end_date: '',
      };

  // Output-shaped baseline for the PATCH diff.
  const initial: RecurringTemplateFormValues = {
    name: template?.name ?? '',
    account_id: template?.account_id ?? '',
    amount_minor: template?.amount_minor ?? 0,
    kind: templateKind,
    // Diff BASELINE, not a decode fallback (AM-5): the create branch never
    // reaches the patch builder at all.
    currency: template?.currency ?? defaultCurrency,
    category_id: template?.category_id ?? '',
    merchant: template?.merchant ?? '',
    note: template?.note ?? '',
    interval_unit: template?.interval_unit ?? 'month',
    day_of_month: template?.day_of_month ?? null,
    weekday: template?.weekday ?? null,
    end_date: template?.end_date ?? null,
  };

  const {
    control,
    register,
    handleSubmit,
    setError,
    setValue,
    getValues,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<RecurringTemplateFormInput, unknown, RecurringTemplateFormValues>({
    resolver: zodResolver(recurringTemplateFormSchema()),
    defaultValues,
  });

  const intervalUnit = useWatch({ control, name: 'interval_unit' });
  const dayOfMonth = useWatch({ control, name: 'day_of_month' });
  const endDate = useWatch({ control, name: 'end_date' });

  // ADVISORY only, and about the USER'S INPUT — not a derivation of server state.
  // R2 forbids re-deriving what the server computes (`next_due_on`, "ended"); an
  // end date the user just typed is neither. Both strings are "YYYY-MM-DD", so a
  // lexicographic compare IS a date compare (the shipped ContributionModal
  // future-date notice). D4 accepts a past end date, so this never blocks.
  const endDateHasPassed = endDate !== '' && endDate < todayApiDate();

  const kindReg = register('kind');
  const categoryReg = register('category_id');
  const unitReg = register('interval_unit');

  // Picker lists non-archived categories; an edit whose saved category is archived
  // keeps that archived category selectable as the current value.
  const nonArchived = categories.filter((category) => !category.archived);
  const currentCategory = template?.category_id
    ? categories.find((category) => category.id === template.category_id)
    : undefined;
  const options = currentCategory?.archived ? [...nonArchived, currentCategory] : nonArchived;
  // Collated in the CHOSEN language, over the already-translated names.
  const sortedOptions = sortForDisplay(options, localeFor(lang));
  const expenseOptions = sortedOptions.filter((category) => category.kind === 'expense');
  const incomeOptions = sortedOptions.filter((category) => category.kind === 'income');

  const weekdays = weekdayLabels();

  // Kind-agnostic (reads event.target.value): flipping the kind clears a selected
  // category whose kind no longer matches.
  const onKindChange = (event: ChangeEvent<HTMLInputElement>) => {
    void kindReg.onChange(event);
    const selectedId = getValues('category_id');
    const selected = categories.find((category) => category.id === selectedId);
    if (selected && selected.kind !== event.target.value) {
      setValue('category_id', '');
    }
  };

  // Switching the unit gives the newly relevant anchor a usable default so the
  // control is never submitted empty; the schema drops the other one anyway.
  const onUnitChange = (event: ChangeEvent<HTMLInputElement>) => {
    void unitReg.onChange(event);
    if (event.target.value === 'month' && getValues('day_of_month') === '') {
      setValue('day_of_month', '1');
    }
    if (event.target.value === 'week' && getValues('weekday') === '') {
      setValue('weekday', '0');
    }
  };

  const onSubmit = handleSubmit(async (values) => {
    try {
      if (isEdit && template) {
        const patch = buildRecurringTemplatePatch(values, initial);
        if (Object.keys(patch).length > 0) {
          await updateTemplate.mutateAsync({ id: template.id, body: patch });
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
          end_date: values.end_date,
          // A new template starts running; pausing is a row action (WR-9).
          paused: false,
        });
      }
      onClose();
    } catch (error) {
      // The 404 list refetch is handled by the mutation's onError in
      // data/recurring.ts; here we only route the message onto the right field.
      const { field, message } = describeRecurringError(error, lang);
      const target = field === 'form' ? 'root' : field === 'amount_minor' ? 'amount' : field;
      setError(target, { message });
    }
  });

  const pending = isSubmitting || createTemplate.isPending || updateTemplate.isPending;
  // Only a CREATE picks an account (the edit arm shows the stored one read-only),
  // so only a create can be blocked by an unavailable or empty list.
  const noAccounts = !isEdit && accountFieldBlocked(accountsPhase, accounts);
  const currentAccount = accounts.find((account) => account.id === template?.account_id);

  return (
    <Modal
      title={isEdit ? 'Edit template' : 'New template'}
      onClose={onClose}
      closeDisabled={pending}
      isDirty={isDirty}
    >
      <form className={styles.form} onSubmit={onSubmit} noValidate>
        {errors.root?.message ? (
          <p className={styles.formError} role="alert">
            {errors.root.message}
          </p>
        ) : null}

        <div className={styles.field}>
          <label className={styles.label} htmlFor="template-name">
            Name
          </label>
          <input
            id="template-name"
            className={errors.name ? `${styles.input} ${styles.inputError}` : styles.input}
            maxLength={100}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby="template-name-hint"
            {...register('name')}
          />
          <p className={styles.hint} id="template-name-hint">
            What this is — &quot;Rent&quot;, &quot;Salary&quot;, &quot;Spotify&quot;.
          </p>
          {errors.name?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.name.message}
            </p>
          ) : null}
        </div>

        {isEdit ? (
          // Read-only on edit: `RecurringTemplateUpdate` carries no account on the
          // current contract, so a picker here could only ever look like it
          // worked. Moving a template to another account is delete + re-create
          // until that PATCH field exists.
          <div className={styles.field}>
            <label className={styles.label} htmlFor="template-account">
              Account
            </label>
            <p className={styles.readOnlyValue} id="template-account">
              {currentAccount
                ? `${currentAccount.name} · ${currentAccount.currency}`
                : 'This template’s account'}
            </p>
            <p className={styles.hint}>
              Every transaction this template creates is recorded on this account. It
              can’t be changed after the template is created.
            </p>
          </div>
        ) : (
          <AccountField
            id="template-account"
            label="Account"
            hint="Every transaction this template creates is recorded on this account."
            registration={register('account_id')}
            accounts={accounts}
            phase={accountsPhase}
            onRetry={() => {
              void accountsQuery.refetch();
            }}
            errorMessage={errors.account_id?.message}
          />
        )}

        <div className={styles.field}>
          <label className={styles.label} htmlFor="template-amount">
            Amount
          </label>
          <div className={styles.amountRow}>
            <input
              id="template-amount"
              inputMode="decimal"
              className={errors.amount ? `${styles.input} ${styles.inputError}` : styles.input}
              aria-invalid={errors.amount ? true : undefined}
              {...register('amount')}
            />
            <label className={styles.srOnly} htmlFor="template-currency">
              Currency
            </label>
            <CurrencySelect
              id="template-currency"
              registration={register('currency')}
              // An existing template in an out-of-set currency stays selectable.
              extraCurrency={template?.currency}
            />
          </div>
          {errors.amount?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.amount.message}
            </p>
          ) : null}
          {errors.currency?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.currency.message}
            </p>
          ) : null}
        </div>

        <fieldset className={styles.field}>
          <legend className={styles.label}>Type</legend>
          <div className={styles.radioGroup}>
            <label className={styles.radioOption}>
              <input type="radio" value="expense" {...kindReg} onChange={onKindChange} />
              Expense
            </label>
            <label className={styles.radioOption}>
              <input type="radio" value="income" {...kindReg} onChange={onKindChange} />
              Income
            </label>
          </div>
        </fieldset>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="template-category">
            Category <span className={styles.hint}>(optional)</span>
          </label>
          <select
            id="template-category"
            className={styles.select}
            {...categoryReg}
            onChange={(event) => {
              void categoryReg.onChange(event);
              const picked = categories.find((category) => category.id === event.target.value);
              // Category -> kind only (the 1.2 sign-authority direction, T5).
              if (picked) setValue('kind', picked.kind);
            }}
          >
            <option value="">Uncategorized</option>
            {expenseOptions.length > 0 ? (
              <optgroup label="Expense">
                {expenseOptions.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                    {category.archived ? ' (archived)' : ''}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {incomeOptions.length > 0 ? (
              <optgroup label="Income">
                {incomeOptions.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                    {category.archived ? ' (archived)' : ''}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
          {errors.category_id?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.category_id.message}
            </p>
          ) : null}
        </div>

        <fieldset className={styles.field}>
          <legend className={styles.label}>Repeats</legend>
          <div className={styles.periodicity}>
            <label className={styles.radioOption}>
              <input type="radio" value="month" {...unitReg} onChange={onUnitChange} />
              Monthly
            </label>
            {intervalUnit === 'month' ? (
              <>
                <label className={styles.srOnly} htmlFor="template-day">
                  Day of the month
                </label>
                <select id="template-day" className={styles.select} {...register('day_of_month')}>
                  {DAYS_OF_MONTH.map((day) => (
                    <option key={day} value={String(day)}>
                      {day}
                    </option>
                  ))}
                </select>
              </>
            ) : null}
          </div>
          {intervalUnit === 'month' && CLAMPABLE_DAYS.includes(dayOfMonth) ? (
            // The clamp is a SERVER rule (D3): the client STATES it and never
            // computes it. Which days can be clamped is a fixed fact about the
            // calendar (29/30/31), not a calculation — and showing this line
            // under "day 5", where no month is shorter, would be false.
            <p className={styles.hint}>
              Months shorter than this use their last day (31 → Feb 28).
            </p>
          ) : null}
          {errors.day_of_month?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.day_of_month.message}
            </p>
          ) : null}

          <div className={styles.periodicity}>
            <label className={styles.radioOption}>
              <input type="radio" value="week" {...unitReg} onChange={onUnitChange} />
              Weekly
            </label>
            {intervalUnit === 'week' ? (
              <>
                <label className={styles.srOnly} htmlFor="template-weekday">
                  Weekday
                </label>
                <select id="template-weekday" className={styles.select} {...register('weekday')}>
                  {/* Index IS the wire value: ISO 0 = Monday (R1). */}
                  {weekdays.map((label, index) => (
                    <option key={label} value={String(index)}>
                      {label}
                    </option>
                  ))}
                </select>
              </>
            ) : null}
          </div>
          {errors.weekday?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.weekday.message}
            </p>
          ) : null}
        </fieldset>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="template-end-date">
            End date <span className={styles.hint}>(optional)</span>
          </label>
          <input
            id="template-end-date"
            type="date"
            className={errors.end_date ? `${styles.input} ${styles.inputError}` : styles.input}
            aria-invalid={errors.end_date ? true : undefined}
            aria-describedby="template-end-date-hint"
            {...register('end_date')}
          />
          <p className={styles.hint} id="template-end-date-hint">
            Leave empty to keep it running until you pause or delete it.
          </p>
          {endDateHasPassed ? (
            <p className={styles.notice} role="status">
              This end date has passed — nothing will be created.
            </p>
          ) : null}
          {errors.end_date?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.end_date.message}
            </p>
          ) : null}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="template-merchant">
            Merchant <span className={styles.hint}>(optional)</span>
          </label>
          <input
            id="template-merchant"
            className={errors.merchant ? `${styles.input} ${styles.inputError}` : styles.input}
            maxLength={255}
            aria-invalid={errors.merchant ? true : undefined}
            {...register('merchant')}
          />
          {errors.merchant?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.merchant.message}
            </p>
          ) : null}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="template-note">
            Note <span className={styles.hint}>(optional)</span>
          </label>
          <textarea
            id="template-note"
            className={errors.note ? `${styles.textarea} ${styles.inputError}` : styles.textarea}
            maxLength={500}
            aria-invalid={errors.note ? true : undefined}
            aria-describedby="template-note-hint"
            {...register('note')}
          />
          <p className={styles.hint} id="template-note-hint">
            Copied onto every transaction this template creates.
          </p>
          {errors.note?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.note.message}
            </p>
          ) : null}
        </div>

        <div className={styles.actions}>
          <span className={styles.spacer} />
          <button type="submit" className={styles.submit} disabled={pending || noAccounts}>
            {pending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
