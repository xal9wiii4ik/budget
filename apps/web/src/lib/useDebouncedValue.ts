import { useEffect, useState } from 'react';

/**
 * Returns `value` after it has stayed unchanged for `delayMs`. Used to keep the
 * transaction form's FX preview off every keystroke (3.2 WD-3).
 *
 * `value` must be a primitive (or a referentially stable object): the timer is
 * keyed on identity, so a fresh object literal per render would restart the
 * window forever and the debounced value would never settle. Callers debounce
 * the individual form strings for exactly this reason.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
