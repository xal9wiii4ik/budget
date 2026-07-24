import { formatMonthLabel, shiftMonth } from '@budget/shared';

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
  const label = formatMonthLabel(month);
  return (
    <div className={styles.picker}>
      <button
        type="button"
        className={styles.nav}
        aria-label="Previous month"
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
        aria-label="Next month"
        onClick={() => onChange(shiftMonth(month, 1))}
      >
        ›
      </button>
    </div>
  );
}
