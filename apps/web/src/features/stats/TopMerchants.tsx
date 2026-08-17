import { formatMoney } from '@budget/shared';

import { TOP_MERCHANTS_LIMIT, useStatsTopMerchants } from '../../data/stats';
import type { StatsPeriodQuery } from '../../data/queryKeys';
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
  const query = useStatsTopMerchants(period, TOP_MERCHANTS_LIMIT);

  return (
    <section className={styles.section} aria-labelledby="merchants-heading">
      <h2 id="merchants-heading" className={styles.heading}>
        Top merchants (spending)
      </h2>

      {query.isPending ? (
        <div className={styles.skeleton} aria-hidden="true" />
      ) : query.isError ? (
        <p className={styles.error} role="alert">
          Couldn&apos;t load top merchants.
          <button
            type="button"
            className={styles.retry}
            onClick={() => {
              void query.refetch();
            }}
          >
            Retry
          </button>
        </p>
      ) : (
        <div
          className={query.isPlaceholderData ? styles.dimmed : undefined}
          aria-busy={query.isPlaceholderData}
        >
          <UnconvertedNotice
            count={query.data.unconverted_count}
            scope="these merchant totals"
          />
          {query.data.items.length === 0 ? (
            <p className={styles.empty}>
              No merchant names yet — receipts and manual entries with a merchant show up
              here.
            </p>
          ) : (
            <ol className={styles.list}>
              {query.data.items.map((item) => (
                // The merchant string IS the server's grouping key and is unique
                // within the response — the one case where a non-uuid key is the
                // entity identity.
                <li key={item.merchant} className={styles.row}>
                  <span className={styles.name}>{item.merchant}</span>
                  <span className={styles.count}>
                    {item.tx_count === 1 ? '1 transaction' : `${item.tx_count} transactions`}
                  </span>
                  <span className={styles.amount}>
                    {formatMoney(item.total_minor, query.data.currency)}
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
