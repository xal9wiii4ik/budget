import { formatTimestamp } from '@budget/shared';

import { Button } from '../../components/Button';
import { QueryStateNotice } from '../../components/QueryStateNotice';
import {
  useImportReconciliation,
  useReconcileImport,
  useStatementFormats,
  type DiscrepancyCounts,
  type StatementImportRead,
  type StatementReconciliationRead,
} from '../../data/imports';
import { useLang, useLocale, useT } from '../../i18n/context';
import type { PluralKey } from '../../i18n/t';
import { describeImportError } from '../../lib/errors';
import { queryPhase } from '../../lib/queryPhase';
import { reconciliationGroups } from './reconciliationGroups';
import { ReconciliationItem } from './ReconciliationItem';
import styles from './ImportReconciliation.module.css';

interface ImportReconciliationProps {
  session: StatementImportRead;
  /** The account+period transactions view each app-side item links to. */
  transactionsHref: string;
}

/** The five kind counts, in the order the groups below are rendered. */
const COUNT_KEYS: readonly { key: keyof DiscrepancyCounts; label: PluralKey }[] = [
  { key: 'missing_in_app', label: 'imports.countMissingInApp' },
  { key: 'extra_in_app', label: 'imports.countExtraInApp' },
  { key: 'amount_differs', label: 'imports.countAmountDiffers' },
  { key: 'date_differs', label: 'imports.countDateDiffers' },
  { key: 'fx_difference', label: 'imports.countFxDifference' },
];

/**
 * "Compare this statement with what the app holds" — the reconcile agent, as a
 * section of the import screen.
 *
 * Offered on EVERY session the screen can show (grooming ruling): on a preview
 * it answers "does this file say anything my app does not", on a finished one
 * "did the import land the way I expected" — the same question from two sides,
 * which is why the server puts no lifecycle gate on the route either.
 *
 * The arm is derived during render from the SESSION's own
 * `reconciliation_status` plus the mutation's pending flag — never from the
 * mutation alone. A 60-second POST survives a navigation away and a reload, so
 * a returning user must see the running arm for a loop that is still burning
 * tokens, rather than an idle button that answers 409.
 *
 * The button is gated on the formats read's LIVE `ai_available` (the registry
 * is the server's answer, not a set frozen into this build): `false` disables
 * it with the reason in text beside it, because a disabled control with no
 * explanation is the defect. While the formats read is in flight nothing is
 * declared broken — the 503 is the authoritative answer either way.
 *
 * No money arithmetic and no counting: every figure is a server integer off the
 * report (or the session), and the groups are ordered by the pure, tested
 * `reconciliationGroups`.
 */
export function ImportReconciliation({ session, transactionsHref }: ImportReconciliationProps) {
  const t = useT();
  const lang = useLang();

  // `fresh`: whether the server has an AI provider RIGHT NOW is the gate, and a
  // cached `true` from an hour ago would offer a button that can only 503.
  const formatsQuery = useStatementFormats({ fresh: true });
  const reconcile = useReconcileImport(session.id);
  const status = session.reconciliation_status;
  const reportQuery = useImportReconciliation(session.id, { enabled: status === 'ok' });

  // The stored status is what makes this survive a reload; the pending flag is
  // what makes the click feel immediate. Either is enough to be "running".
  const running = status === 'running' || reconcile.isPending;
  // An unanswered formats read is not evidence of anything: assume available.
  const aiAvailable = formatsQuery.data?.aiAvailable ?? true;
  const failure = reconcile.error === null ? null : describeImportError(reconcile.error, lang, t);

  return (
    <section className={styles.section} aria-labelledby="reconcile-heading">
      <div className={styles.head}>
        <h2 className={styles.heading} id="reconcile-heading">
          {t('imports.reconcileTitle')}
        </h2>
        <Button
          variant="secondary"
          disabled={!aiAvailable || running}
          loading={reconcile.isPending}
          onClick={() => reconcile.mutate()}
        >
          {running
            ? t('imports.reconcilePending')
            : status === 'none'
              ? t('imports.reconcileRun')
              : t('imports.reconcileAgain')}
        </Button>
      </div>

      {aiAvailable ? null : <p className={styles.reason}>{t('imports.reconcileAiOff')}</p>}

      {running ? (
        // The screen polls the session every 3 s while the server says
        // `running` (data/imports.ts), so there is nothing for the user to
        // press: the report appears by itself. `role="status"` because the work
        // is happening somewhere else and the only news is that it finished.
        <p className={styles.running} role="status">
          {t('imports.reconcileRunningArm')}
        </p>
      ) : null}

      {/* The server's own reason for refusing, by code: 409 "already running",
          422 "did not finish" / "too much to compare", 503 the provider family
          (lib/errors.ts). Never a bare "something went wrong". */}
      {failure === null || running ? null : (
        <p className={styles.failure} role="alert">
          {failure.message}
        </p>
      )}

      {/* The STORED failure, for a user who comes back to a run that broke in
          another tab or before a reload. Suppressed while this tab is holding
          the server's own reason for the refusal above — that sentence is the
          more specific one, and two paragraphs about one failure read as two
          failures. */}
      {!running && status === 'failed' && failure === null ? (
        <p className={styles.failedArm}>{t('imports.reconcileFailedArm')}</p>
      ) : null}

      {!running && status === 'none' ? (
        <p className={styles.lede}>{t('imports.reconcileLede')}</p>
      ) : null}

      {status === 'ok' && !running ? (
        <Report query={reportQuery} session={session} transactionsHref={transactionsHref} />
      ) : null}
    </section>
  );
}

