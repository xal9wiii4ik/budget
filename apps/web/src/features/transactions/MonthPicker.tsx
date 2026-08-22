import { formatMonthLabel, shiftMonth } from '@budget/shared';

import { useLocale, useT } from '../../i18n/context';
import styles from './MonthPicker.module.css';

interface MonthPickerProps {
  month: string; // "YYYY-MM"
  onChange: (month: string) => void;
}

/**
 * Prev/next month stepper (Q2 — deliberately NOT `<input type="month">`, whose
 * native picker/format is inconsistent across browsers). Shifts via the shared
 * `shiftMonth` (year rollover handled there) and shows the localized label.
 */
export function MonthPicker({ month, onChange }: MonthPickerProps) {
  const locale = useLocale();
  const t = useT();
  // The label follows the CHOSEN language, not the host's — that mismatch (an
  // English UI printing Russian months) is exactly what this scope fixes.
  const label = formatMonthLabel(month, { locale });
  return (
    <div className={styles.picker}>
      <button
        type="button"
        className={styles.nav}
        aria-label={t('monthPicker.previous')}
        onClick={() => onChange(shiftMonth(month, -1))}
      >
        ‹
      </button>
      <span className={styles.label} aria-live="polite">
        {label}
      </span>
      <button
        type="button"
        className={styles.nav}
        aria-label={t('monthPicker.next')}
        onClick={() => onChange(shiftMonth(month, 1))}
      >
        ›
      </button>
    </div>
  );
}
