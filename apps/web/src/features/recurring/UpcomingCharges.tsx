import { formatApiDate, formatMoney, todayApiDateUtc } from '@budget/shared';
import { Link } from 'react-router';

import { QueryStateNotice } from '../../components/QueryStateNotice';
import { useUpcomingCharges } from '../../data/recurring';
import { useLocale, useT } from '../../i18n/context';
import { queryPhase } from '../../lib/queryPhase';
import { upcomingRows } from './upcomingRows';
import styles from './UpcomingCharges.module.css';

// The contract default (`ge=1 le=90`), and the row cap. Both live here as
// constants rather than props: there is one caller and no horizon control yet —
// `days` is already in the cache key, so adding one later is a parameter change,
// not a cache redesign.
const HORIZON_DAYS = 30;
const MAX_ROWS = 5;

interface UpcomingChargesProps {
  /** True while the transactions list is filtered to one account. */
  accountFiltered: boolean;
}

/**
 * "What's coming" on /transactions: the charges the user's live templates still
 * owe in the next 30 days (recurring-dates-and-income W1).
 *
 * Strictly READ-ONLY and strictly server-shaped. The rows arrive already sorted
 * (B5) and already filtered to "not yet materialized AND due today or later", so
 * this component sorts nothing, groups nothing and totals nothing — a total would
 * be cross-currency money arithmetic, and each row is stamped with its template's
 * OWN currency precisely so it does not need one.
 *
 * The widget is a secondary panel on somebody else's screen, so its failure arms
 * are compact: it must not shout over the transaction list it sits above.
 */
export function UpcomingCharges({ accountFiltered }: UpcomingChargesProps) {
  const locale = useLocale();
  const t = useT();
  const query = useUpcomingCharges(HORIZON_DAYS);
  const phase = queryPhase(query);

  // UTC, because the SERVER decided these dates in UTC (`_today()`): a
  // local-midnight compare would badge the wrong row for hours in any offset zone.
  const { rows, hiddenCount } = upcomingRows(query.data?.items ?? [], {
    max: MAX_ROWS,
    today: todayApiDateUtc(),
  });

  return (
    <section className={styles.card} aria-labelledby="upcoming-title">
      <h2 className={styles.title} id="upcoming-title">
        {t('upcoming.title')}
      </h2>

      {phase === 'loading' ? (
        // Fixed-height placeholders: the list below must not jump when they resolve.
        <ul className={styles.list} aria-hidden="true">
          <li className={styles.skeleton} />
          <li className={styles.skeleton} />
        </ul>
      ) : null}

      {phase === 'error' || phase === 'unreachable' ? (
        <QueryStateNotice
          phase={phase}
          message={t('upcoming.loadFailed')}
          onRetry={() => {
            void query.refetch();
          }}
          compact
        />
      ) : null}

      {phase === 'ready' && rows.length === 0 ? (
        // Says what to do next, and where — an empty widget that only says "none"
        // teaches the user nothing about why it exists.
        <p className={styles.empty}>
          {t('upcoming.emptyTitle')} {t('upcoming.emptyBody')}{' '}
          <Link className={styles.link} to="/recurring">
            {t('upcoming.manage')}
          </Link>
        </p>
      ) : null}

      {phase === 'ready' && rows.length > 0 ? (
        <>
          <ul className={styles.list}>
            {rows.map(({ charge, isToday }) => (
              // A template legitimately appears several times inside 30 days, so
              // the identity of a ROW is the template AND the date — never an index.
              <li
                className={isToday ? `${styles.row} ${styles.rowToday}` : styles.row}
                key={`${charge.template_id}:${charge.due_on}`}
              >
                <span className={styles.when}>
                  {formatApiDate(charge.due_on, { locale })}
                  {isToday ? (
                    // A text badge, not colour alone: "charges today" has to read
                    // at a glance and survive a monochrome screen.
                    <span className={styles.todayBadge}>{t('upcoming.today')}</span>
                  ) : null}
                </span>
                <span className={styles.name}>{charge.name}</span>
                <span
                  className={
                    charge.kind === 'expense'
                      ? `${styles.amount} ${styles.expense}`
                      : `${styles.amount} ${styles.income}`
                  }
                >
                  {/* The TemplateRow convention: sign from `kind`, amount in the
                      row's own stamped currency, never the profile base. */}
                  {formatMoney(
                    charge.kind === 'expense' ? -charge.amount_minor : charge.amount_minor,
                    charge.currency,
                    { locale },
                  )}
                </span>
              </li>
            ))}
          </ul>
          <p className={styles.footer}>
            {hiddenCount > 0 ? <span>{t('upcoming.more', { count: hiddenCount })} </span> : null}
            <Link className={styles.link} to="/recurring">
              {t('upcoming.manage')}
            </Link>
          </p>
        </>
      ) : null}

      {/* The endpoint takes no account parameter, so a filtered list would
          otherwise invite reading this panel as "this account's" — the
          SummaryHeader caveat, in the same place and for the same reason. The
          list itself is NOT filtered client-side: that would fight both the cap
          and the server's ordering. */}
      {accountFiltered && phase === 'ready' ? (
        <p className={styles.caveat}>{t('upcoming.allAccountsNote')}</p>
      ) : null}
    </section>
  );
}
