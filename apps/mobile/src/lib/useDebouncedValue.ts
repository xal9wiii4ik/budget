import { useEffect, useState } from 'react';

/**
 * Returns `value` after it has stayed unchanged for `delayMs`. Keeps the
 * transaction form's FX estimate off every keystroke (mobile-catchup-2) — rates
 * are daily rows, and a request per typed digit is pure waste on a phone network.
 *
 * COPY of web's src/lib/useDebouncedValue.ts: three lines of React with no
 * platform surface, kept local rather than shared because @budget/shared holds no
 * hooks at all.
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