/**
 * The stored report. Its headline (when, and the model's summary) comes from the
 * REPORT rather than the session, so what is on screen is one consistent answer
 * — the counts strip included, which is the server's `counts` and never a
 * recount of the items.
 *
 * A report older than the session's last apply is shown as it is, with its own
 * timestamp: whether it is still true is a question only a new run can answer,
 * and guessing at staleness would be the client inventing a verdict.
 */
function Report({
  query,
  session,
  transactionsHref,
}: {
  query: ReturnType<typeof useImportReconciliation>;
  session: StatementImportRead;
  transactionsHref: string;
}) {
  const t = useT();
  const lang = useLang();
  const locale = useLocale();
  const phase = queryPhase(query);

  if (phase === 'loading') {
    // A stable height, so the section does not jump when the report lands.
    return (
      <div className={styles.skeleton} aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    );
  }

  if (phase === 'error' || phase === 'unreachable') {
    return (
      <QueryStateNotice
        compact
        phase={phase}
        message={
          phase === 'error'
            ? describeImportError(query.error, lang, t).message
            : t('imports.reconcileLoadFailed')
        }
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  const report: StatementReconciliationRead | undefined = query.data;
  if (report === undefined) return null;

  const groups = reconciliationGroups(report.items);
  // `reconciled_at` is a datetime, so `formatTimestamp` — `formatApiDate` is
  // date-only and NaNs on one. The report's own stamp, not the session's.
  const when = report.reconciled_at ?? session.reconciled_at;
  const summary = report.summary?.trim() ?? '';

  return (
    <div className={styles.report}>
      {when === null ? null : (
        <p className={styles.when}>
          {t('imports.reconcileAt', { when: formatTimestamp(when, { locale }) })}
        </p>
      )}

      {/* MODEL TEXT: verbatim, never translated, never run through
          `bankPhrases` (the advisor-answer rule). The server asks for it in the
          user's own language. */}
      {summary === '' ? null : (
        <div className={styles.summary}>
          <h3 className={styles.summaryLabel}>{t('imports.reconcileSummaryLabel')}</h3>
          <p className={styles.summaryText}>{summary}</p>
        </div>
      )}

      <ul className={styles.counts}>
        {/* All five kinds, zeros included: they are the closed set the agent
            looked for, and a missing line would read as "not checked". */}
        {COUNT_KEYS.map((entry) => (
          <li key={entry.key}>{t(entry.label, { count: report.counts[entry.key] })}</li>
        ))}
      </ul>

      <ul className={styles.counts}>
        {/* What never reached the model, and what it was asked about: the size
            of the question is part of the answer. */}
        <li>{t('imports.reconcileSettled', { count: report.settled_exact })}</li>
        <li>{t('imports.reconcileOpenRows', { count: report.open_rows })}</li>
        <li>
          {t('imports.reconcileOpenTransactions', { count: report.open_transactions })}
        </li>
        {/* Silence is an allowed answer from the model, and its size is the
            user's business — said only when there was any. */}
        {report.unmentioned_rows > 0 ? (
          <li>{t('imports.reconcileUnmentionedRows', { count: report.unmentioned_rows })}</li>
        ) : null}
        {report.unmentioned_transactions > 0 ? (
          <li>
            {t('imports.reconcileUnmentionedTransactions', {
              count: report.unmentioned_transactions,
            })}
          </li>
        ) : null}
      </ul>

      {groups.length === 0 ? (
        // A clean report is a GOOD outcome and the best news this section can
        // carry — never an empty list.
        <p className={styles.clean}>{t('imports.reconcileClean')}</p>
      ) : (
        groups.map((group) => (
          <div className={styles.group} key={group.kind}>
            <h3 className={styles.groupTitle}>
              {/* A kind this build has no copy for keeps the server's own
                  string: hiding a finding would be the worse failure. */}
              {group.copy === null ? group.kind : t(group.copy.titleKey)}
            </h3>
            {group.copy === null ? null : (
              <p className={styles.groupHint}>{t(group.copy.hintKey)}</p>
            )}
            <ul className={styles.items}>
              {group.items.map((item, index) => (
                <ReconciliationItem
                  // The stored items carry no id of their own; the pair of ids
                  // is what identifies a finding, and the index closes the case
                  // of a kind that names neither side. The list is read-only and
                  // never reordered, so nothing can shift under a key.
                  key={`${item.row_id ?? ''}:${item.transaction_id ?? ''}:${index}`}
                  item={item}
                  transactionsHref={transactionsHref}
                />
              ))}
            </ul>
          </div>
        ))
      )}
    </div>
  );
}
