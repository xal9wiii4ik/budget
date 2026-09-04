import {
  formatApiDate,
  parseMoney,
  sentenceEnd,
  toInputString,
  todayApiDateUtc,
} from '@budget/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';

import { Button } from '../../../components/Button';
import { CurrencySelect } from '../../../components/CurrencySelect';
import { Field, Input, Textarea } from '../../../components/Field';
import { Modal } from '../../../components/Modal';
import { useFxPreview, type FxConvertParams } from '../../../data/fx';
import {
  useCreateGoalItem,
  useUpdateGoalItem,
  type GoalItemRead,
} from '../../../data/goalItems';
import { useLang, useLocale, useT } from '../../../i18n/context';
import { describeGoalItemError } from '../../../lib/errors';
import { useDebouncedValue } from '../../../lib/useDebouncedValue';
import {
  previewAutofillValue,
  shouldShowConvertedSection,
} from '../../transactions/convertedSection';
import {
  goalItemFormSchema,
  type GoalItemFormInput,
  type GoalItemFormValues,
} from './goalItemFormSchema';
import { buildGoalItemPatch } from './goalItemPatch';
import { remindPreview, type RemindMode } from './remindPreview';
import styles from './GoalItemFormModal.module.css';

interface GoalItemFormModalProps {
  goalId: string;
  /** `goal_currency` echoed by the tree response — the plan's working currency. */
  goalCurrency: string;
  /** `undefined` = create mode; an item = edit mode. */
  item?: GoalItemRead;
  /** Create mode: the parent this item is being added under (null = a root). */
  parentId?: string | null;
  /**
   * What the node's deadline resolves to when it has none of its own — the goal's
   * date on create, the server's `effective_deadline` on edit. The reminder
   * preview counts back from it, so it is never guessed here.
   */
  inheritedDeadline: string | null;
  onClose: () => void;
}

const API_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PREVIEW_DEBOUNCE_MS = 300;

/** Which reminder intent a stored row expresses (exactly one, or none). */
function remindModeOf(item: GoalItemRead | undefined): RemindMode {
  if (item?.remind_on) return 'on';
  if (item?.remind_days_before !== null && item?.remind_days_before !== undefined) return 'days';
  return 'none';
}

/**
 * Create / edit one plan item.
 *
 * The money pair is the transactions mechanism, not a second one: the item is
 * priced in ANY currency, and a second amount in the GOAL's currency appears only
 * when the two differ (`shouldShowConvertedSection`'s rule). An untouched field
 * carries a server PREVIEW that is never sent — the server computes the stored
 * snapshot itself; a typed value is an OVERRIDE and wins; clearing it (`null` in
 * the PATCH) hands the number back to the server.
 */
