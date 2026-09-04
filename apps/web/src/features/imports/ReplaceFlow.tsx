import { formatApiDate } from '@budget/shared';
import { useState } from 'react';

import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';
import { Input } from '../../components/Field';
import { QueryStateNotice } from '../../components/QueryStateNotice';
import {
  useReplaceImport,
  useReplacePreview,
  type StatementReplaceReport,
} from '../../data/imports';
import { useLang, useLocale, useT } from '../../i18n/context';
import { describeImportError, replaceConfirmationMismatch } from '../../lib/errors';
import { queryPhase } from '../../lib/queryPhase';
import { canConfirmReplace, replaceConfirmState } from './replaceConfirmGate';
import styles from './ReplaceFlow.module.css';

interface ReplaceFlowProps {
  importId: string;
  periodFrom: string;
  periodTo: string;
  onClose: () => void;
  onReplaced: (report: StatementReplaceReport) => void;
}

/**
 * "Replace everything from date X" — the one action in this app that DELETES
 * money records the user did not ask about individually.
 *
 * Three things make it hard to do by accident, and all three are deliberate:
 *
 * 1. The warning is the SERVER's own count, read with the very predicate the
 *    delete runs, and it is itemised by what dies WITH each row — a receipt
 *    link, a goal plan payment, a recurring template's attribution. Transfers
 *    are listed separately as kept, because they are never deleted (one row,
 *    two accounts).
 * 2. The confirmation is TYPING that count back, not ticking a box: it cannot be
 *    satisfied without reading the number, and it is language-independent. The
 *    rule lives in the tested `replaceConfirmGate`; changing the date or losing
 *    the preview locks the button again and clears what was typed.
 * 3. The number goes to the server IN the request, which re-checks it against
 *    what it is really about to delete. If something was booked in the meantime,
 *    the whole thing rolls back and answers with BOTH numbers — which this flow
 *    renders as a sentence and a fresh preview, not as a code.
 */
