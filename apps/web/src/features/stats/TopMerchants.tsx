import { formatMoney } from '@budget/shared';

import { QueryStateNotice } from '../../components/QueryStateNotice';
import { TOP_MERCHANTS_LIMIT, useStatsTopMerchants } from '../../data/stats';
import type { StatsPeriodQuery } from '../../data/queryKeys';
import { useLocale, useT } from '../../i18n/context';
import { queryPhase } from '../../lib/queryPhase';
import { UnconvertedNotice } from './UnconvertedNotice';
import styles from './TopMerchants.module.css';

interface TopMerchantsProps {
  period: StatsPeriodQuery;
}

/**
 * The server's merchant ranking, rendered VERBATIM in its own order
 * (`total DESC, merchant ASC`) — no client re-sort, no re-total, no truncation
 * beyond the `limit` we asked for.
 *
 * The heading says "(spending)" because the endpoint is expense-only by design
 * (no `kind` param, server D2): without it, a missing salary source would read
 * as a bug. Amounts decode with `data.currency` — this response's own field.
 */
export function TopMerchants({ period }: TopMerchantsProps) {
  const locale = useLocale();
  const t = useT();
  const query = useStatsTopMerchants(period, TOP_MERCHANTS_LIMIT);
  const phase = queryPhase(query);

  return (
    <section className={styles.section} aria-labelledby="merchants-heading">
      <h2 id="merchants-heading" className={styles.heading}>
        {t('topMerchants.heading')}
      </h2>

      {phase === 'error' || phase === 'unreachable' ? (
        <QueryStateNotice
          phase={phase}
          message={t('topMerchants.loadFailed')}
          compact
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : !query.isSuccess ? (
        // 'loading': the failing phases returned above, so this is the in-flight
        // (or about-to-start) one. Narrowing on the query's own discriminant is
        // what keeps `query.data` typed below.
        <div className={styles.skeleton} aria-hidden="true" />
      ) : (
        <div
          className={query.isPlaceholderData ? styles.dimmed : undefined}
          aria-busy={query.isPlaceholderData}
        >
          <UnconvertedNotice
            count={query.data.unconverted_count}
            scope="merchantTotals"
          />
          {query.data.items.length === 0 ? (
            <p className={styles.empty}>{t('topMerchants.empty')}</p>
          ) : (
            <ol className={styles.list}>
              {query.data.items.map((item) => (
                // The merchant string IS the server's grouping key and is unique
                // within the response — the one case where a non-uuid key is the
                // entity identity.
                <li key={item.merchant} className={styles.row}>
                  <span className={styles.name}>{item.merchant}</span>
                  <span className={styles.count}>
                    {t('transactionCount', { count: item.tx_count })}
                  </span>
                  <span className={styles.amount}>
                    {formatMoney(item.total_minor, query.data.currency, { locale })}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
