import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { Modal } from '../../components/Modal';
import { useT } from '../../i18n/context';
import { TxRangePicker } from './TxRangePicker';
import type { TxRangeMode } from './txFilters';
import type { TxWindowPeriod } from './txWindow';
import styles from './TxWindowModal.module.css';

interface TxWindowModalProps {
  /** The thing the window is about — a category's or a deposit's own name. */
  title: string;
  period: TxWindowPeriod;
  /** The month the stepper shows (`useTxWindowPeriod`). */
  monthAnchor: string;
  onRangeChange: (next: TxRangeMode) => void;
  /**
   * An optional block between the period control and the rows. The category
   * window puts the SERVER's total for the period here; the deposit window has
   * none — its rows are transfers, which no server aggregate totals and which
   * this client may not add up itself (money arithmetic is the server's).
   */
  headline?: ReactNode;
  /**
   * Shown INSTEAD of the scroll region when the window has no rows. A string,
   * not a node, so the copy stays in the caller's own dictionary namespace: what
   * to try next differs per window.
   */
  emptyMessage?: string;
  /** The scroll region's accessible name — it is a focus stop of its own. */
  listLabel: string;
  /** Where "open all operations" goes: `txWindowHref(filter, period)`. */
  href: string;
  onClose: () => void;
  /** The rows. Rendered inside the scroll region. */
  children: ReactNode;
}

/**
 * The window a drill-down opens over the screen that listed the thing: a period,
 * optionally one server figure, the rows, and the way to the full screen.
 *
 * It is a WINDOW rather than a navigation because the question ("what happened
 * here?") is asked from a row and answered next to it: /transactions answers nine
 * other questions on the way and costs the context of the screen behind it.
 *
 * The layout rule is that only the ROWS scroll — the period control and the
 * headline above them and the link below stay put, so the answer remains on
 * screen while the evidence for it is scrolled through.
 *
 * What the shell deliberately does NOT own: the queries, the total and the copy.
 * Each window builds its own slice (`txWindowFilters`) and decides what may
 * honestly head it, which is why one of them has a headline and the other must
 * not grow one by default.
 */
export function TxWindowModal({
  title,
  period,
  monthAnchor,
  onRangeChange,
  headline,
  emptyMessage,
  listLabel,
  href,
  onClose,
  children,
}: TxWindowModalProps) {
  const t = useT();

  return (
    // No `isDirty`: there is no form in here, so all three close channels (Esc,
    // backdrop, ×) close it straight away.
    <Modal title={title} onClose={onClose}>
      <div className={styles.window}>
        <TxRangePicker
          mode={period}
          month={monthAnchor}
          // No all-time mode: see TxWindowPeriod.
          allowAllTime={false}
          onChange={onRangeChange}
        />

        {headline}

        {emptyMessage === undefined ? (
          // Focusable (`tabIndex={0}`) because its contents are NOT: the rows are
          // read-only in here, so without a stop of its own a keyboard-only user
          // could not scroll the region at all.
          <div className={styles.list} role="group" tabIndex={0} aria-label={listLabel}>
            {children}
          </div>
        ) : (
          <p className={styles.empty}>{emptyMessage}</p>
        )}

        {/* The full screen is still one click away — with the same filter and the
            same window, so nothing has to be set up again there. */}
        <Link className={styles.openAll} to={href}>
          {t('txWindow.openAll')}
        </Link>
      </div>
    </Modal>
  );
}
