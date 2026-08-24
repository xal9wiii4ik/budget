import { useEffect, useRef, useState } from 'react';

import { useT } from '../../i18n/context';
import { adoptsUrlSearchText } from './txFilters';
import styles from './TxSearchField.module.css';

/**
 * How long the field stays quiet before the URL (and therefore the query key)
 * moves. Long enough that a typed word is ONE request, short enough that the
 * list feels live.
 */
const SEARCH_DEBOUNCE_MS = 350;

interface TxSearchFieldProps {
  /** The committed search text from the URL ('' when nothing is searched for). */
  value: string;
  /** Commits a trimmed value, or null to remove the parameter entirely. */
  onCommit: (next: string | null) => void;
}

/**
 * The transaction list's search box (search-and-drilldown S3).
 *
 * The URL is the single source of truth — `?q=` makes a search shareable and the
 * back button undo it — but only the DEBOUNCED value goes there: writing per
 * keystroke would mint a query-cache entry (and a request) per character.
 *
 * The typed text is local state, resynced from the URL during render rather than
 * in an effect. `adoptsUrlSearchText` decides whether an incoming `value` is a
 * real external change (back button, shared link, "clear") or merely this field's
 * own trimmed commit echoing back — adopting the latter would swallow a space the
 * user typed while the timer was running.
 */
export function TxSearchField({ value, onCommit }: TxSearchFieldProps) {
  const t = useT();
  const [text, setText] = useState(value);
  const [lastValue, setLastValue] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (value !== lastValue) {
    setLastValue(value);
    if (adoptsUrlSearchText(value, text)) setText(value);
  }

  // The only real external effect here: a pending timer must not fire after the
  // field is gone.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const cancelPending = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const commit = (next: string) => {
    cancelPending();
    const trimmed = next.trim();
    // Same trimming rule as the URL parser: an all-whitespace search is no search.
    onCommit(trimmed === '' ? null : trimmed);
  };

  const onChange = (next: string) => {
    setText(next);
    cancelPending();
    timer.current = setTimeout(() => commit(next), SEARCH_DEBOUNCE_MS);
  };

  return (
    // A real search form: Enter commits immediately instead of waiting out the
    // debounce, and never reloads the page.
    <form
      className={styles.form}
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        commit(text);
      }}
    >
      <input
        className={styles.input}
        type="search"
        value={text}
        aria-label={t('tx.searchLabel')}
        placeholder={t('tx.searchPlaceholder')}
        onChange={(event) => onChange(event.target.value)}
      />
      {text === '' ? null : (
        <button
          type="button"
          className={styles.clear}
          aria-label={t('tx.searchClear')}
          onClick={() => {
            setText('');
            commit('');
          }}
        >
          <span aria-hidden="true">×</span>
        </button>
      )}
    </form>
  );
}
