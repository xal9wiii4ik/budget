import type { ChangeEvent } from 'react';
import type { UseFormRegisterReturn } from 'react-hook-form';

import { currencyOptions } from './currencyOptions';
import styles from './CurrencySelect.module.css';

interface CurrencySelectProps {
  id: string;
  registration: UseFormRegisterReturn; // register('currency')
  // Runs AFTER the RHF handler has recorded the new value, for side effects a
  // currency change implies (the transaction form resets its converted field).
  onChange?: (event: ChangeEvent<HTMLSelectElement>) => void;
  extraCurrency?: string | null;
  disabled?: boolean;
  className?: string;
}

/** Dumb <select> over the supported currency set. Labelled by the caller. */
export function CurrencySelect({
  id,
  registration,
  onChange,
  extraCurrency,
  disabled,
  className,
}: CurrencySelectProps) {
  return (
    <select
      {...registration}
      id={id}
      className={className ?? styles.select}
      disabled={disabled}
      onChange={(event) => {
        void registration.onChange(event);
        onChange?.(event);
      }}
    >
      {currencyOptions(extraCurrency).map((code) => (
        <option key={code} value={code}>
          {code}
        </option>
      ))}
    </select>
  );
}
