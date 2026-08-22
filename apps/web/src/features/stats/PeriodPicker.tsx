import { useId } from 'react';

import { useLocale, useT } from '../../i18n/context';
import {
  PERIOD_UNITS,
  periodLabel,
  shiftPeriod,
  unitLabelKey,
  withUnit,
  type PeriodSelection,
} from './period';
import styles from './PeriodPicker.module.css';

interface PeriodPickerProps {
  selection: PeriodSelection;
  onChange: (selection: PeriodSelection) => void;
}

/**
 * The period control: a unit segmented control, a prev/next stepper for the three
 * calendar units, and two native date inputs for `custom`.
 *
 * It owns NO grammar of its own — every transition goes through the pure
 * `features/stats/period` module, and it writes only the selection back out (the
 * page puts it in the URL). The stepper is deliberately absent for `custom`: the
 * "same length immediately before" window is a server concept for the comparison
 * block, not a navigation gesture.
 */
export function PeriodPicker({ selection, onChange }: PeriodPickerProps) {
  const locale = useLocale();
  const t = useT();
  const fromId = useId();
  const toId = useId();

  return (
    <div className={styles.picker}>
      <div className={styles.units} role="group" aria-label={t('period.unitGroup')}>
        {PERIOD_UNITS.map((unit) => (
          <button
            key={unit}
            type="button"
            className={
              unit === selection.unit ? `${styles.unit} ${styles.unitActive}` : styles.unit
            }
            aria-pressed={unit === selection.unit}
            onClick={() => onChange(withUnit(selection, unit))}
          >
            {t(unitLabelKey(unit))}
          </button>
        ))}
      </div>

      {/* The literal discriminant, not a helper predicate: it is what narrows
          `selection` to the custom arm for the two date inputs below. */}
      {selection.unit !== 'custom' ? (
        <div className={styles.stepper}>
          <button
            type="button"
            className={styles.nav}
            aria-label={t('period.previous', { unit: t(unitLabelKey(selection.unit)) })}
            onClick={() => onChange(shiftPeriod(selection, -1))}
          >
            ‹
          </button>
          <span className={styles.label} aria-live="polite">
            {periodLabel(selection, locale)}
          </span>
          <button
            type="button"
            className={styles.nav}
            aria-label={t('period.next', { unit: t(unitLabelKey(selection.unit)) })}
            onClick={() => onChange(shiftPeriod(selection, 1))}
          >
            ›
          </button>
        </div>
      ) : (
        <div className={styles.range}>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor={fromId}>
              {t('period.from')}
            </label>
            <input
              id={fromId}
              type="date"
              className={styles.dateInput}
              value={selection.from}
              onChange={(event) =>
                onChange({ unit: 'custom', from: event.target.value, to: selection.to })
              }
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
              value={selection.to}
              onChange={(event) =>
                onChange({ unit: 'custom', from: selection.from, to: event.target.value })
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}
