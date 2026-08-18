import type { ReactNode } from 'react';

import { NETWORK_MESSAGE } from '../lib/errors';
import styles from './QueryStateNotice.module.css';

interface QueryStateNoticeProps {
  /** The failing phase, from `queryPhase(query)`. Only these two render a notice. */
  phase: 'error' | 'unreachable';
  /** The screen's own "Couldn't load …" sentence, used for the `error` phase. */
  message: string;
  onRetry: () => void;
  /** Extra actions next to Retry (e.g. the stats "Reset to this month"). */
  children?: ReactNode;
  /** Section-sized padding/type, for a notice inside a card or a subsection. */
  compact?: boolean;
}

/**
 * The one failed-read affordance: an alert the screen reader announces, plus a
 * Retry that re-runs the query (WR-10 / R5).
 *
 * Both failing phases share it because they need the same thing from the user — a
 * retry — and differ only in what honestly happened. `unreachable` means the
 * request never left the browser (the retryer paused it), so the screen's own
 * "Couldn't load your goals." would be a claim about a response that does not
 * exist; that arm says so and is deliberately not overridable by callers.
 */
export function QueryStateNotice({
  phase,
  message,
  onRetry,
  children,
  compact = false,
}: QueryStateNoticeProps) {
  return (
    <p
      className={compact ? `${styles.notice} ${styles.compact}` : styles.notice}
      role="alert"
    >
      {phase === 'unreachable' ? NETWORK_MESSAGE : message}
      <button type="button" className={styles.retry} onClick={onRetry}>
        Retry
      </button>
      {children}
    </p>
  );
}
