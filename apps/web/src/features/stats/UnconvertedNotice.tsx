import styles from './UnconvertedNotice.module.css';

interface UnconvertedNoticeProps {
  count: number;
  /** What the excluded rows are missing from, e.g. "these totals". */
  scope: string;
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
  if (count <= 0) return null;
  return (
    <p className={styles.notice} role="status">
      {count === 1
        ? `1 transaction has no exchange rate and is not included in ${scope}.`
        : `${count} transactions have no exchange rate and are not included in ${scope}.`}
    </p>
  );
}