export function GoalItemFormModal({
  goalId,
  goalCurrency,
  item,
  parentId = null,
  inheritedDeadline,
  onClose,
}: GoalItemFormModalProps) {
  const t = useT();
  const lang = useLang();
  const locale = useLocale();
  const isEdit = item !== undefined;

  const createItem = useCreateGoalItem(goalId);
  const updateItem = useUpdateGoalItem(goalId);

  // "Has a human typed in the converted field?" — the transactions rule: only
  // then is the value sent as an override.
  const [convertedEdited, setConvertedEdited] = useState(false);

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
    links: (item?.links ?? []).join('\n'),
    // AM-5: the amount decodes with the ITEM's own currency, never the goal's.
    amount:
      item?.amount_minor === null || item?.amount_minor === undefined
        ? ''
        : toInputString(item.amount_minor, storedCurrency),
    currency: storedCurrency,
    converted: storedConverted,
    // The stored column only — an inherited date is shown as a hint, never
    // written into the field (writing it would freeze an inheritance the user
    // never asked to break).
    deadline: item?.deadline ?? '',
    remind_mode: remindModeOf(item),
    remind_on: item?.remind_on ?? '',
    remind_days_before:
      item?.remind_days_before === null || item?.remind_days_before === undefined
        ? ''
        : String(item.remind_days_before),
  };

  const {
    control,
    register,
    handleSubmit,
    setValue,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<GoalItemFormInput, unknown, GoalItemFormValues>({
    resolver: zodResolver(goalItemFormSchema(goalCurrency, t)),
    defaultValues,
  });

  const currency = useWatch({ control, name: 'currency' });
  const amountRaw = useWatch({ control, name: 'amount' });
  const deadlineRaw = useWatch({ control, name: 'deadline' });
  const remindMode = useWatch({ control, name: 'remind_mode' });
  const remindOnRaw = useWatch({ control, name: 'remind_on' });
  const remindDaysRaw = useWatch({ control, name: 'remind_days_before' });

  // Literally the transactions rule (D8), not a second one: the second amount
  // exists only while the item is denominated in a foreign currency.
  const showConverted = shouldShowConvertedSection(currency, goalCurrency);

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

  // A live conversion PREVIEW for a create, at the rate the SERVER will use: its
  // `_today()` is UTC and an item has no date of its own, so a local date would
  // preview a different day's rate for the hours around midnight. The client
  // never multiplies by a rate — `parseMoney` only ENCODES the query parameter,
  // at the exponent of the currency the user picked (never a hardcoded x100).
  //
  // Edit mode is deliberately excluded (the transactions rule): there the STORED
  // snapshot is the truth on screen, and overwriting a user-owned override is
  // what the dirty flag exists to prevent.
  const debouncedAmount = useDebouncedValue(amountRaw, PREVIEW_DEBOUNCE_MS);
  const previewAmount = parseMoney(debouncedAmount, currency);
  const previewParams: FxConvertParams | null =
    !isEdit && showConverted && previewAmount.ok && previewAmount.minor > 0
      ? {
          amountMinor: previewAmount.minor,
          from: currency,
          to: goalCurrency,
          date: todayApiDateUtc(),
        }
      : null;
  const preview = useFxPreview(previewParams);
  const previewResult = preview.data;

  // Server result -> the untouched field (create only). A result with no rate
  // writes "", clearing a previous autofill rather than leaving a number the
  // server will not store.
  useEffect(() => {
    if (isEdit || convertedEdited) return;
    if (previewResult === undefined) return;
    setValue('converted', previewAutofillValue(previewResult), {
      shouldDirty: false,
      shouldValidate: false,
    });
  }, [previewResult, convertedEdited, isEdit, setValue]);

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

  const pending = isSubmitting || createItem.isPending || updateItem.isPending;

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
          // An untouched preview is NOT the user's override: it is omitted and
          // the server computes the snapshot at its own stored rate.
          converted_minor: convertedEdited ? values.converted_minor : null,
          deadline: values.deadline,
          remind_on: values.remind_on,
          remind_days_before: values.remind_days_before,
        });
      }
      onClose();
    } catch (error) {
      const { field, message } = describeGoalItemError(error, lang);
      // `parent_id` has no control in THIS form (the parent is chosen when the
      // item is created, and changed in the move dialog), so it lands at form
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

  return (
    <Modal
      title={t(isEdit ? 'goalItemForm.editTitle' : 'goalItemForm.newTitle')}
      onClose={onClose}
      isDirty={isDirty}
      closeDisabled={pending}
    >
      <form className={styles.form} onSubmit={onSubmit} noValidate>
        {errors.root?.message ? (
          <p className={styles.formError} role="alert">
            {errors.root.message}
          </p>
        ) : null}

        <Field label={t('common.name')} htmlFor="plan-item-name" error={errors.name?.message}>
          <Input
            id="plan-item-name"
            aria-invalid={errors.name ? true : undefined}
            {...register('name')}
          />
        </Field>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="plan-item-amount">
            {t('goalItemForm.amount')} <span className={styles.hint}>{t('common.optional')}</span>
          </label>
          <div className={styles.amountRow}>
            <Input
              id="plan-item-amount"
              inputMode="decimal"
              aria-invalid={errors.amount ? true : undefined}
              aria-describedby="plan-item-amount-hint"
              {...register('amount')}
            />
            <label className={styles.srOnly} htmlFor="plan-item-currency">
              {t('common.currency')}
            </label>
            <CurrencySelect
              id="plan-item-currency"
              registration={register('currency', {
                onChange: () => {
                  // The stored second amount belongs to the OLD currency pair —
                  // keeping it on screen would claim an override the server is
                  // about to recompute away.
                  setValue('converted', '', { shouldDirty: true, shouldValidate: false });
                  setConvertedEdited(false);
                },
              })}
              extraCurrency={storedCurrency}
            />
          </div>
          <p className={styles.hint} id="plan-item-amount-hint">
            {t('goalItemForm.amountHint')}
          </p>
          {errors.amount?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.amount.message}
            </p>
          ) : null}
        </div>

        {showConverted ? (
          <div className={styles.field}>
            <label className={styles.label} htmlFor="plan-item-converted">
              {t('goalItemForm.converted', { currency: goalCurrency })}
            </label>
            <Input
              id="plan-item-converted"
              inputMode="decimal"
              aria-invalid={errors.converted ? true : undefined}
              aria-describedby="plan-item-converted-hint"
              {...register('converted', { onChange: () => setConvertedEdited(true) })}
            />
            <p className={styles.hint} id="plan-item-converted-hint">
              {t('goalItemForm.convertedHint', { currency: goalCurrency })}
            </p>
            {!isEdit && previewParams !== null && preview.isPending ? (
              <p className={styles.hint}>{t('goalItemForm.converting')}</p>
            ) : null}
            {!isEdit && previewResult && previewResult.converted_minor === null ? (
              <p className={styles.hint}>
                {t('goalItemForm.convertedNoRate', { from: currency, to: goalCurrency })}
              </p>
            ) : null}
            {!isEdit &&
            previewResult &&
            previewResult.rate !== null &&
            previewResult.rate_as_of !== null ? (
              <p className={styles.hint}>
                {/* The rate is a SERVER string, rendered verbatim; only its date
                    goes through the locale formatter. */}
                {t('goalItemForm.convertedRate', {
                  rate: previewResult.rate,
                  date: API_DATE_PATTERN.test(previewResult.rate_as_of)
                    ? formatApiDate(previewResult.rate_as_of, { locale })
                    : previewResult.rate_as_of,
                })}
              </p>
            ) : null}
            {convertedEdited ? (
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => {
                  setValue('converted', '', { shouldDirty: true, shouldValidate: false });
                  setConvertedEdited(false);
                }}
              >
                {t('goalItemForm.convertedAuto')}
              </button>
            ) : null}
            {errors.converted?.message ? (
              <p className={styles.fieldError} role="alert">
                {errors.converted.message}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className={styles.field}>
          <label className={styles.label} htmlFor="plan-item-deadline">
            {t('goalItemForm.deadline')}{' '}
            <span className={styles.hint}>{t('common.optional')}</span>
          </label>
          <Input
            id="plan-item-deadline"
            type="date"
            aria-invalid={errors.deadline ? true : undefined}
            aria-describedby="plan-item-deadline-hint"
            {...register('deadline')}
          />
          <p className={styles.hint} id="plan-item-deadline-hint">
            {inheritedDeadline ? (
              <>
                {/* The sentence ENDS on a date, and ru dates already end in "г."
                    — `sentenceEnd` is what keeps that from rendering as "г.."
                    (qa F-4). The second sentence is a key of its own for the
                    same reason: a date can never sit mid-string here. */}
                {sentenceEnd(
                  t('goalItemForm.deadlineInheritHint', {
                    date: formatApiDate(inheritedDeadline, { locale }),
                  }),
                )}{' '}
                {t('goalItemForm.deadlineInheritMove')}
              </>
            ) : (
              t('goalItemForm.deadlineNoneHint')
            )}
          </p>
          {errors.deadline?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.deadline.message}
            </p>
          ) : null}
        </div>

        <fieldset className={styles.fieldset}>
          <legend className={styles.label}>{t('goalItemForm.remindLegend')}</legend>
          <label className={styles.radio}>
            <input
              type="radio"
              value="none"
              {...register('remind_mode', {
                onChange: () => {
                  setValue('remind_on', '', { shouldDirty: true });
                  setValue('remind_days_before', '', { shouldDirty: true });
                },
              })}
            />
            {t('goalItemForm.remindNone')}
          </label>
          <label className={styles.radio}>
            <input
              type="radio"
              value="on"
              {...register('remind_mode', {
                onChange: () => {
                  // Exactly one intent is stored: choosing a fixed date clears
                  // "N days before" instead of leaving a row the server refuses.
                  setValue('remind_days_before', '', { shouldDirty: true });
                },
              })}
            />
            {t('goalItemForm.remindOn')}
          </label>
          {remindMode === 'on' ? (
            <>
              <label className={styles.srOnly} htmlFor="plan-item-remind-on">
                {t('goalItemForm.remindOn')}
              </label>
              <Input
                id="plan-item-remind-on"
                type="date"
                aria-invalid={errors.remind_on ? true : undefined}
                {...register('remind_on')}
              />
              {errors.remind_on?.message ? (
                <p className={styles.fieldError} role="alert">
                  {errors.remind_on.message}
                </p>
              ) : null}
            </>
          ) : null}
          <label className={styles.radio}>
            <input
              type="radio"
              value="days"
              {...register('remind_mode', {
                onChange: () => {
                  setValue('remind_on', '', { shouldDirty: true });
                },
              })}
            />
            {t('goalItemForm.remindDays')}
          </label>
          {remindMode === 'days' ? (
            <>
              <label className={styles.srOnly} htmlFor="plan-item-remind-days">
                {t('goalItemForm.remindDays')}
              </label>
              <Input
                id="plan-item-remind-days"
                inputMode="numeric"
                aria-invalid={errors.remind_days_before ? true : undefined}
                {...register('remind_days_before')}
              />
              {errors.remind_days_before?.message ? (
                <p className={styles.fieldError} role="alert">
                  {errors.remind_days_before.message}
                </p>
              ) : null}
            </>
          ) : null}
          {/* The FIRING date, computed from what is typed right now: "14 days
              before" is otherwise a number nobody can check. */}
          {remindMode !== 'none' ? (
            <p className={styles.hint} role="status">
              {reminder.status === 'date'
                ? sentenceEnd(
                    t('goalItemForm.remindPreview', {
                      date: formatApiDate(reminder.date, { locale }),
                    }),
                  )
                : reminder.status === 'no-deadline'
                  ? t('goalItemForm.remindNoDeadline')
                  : t('goalItemForm.remindPreviewPending')}
            </p>
          ) : null}
        </fieldset>

        <Field
          label={
            <>
              {t('goalItemForm.description')}{' '}
              <span className={styles.hint}>{t('common.optional')}</span>
            </>
          }
          htmlFor="plan-item-description"
          error={errors.description?.message}
        >
          <Textarea
            id="plan-item-description"
            rows={3}
            aria-invalid={errors.description ? true : undefined}
            {...register('description')}
          />
        </Field>

        <Field
          label={
            <>
              {t('goalItemForm.links')}{' '}
              <span className={styles.hint}>{t('common.optional')}</span>
            </>
          }
          htmlFor="plan-item-links"
          hint={t('goalItemForm.linksHint')}
          hintId="plan-item-links-hint"
          error={errors.links?.message}
        >
          <Textarea
            id="plan-item-links"
            rows={3}
            aria-invalid={errors.links ? true : undefined}
            aria-describedby="plan-item-links-hint"
            {...register('links')}
          />
        </Field>

        <div className={styles.actions}>
          <span className={styles.spacer} />
          <Button type="submit" variant="primary" loading={pending}>
            {t(pending ? 'common.saving' : 'common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