export function ReplaceFlow({
  importId,
  periodFrom,
  periodTo,
  onClose,
  onReplaced,
}: ReplaceFlowProps) {
  const t = useT();
  const lang = useLang();
  const locale = useLocale();
  // The period is shown in the user's own date format; the INPUT keeps the ISO
  // value the wire uses, which is what `min`/`max` compare against.
  const periodFromLabel = formatApiDate(periodFrom, { locale });
  const periodToLabel = formatApiDate(periodTo, { locale });
  const [fromDate, setFromDate] = useState('');
  const [typed, setTyped] = useState('');
  const replace = useReplaceImport(importId);

  // Only a date the statement can actually cover is worth asking the server
  // about; anything else is refused by `replaceConfirmState` first, and the
  // query stays disabled instead of firing a request that would 422.
  const inRange = fromDate !== '' && fromDate >= periodFrom && fromDate <= periodTo;
  const previewQuery = useReplacePreview(importId, inRange ? fromDate : null);
  const previewPhase = queryPhase(previewQuery);
  const preview = previewQuery.isSuccess ? previewQuery.data : undefined;

  const gate = replaceConfirmState({
    fromDate,
    periodFrom,
    periodTo,
    // The preview on screen describes the date it was requested for — and the
    // query is keyed by that date, so a moved date is a different cache entry
    // with no data yet rather than the old answer under a new label.
    previewFrom: preview === undefined ? null : fromDate,
    previewDeletedTotal: preview?.deleted_total ?? null,
    typed,
    isSubmitting: replace.isPending,
  });

  const failure = replace.error === null ? null : describeImportError(replace.error, lang);
  const stale =
    failure?.code === 'REPLACE_CONFIRMATION_MISMATCH'
      ? replaceConfirmationMismatch(replace.error)
      : null;
  const errorMessage =
    stale !== null
      ? t('imports.replaceStaleNamed', { actual: stale.actual, confirmed: stale.confirmed })
      : (failure?.message ?? null);

  const submit = () => {
    if (gate.status !== 'ready') return;
    replace.mutate(
      { from_date: fromDate, confirm_deleted_total: gate.deletedTotal },
      {
        onSuccess: (report) => onReplaced(report),
        // Whatever failed, what is in the box no longer confirms anything: the
        // preview is being refetched (data/imports.ts) and the number may have
        // moved. Clearing it is the honest reset — the gate would refuse to
        // submit anyway, but a stale figure sitting next to fresh numbers reads
        // as if it still applied.
        onError: () => setTyped(''),
      },
    );
  };

  return (
    <Modal
      title={t('imports.replaceTitle')}
      onClose={onClose}
      closeDisabled={replace.isPending}
    >
      {/* Not a <form>: Enter must not fire a deletion. The button is the only
          way in, and it is the last control in the dialog. */}
      <div className={styles.panel}>
        <p className={styles.lede}>{t('imports.replaceLede')}</p>

        <label className={styles.label} htmlFor="replace-from">
          {t('imports.replaceDate')}
        </label>
        <Input
          id="replace-from"
          type="date"
          className={styles.date}
          value={fromDate}
          min={periodFrom}
          max={periodTo}
          disabled={replace.isPending}
          onChange={(event) => {
            setFromDate(event.target.value);
            // The number confirmed a range that is no longer the one on screen.
            setTyped('');
          }}
        />
        <p className={styles.hint}>
          {t('imports.replaceDateHint', { from: periodFromLabel, to: periodToLabel })}
        </p>

        {gate.status === 'out_of_range' ? (
          <p className={styles.error} role="alert">
            {t('imports.replaceDateOutOfRange', {
              from: periodFromLabel,
              to: periodToLabel,
            })}
          </p>
        ) : null}

        {inRange && previewPhase === 'loading' ? (
          <p className={styles.previewLoading} role="status">
            {t('imports.previewLoading')}
          </p>
        ) : null}

        {inRange && (previewPhase === 'error' || previewPhase === 'unreachable') ? (
          <QueryStateNotice
            phase={previewPhase}
            compact
            message={describeImportError(previewQuery.error, lang).message}
            onRetry={() => {
              void previewQuery.refetch();
            }}
          />
        ) : null}

        {preview === undefined ? null : (
          <div className={styles.preview}>
            <dl className={styles.figures}>
              <div className={styles.figure}>
                <dt className={styles.figureLabel}>{t('imports.previewDeleted')}</dt>
                <dd className={`${styles.figureValueStrong} tnum`}>{preview.deleted_total}</dd>
              </div>
              <div className={styles.figure}>
                <dt className={styles.figureLabel}>{t('imports.previewWithReceipt')}</dt>
                <dd className={`${styles.figureValue} tnum`}>{preview.deleted_with_receipt}</dd>
              </div>
              <div className={styles.figure}>
                <dt className={styles.figureLabel}>{t('imports.previewWithGoalItem')}</dt>
                <dd className={`${styles.figureValue} tnum`}>{preview.deleted_with_goal_item}</dd>
              </div>
              <div className={styles.figure}>
                <dt className={styles.figureLabel}>{t('imports.previewWithTemplate')}</dt>
                <dd className={`${styles.figureValue} tnum`}>
                  {preview.deleted_with_recurring_template}
                </dd>
              </div>
              <div className={styles.figure}>
                <dt className={styles.figureLabel}>{t('imports.previewTransfersKept')}</dt>
                <dd className={`${styles.figureValue} tnum`}>{preview.transfers_kept}</dd>
              </div>
              <div className={styles.figure}>
                <dt className={styles.figureLabel}>{t('imports.previewWillCreate')}</dt>
                <dd className={`${styles.figureValue} tnum`}>{preview.will_create}</dd>
              </div>
            </dl>
            <p className={styles.warning}>{t('imports.previewLinksNote')}</p>

            <label className={styles.label} htmlFor="replace-confirm">
              {t('imports.confirmLabel')}
            </label>
            <Input
              id="replace-confirm"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              className={`${styles.confirmInput} tnum`}
              value={typed}
              disabled={replace.isPending}
              aria-describedby="replace-confirm-hint"
              onChange={(event) => setTyped(event.target.value)}
            />
            <p id="replace-confirm-hint" className={styles.hint}>
              {gate.status === 'needs_confirmation' && gate.mismatch
                ? t('imports.confirmMismatch')
                : t('imports.confirmHint')}
            </p>
          </div>
        )}

        {errorMessage === null ? null : (
          <p className={styles.error} role="alert">
            {errorMessage}
          </p>
        )}

        <div className={styles.actions}>
          <Button onClick={onClose} disabled={replace.isPending}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" onClick={submit} disabled={!canConfirmReplace(gate)}>
            {replace.isPending ? t('imports.replacePending') : t('imports.replaceConfirm')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
