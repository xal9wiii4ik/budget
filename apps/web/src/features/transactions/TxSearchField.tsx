import { useEffect, useRef, useState } from 'react';

import { Button } from '../../components/Button';
import { Input } from '../../components/Field';
import { useT } from '../../i18n/context';
import type { SimpleKey } from '../../i18n/t';
import { adoptsUrlSearchText } from './txFilters';
import type { TxSearchMode } from './txSearchMode';
import styles from './TxSearchField.module.css';

// A Record over the mode union — a third search mode fails typecheck here
// instead of quietly missing from the toggle (the `SORT_LABEL_KEYS` precedent in
// TxFiltersPopover). The ORDER is the array below: the shipped word search
// first, so the control reads left-to-right as "what you had" → "what is new".
const MODE_LABEL_KEYS: Record<TxSearchMode, SimpleKey> = {
  text: 'tx.searchModeText',
  meaning: 'tx.searchModeMeaning',
};
const MODE_OPTIONS: readonly TxSearchMode[] = ['text', 'meaning'];

/**
 * How long the field stays quiet before the URL (and therefore the query key)
 * moves. Long enough that a typed word is ONE request, short enough that the
 * list feels live. Applies to the DEBOUNCE mode only — see `commitOn`.
 */
const SEARCH_DEBOUNCE_MS = 350;

interface TxSearchFieldProps {
  /** The committed search text from the URL ('' when nothing is searched for). */
  value: string;
  /** Commits a trimmed value, or null to remove the parameter entirely. */
  onCommit: (next: string | null) => void;
  /**
   * WHEN a keystroke becomes a request (rag Web A).
   *
   * `debounce` is the shipped word search: a text `?q=` is an ILIKE the server
   * answers in a millisecond, so committing as you type is right.
   *
   * `submit` is the meaning search, and it is not a preference. Every commit
   * there is an embedding call plus one of the user's 30 searches a minute, so a
   * debounced sentence would spend five of them and can 429 mid-typing. In this
   * mode the timer is NEVER armed: Enter and the Search button are the only ways
   * to commit.
   */
  commitOn: 'debounce' | 'submit';
  /** Which search the screen is running — the toggle's state. */
  mode: TxSearchMode;
  onModeChange: (next: TxSearchMode) => void;
}

/**
 * The transaction list's search box (search-and-drilldown S3; the mode toggle
 * and `commitOn` since rag Web A).
 *
 * The URL is the single source of truth — `?q=` makes a search shareable and the
 * back button undo it, and `?mode=meaning` does the same for WHICH search —
 * but only a COMMITTED value goes there: in the debounce mode writing per
 * keystroke would mint a query-cache entry (and a request) per character, and in
 * the submit mode it would mint an embedding call per character.
 *
 * The typed text is local state, resynced from the URL during render rather than
 * in an effect. `adoptsUrlSearchText` decides whether an incoming `value` is a
 * real external change (back button, shared link, "clear") or merely this field's
 * own trimmed commit echoing back — adopting the latter would swallow a space the
 * user typed while the timer was running. Flipping the MODE does not touch it
 * either: the phrase survives the flip, which is the whole point of offering the
 * other search as a way out of an empty result.
 */
export function TxSearchField({
  value,
  onCommit,
  commitOn,
  mode,
  onModeChange,
}: TxSearchFieldProps) {
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
    // Same trimming rule as the URL parser: an all-whitespace search is no
    // search. In meaning mode this is also what makes 422 `SEARCH_QUERY_BLANK`
    // unreachable from the UI — a blank phrase never leaves the browser.
    onCommit(trimmed === '' ? null : trimmed);
  };

  const onChange = (next: string) => {
    setText(next);
    cancelPending();
    // The timer is armed in exactly one mode. Reusing the debounce path for the
    // meaning search is the failure this prop exists to prevent.
    if (commitOn === 'debounce') {
      timer.current = setTimeout(() => commit(next), SEARCH_DEBOUNCE_MS);
    }
  };

  return (
    <div className={styles.root}>
      {/* A real search form: Enter commits immediately instead of waiting out the
          debounce (and is the ONLY commit in submit mode), and never reloads the
          page. */}
      <form
        className={styles.form}
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          commit(text);
        }}
      >
        {/* Words, not an icon: the two options call different endpoints and give
            different answers, so the control has to say which is on. Segmented
            rather than a checkbox — `aria-pressed` states both options at once
            (the ThemeToggle precedent). */}
        <div className={styles.modes} role="group" aria-label={t('tx.searchModeLabel')}>
          {MODE_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              className={styles.mode}
              aria-pressed={mode === option}
              onClick={() => onModeChange(option)}
            >
              {t(MODE_LABEL_KEYS[option])}
            </button>
          ))}
        </div>

        {/* The input and its clear button are their own positioning context, so
            the × stays inside the FIELD's frame however many controls the form
            grows beside it. */}
        <span className={styles.field}>
          <Input
            className={styles.input}
            type="search"
            value={text}
            aria-label={t('tx.searchLabel')}
            placeholder={t(
              commitOn === 'submit' ? 'tx.searchMeaningPlaceholder' : 'tx.searchPlaceholder',
            )}
            onChange={(event) => onChange(event.target.value)}
          />
          {text === '' ? null : (
            <Button
              variant="ghost"
              size="sm"
              className={styles.clear}
              aria-label={t('tx.searchClear')}
              onClick={() => {
                setText('');
                commit('');
              }}
            >
              <span aria-hidden="true">×</span>
            </Button>
          )}
        </span>
        {/* A visible submit only where committing is an explicit act. On a touch
            screen there is no Enter key in sight, so without it the submit mode
            would have no discoverable way to run at all. */}
        {commitOn === 'submit' ? (
          <Button type="submit" className={styles.submit}>
            {t('tx.searchSubmit')}
          </Button>
        ) : null}
      </form>
      {/* The keyboard contract, said once and only where it differs from what the
          user is used to in this very field. */}
      {commitOn === 'submit' ? (
        <p className={styles.hint}>{t('tx.searchMeaningHint')}</p>
      ) : null}
    </div>
  );
}
