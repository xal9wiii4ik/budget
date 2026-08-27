import { Link } from 'react-router';

import type { StatementApplyReport, StatementReplaceReport } from '../../data/imports';
import { useT } from '../../i18n/context';
import styles from './ImportReport.module.css';

/**
 * What an apply or a replace DID, straight out of the response body (§10.6).
 *
 * The two reports are deliberately different shapes on the wire — a replace
 * honours no per-row decisions, so it has no `skipped`/`replaced` — and this
 * component keeps them different instead of flattening them into one set of
 * labels that would mean two things.
 */
export type ImportReportData =
  | { kind: 'apply'; report: StatementApplyReport }
  | { kind: 'replace'; report: StatementReplaceReport };

interface ImportReportProps {
  data: ImportReportData;
  /** Where the imported operations now live. */
  transactionsHref: string;
}

export function ImportReport({ data, transactionsHref }: ImportReportProps) {
  const t = useT();

  return (
    <section className={styles.report} role="status">
      <h2 className={styles.title}>
        {data.kind === 'apply' ? t('imports.reportTitle') : t('imports.reportReplaceTitle')}
      </h2>
      <ul className={styles.figures}>
        {data.kind === 'replace' ? (
          <li className={styles.figure}>
            {t('imports.reportDeleted', { count: data.report.deleted })}
          </li>
        ) : null}
        <li className={styles.figure}>
          {t('imports.reportCreated', { count: data.report.created })}
        </li>
        {data.kind === 'apply' ? (
          <>
            <li className={styles.figure}>
              {t('imports.reportSkipped', { count: data.report.skipped })}
            </li>
            <li className={styles.figure}>
              {t('imports.reportReplaced', { count: data.report.replaced })}
            </li>
          </>
        ) : null}
        {/* Idempotent repeats: a second apply after a dropped connection lands
            here rather than creating a duplicate, and saying so is what makes
            the retry button honest. */}
        <li className={styles.figure}>
          {t('imports.reportAlreadyExisted', { count: data.report.already_existed })}
        </li>
      </ul>
      <Link className={styles.link} to={transactionsHref}>
        {t('imports.openTransactions')}
      </Link>
    </section>
  );
}
