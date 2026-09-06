import { useT } from '../../i18n/context';
import styles from './UnconvertedNotice.module.css';

/**
 * WHICH aggregate the excluded rows are missing from. A SCOPE, not a phrase:
 * the sentence sits in a different place in each language, so the whole
 * sentence is one dictionary entry per scope rather than a template with an
 * interpolated noun.
 */
type UnconvertedScope = 'totals' | 'spentAmounts' | 'merchantTotals' | 'month';

const SCOPE_KEY = {
  totals: 'unconverted.totals',
  spentAmounts: 'unconverted.spentAmounts',
  merchantTotals: 'unconverted.merchantTotals',
  // For a place whose figure is the whole month's (the category window): the
  // sentence must not claim the count belongs to what is on screen.
  month: 'unconverted.month',
} as const;

interface UnconvertedNoticeProps {
  count: number;
  scope: UnconvertedScope;
}

/**
 * The honesty banner (WS-5), same shape and wording as the shipped
 * `SummaryHeader` one: transactions with no exchange rate are EXCLUDED from the
 * server's totals, and that exclusion is disclosed rather than silently absorbed.
 *
 * `role="status"`, never `role="alert"` — the period is still usable, it is just
 * incomplete. Renders nothing at zero so callers can mount it unconditionally.
 */
export function UnconvertedNotice({ count, scope }: UnconvertedNoticeProps) {
  const t = useT();
  if (count <= 0) return null;
  return (
    <p className={styles.notice} role="status">
      {t(SCOPE_KEY[scope], { count })}
    </p>
  );
}
