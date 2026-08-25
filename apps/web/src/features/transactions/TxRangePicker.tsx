import { monthBounds } from '@budget/shared';
import { useEffect, useId, useRef, useState } from 'react';

import { useT } from '../../i18n/context';
import { MonthPicker } from './MonthPicker';
import { customRange, isValidRangeDate, type TxRangeMode } from './txFilters';
import styles from './TxRangePicker.module.css';

interface TxRangePickerProps {
  /** Which window the list is showing right now, read out of the URL. */
  mode: TxRangeMode;
  /**
   * The month the user is on — the one the stepper shows and the one "back to
   * the month" returns to. It stays in the URL while all-time or a custom period
   * is on, so leaving either mode returns to what was being read, not to today.
   */
  month: string;
  /** The ONE writer: the page turns the chosen mode into URL parameters. */
  onChange: (mode: TxRangeMode) => void;
}

/**
 * The list's range control: one toolbar slot, three mutually exclusive modes —
 * a month (stepper), all time, and a custom period (two dates).
 *
 * Only ONE of them is on screen at a time on purpose. A stepper that quietly did
 * nothing while another window was in force would be the worse lie, and the slot
 * has to survive a 375px toolbar.
 *
 * Nothing here is state: the mode comes from the URL, so a period survives F5 and
 * a shared link reproduces the exact window. The only local state is the custom
 * form's DRAFT, which becomes the URL when it is applied.
 */
export function TxRangePicker({ mode, month, onChange }: TxRangePickerProps) {
  const t = useT();
  // Whether the custom form is open. In `custom` mode it always is — the form IS
  // that mode's UI — so this only covers "opened it, has not applied yet".
  const [opening, setOpening] = useState(false);
  // Switching mode UNMOUNTS the control that was just activated, which would drop
  // a keyboard user at the top of the document. Each direction hands focus to the
  // control that takes its place: the first date field on the way in (`autoFocus`
  // at mount, so a page loaded straight into a period does NOT steal focus), this
  // button on the way back. The counter, not a boolean, is what keeps the effect
  // silent on mount and repeatable afterwards.
  const customButton = useRef<HTMLButtonElement>(null);
  const [returns, setReturns] = useState(0);
  useEffect(() => {
    if (returns > 0) customButton.current?.focus();
  }, [returns]);

  if (mode.kind === 'custom' || opening) {
    return (
      <TxCustomRange
        applied={mode.kind === 'custom' ? mode : null}
        month={month}
        autoFocus={opening}
        onApply={(range) => onChange({ kind: 'custom', ...range })}
        onCancel={() => {
          setOpening(false);
          setReturns((n) => n + 1);
          onChange({ kind: 'month', month });
        }}
      />
    );
  }

  return (
    <div className={styles.range}>
      {mode.kind === 'all' ? (
        <>
          <span className={styles.rangeLabel}>{t('tx.rangeAllTime')}</span>
          <button
            type="button"
            className={styles.rangeButton}
            onClick={() => onChange({ kind: 'month', month })}
          >
            {t('tx.rangeBackToMonth')}
          </button>
        </>
      ) : (
        <>
          <MonthPicker month={month} onChange={(next) => onChange({ kind: 'month', month: next })} />
          <button
            type="button"
            className={styles.rangeButton}
            onClick={() => onChange({ kind: 'all' })}
          >
            {t('tx.rangeShowAllTime')}
          </button>
        </>
      )}
      <button
        type="button"
        ref={customButton}
        className={styles.rangeButton}
        onClick={() => setOpening(true)}
      >
        {t('tx.rangeCustom')}
      </button>
    </div>
  );
}

interface TxCustomRangeProps {
  /** The period currently in the URL, or null while it is only being composed. */
  applied: { from: string; to: string } | null;
  month: string;
  /** True only when the form was just opened by the button — see the picker. */
  autoFocus: boolean;
  onApply: (range: { from: string; to: string }) => void;
  onCancel: () => void;
}

/**
 * The two-date form. The draft is local until it is APPLIED: an incomplete or
 * inverted pair never reaches the URL, so the list keeps showing the window it
 * was showing and the message sits on the field that is wrong — not in a banner
 * over a list that is still correct.
 */
function TxCustomRange({ applied, month, autoFocus, onApply, onCancel }: TxCustomRangeProps) {
  const t = useT();
  const fromId = useId();
  const toId = useId();
  const errorId = useId();
  // Opened from a month or from all-time: the month on screen is the window the
  // user is looking at, so it is the honest starting pair to narrow or widen.
  const [draft, setDraft] = useState(() => applied ?? monthBounds(month));
  // The message appears on SUBMIT, not per keystroke: a half-typed date is not a
  // mistake yet.
  const [submitted, setSubmitted] = useState(false);
  // Render-time resync (the TxSearchField pattern): the back button or a shared
  // link can move the applied period under an open form, and the inputs must not
  // keep showing a window the list no longer has.
  const appliedKey = applied === null ? '' : `${applied.from}:${applied.to}`;
  const [lastApplied, setLastApplied] = useState(appliedKey);
  if (appliedKey !== lastApplied) {
    setLastApplied(appliedKey);
    if (applied !== null) setDraft(applied);
    setSubmitted(false);
  }

  const valid = customRange(draft.from, draft.to);
  const incomplete = !isValidRangeDate(draft.from) || !isValidRangeDate(draft.to);
  const error =
    !submitted || valid !== null
      ? null
      : t(incomplete ? 'tx.rangeIncomplete' : 'tx.rangeInverted');

  return (
    <form
      className={styles.customForm}
      aria-label={t('tx.rangeCustom')}
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
        if (valid !== null) onApply(valid);
      }}
    >
      <div className={styles.customFields}>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={fromId}>
            {t('period.from')}
          </label>
          <input
            id={fromId}
            type="date"
            className={styles.dateInput}
            value={draft.from}
            // The trigger button unmounts as this form mounts, so without this
            // focus would fall to the document body. React applies it at MOUNT
            // only, which is exactly the guarantee the `autoFocus` prop needs.
            autoFocus={autoFocus}
            aria-invalid={error !== null}
            aria-describedby={error === null ? undefined : errorId}
            onChange={(event) => {
              setSubmitted(false);
              setDraft((prev) => ({ ...prev, from: event.target.value }));
            }}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={toId}>
            {t('period.to')}
          </label>
          <input
            id={toId}
            type="date"
            className={styles.dateInput}
            value={draft.to}
            aria-invalid={error !== null}
            aria-describedby={error === null ? undefined : errorId}
            onChange={(event) => {
              setSubmitted(false);
              setDraft((prev) => ({ ...prev, to: event.target.value }));
            }}
          />
        </div>
        <button type="submit" className={styles.applyButton}>
          {t('tx.rangeApply')}
        </button>
        <button type="button" className={styles.rangeButton} onClick={onCancel}>
          {t('tx.rangeBackToMonth')}
        </button>
      </div>
      {error === null ? null : (
        <p className={styles.error} id={errorId} role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
