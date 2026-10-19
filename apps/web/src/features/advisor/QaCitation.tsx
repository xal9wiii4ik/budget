import { formatApiDate, formatMoney } from '@budget/shared';
import type { components } from '@budget/api-client';
import { Link } from 'react-router';

// ASK-2: a citation is literally a `TransactionSearchHit`, the same schema the
// search route returns — so this mini view and a search row are typed off ONE
// generated type (data/txSearch.ts owns it).
import type { TransactionSearchHit } from '../../data/txSearch';
import { useLocale, useT } from '../../i18n/context';
import { primaryAmount, rowTitle } from '../transactions/rowDisplay';
import { qaCitationHref } from './qaCitationHref';
import styles from './AdvisorQa.module.css';

type CategoryRead = components['schemas']['CategoryRead'];

interface QaCitationProps {
  hit: TransactionSearchHit;
  /** Archived-inclusive index, for the row's title and its icon. */
  categoryIndex: Map<string, CategoryRead>;
  /**
   * The answer's `total.currency` — the profile base currency (ASK-3). It is
   * what decides whether the muted "≈" equivalent is honest to show at all
   * (`baseEquivalent`), which is why it comes from the SERVER's own total rather
   * than from a second read.
   */
  baseCurrency: string;
}

/**
 * One operation the answer leans on, as a link to that operation.
 *
 * A mini view, not a row widget: date, name, category, amount — the same pure
 * `rowDisplay` helpers the list uses (the `ReconciliationItem` precedent), so a
 * foreign purchase shows what was SPENT over what the account was charged here
 * too. No UUID is ever on screen, and no figure is computed: both lines are the
 * row's own stored amounts.
 *
 * The whole thing is ONE `<Link>` (`qaCitationHref`), so a keyboard walks the
 * citation list as a list of links and the browser's own back button returns to
 * the answer — which is the only thing that keeps the answer readable after a
 * detour, given that v1 keeps no history.
 */
export function QaCitation({ hit, categoryIndex, baseCurrency }: QaCitationProps) {
  const locale = useLocale();
  const t = useT();

  const { transaction } = hit;
  const category =
    transaction.category_id === null ? undefined : categoryIndex.get(transaction.category_id);
  const name = rowTitle(transaction, category, {
    uncategorized: t('common.uncategorized'),
    unknownCategory: t('common.unknownCategory'),
  });
  const amounts = primaryAmount(transaction, baseCurrency);
  // The sign is a direction marker applied by `formatMoney`, not arithmetic: the
  // stored magnitude is rendered with a leading minus for an expense, exactly as
  // the transaction list does.
  const isExpense = transaction.kind === 'expense';
  const sign = (minor: number) => (isExpense ? -minor : minor);
  const date = formatApiDate(transaction.occurred_at, { locale });

  return (
    <Link
      className={styles.citation}
      to={qaCitationHref(transaction)}
      // The link text is a date and a shop name; what it DOES needs saying.
      aria-label={t('advisor.qaOpenRow', { date })}
    >
      <span className={styles.citationIcon} aria-hidden="true">
        {category?.icon ?? '•'}
      </span>
      <span className={styles.citationDetails}>
        <span className={styles.citationName}>{name}</span>
        <span className={styles.citationDate}>{date}</span>
      </span>
      <span className={styles.citationAmounts}>
        <span
          className={`${styles.citationAmount} ${
            isExpense ? styles.expense : styles.income
          } tnum`}
        >
          {formatMoney(sign(amounts.primary.minor), amounts.primary.currency, { locale })}
        </span>
        {/* Plain text, never a hover affordance: on a foreign purchase this is
            the only line that reconciles with the total below the answer. */}
        {amounts.secondary ? (
          <span className={`${styles.citationSecondary} tnum`}>
            {amounts.secondary.kind === 'base' ? '≈ ' : ''}
            {formatMoney(sign(amounts.secondary.minor), amounts.secondary.currency, { locale })}
          </span>
        ) : null}
      </span>
    </Link>
  );
}
