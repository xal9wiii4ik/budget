import { useEffect, useRef, useState } from 'react';

import { useT } from '../../i18n/context';

import { OTHER_CURRENCY_OPTION, spendCurrencyView } from './spendCurrencyView';
import styles from './SpendCurrencyPicker.module.css';

interface SpendCurrencyPickerProps {
  /** Owned by the caller so its visible <label htmlFor> points at the select. */
  id: string;
  /** The code the form currently holds (may be half-typed in "other" mode). */
  value: string;
  /** Codes to offer, in order — `spendCurrencyOptions` from originalPair.ts. */
  suggestions: readonly string[];
  /** The new code, already the user's final say for this keystroke/pick. */
  onChange: (code: string) => void;
}

/**
 * The currency the money was spent in: a <select> over the currencies this user
 * deals in, plus "other currency…" which reveals a three-letter code field.
 *
 * It used to be a bare `<input list=…>`: any code was typable, but it read as a
 * tiny text box and the complaint was literally "I thought the currency could
 * not be changed". A select shows it is a choice at a glance; the escape hatch
 * keeps the reason the datalist existed intact — the list is a SUGGESTION, not a
 * whitelist (D7). We store six FX pairs, validation is format-only on both
 * sides, and a JPY receipt must not become unrepresentable because JPY is not
 * one of the user's account currencies.
 */
export function SpendCurrencyPicker({
  id,
  value,
  suggestions,
  onChange,
}: SpendCurrencyPickerProps) {
  const t = useT();
  // The ONE thing the control remembers: "the user asked for the free-text
  // field". Everything else on screen is derived from it and the form's value.
  const [otherRequested, setOtherRequested] = useState(false);
  const view = spendCurrencyView(suggestions, value, otherRequested);

  const otherRef = useRef<HTMLInputElement>(null);
  // A real DOM effect, and the only one here: the field it focuses does not
  // exist yet while the <select>'s change handler runs. Selecting the text means
  // the first keystroke replaces the code that was carried over instead of
  // appending to it. Gated on the REQUEST, so opening a form on an exotic
  // currency (which also shows this field) never steals focus from the top.
  useEffect(() => {
    if (!otherRequested) return;
    otherRef.current?.select();
    otherRef.current?.focus();
  }, [otherRequested]);

  return (
    <div className={styles.control}>
      <select
        id={id}
        className={styles.select}
        value={view.selectValue}
        onChange={(event) => {
          if (event.target.value === OTHER_CURRENCY_OPTION) {
            // No value change: the code stays what it was until the user types
            // one, so picking "other" can never write a half-currency into the
            // form (and never flips the amount fields on its own).
            setOtherRequested(true);
            return;
          }
          setOtherRequested(false);
          onChange(event.target.value);
        }}
      >
        {view.options.map((code) => (
          <option key={code} value={code}>
            {code}
          </option>
        ))}
        <option value={OTHER_CURRENCY_OPTION}>{t('txForm.spendCurrencyOther')}</option>
      </select>
      {view.showOther ? (
        <input
          ref={otherRef}
          id={`${id}-other`}
          className={styles.code}
          maxLength={3}
          size={3}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="JPY"
          aria-label={t('txForm.spendCurrencyOtherLabel')}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : null}
    </div>
  );
}
