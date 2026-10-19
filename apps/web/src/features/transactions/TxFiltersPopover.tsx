import type { components } from '@budget/api-client';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Select } from '../../components/Field';
import { sortForDisplay } from '../../data/categoryLookup';
import type { TxSort } from '../../data/queryKeys';
import { useLocale, useT } from '../../i18n/context';
import type { SimpleKey } from '../../i18n/t';
import { countryOptions } from './countryOptions';
import { DEFAULT_TX_SORT, TX_SORTS, toTxSort } from './txFilters';
import styles from './TxFiltersPopover.module.css';

type CategoryRead = components['schemas']['CategoryRead'];

// A Record over the CONTRACT's sort union: the day the server grows a fifth
// order, this object fails typecheck instead of the picker quietly missing it.
const SORT_LABEL_KEYS: Record<TxSort, SimpleKey> = {
  date_desc: 'tx.sortDateDesc',
  date_asc: 'tx.sortDateAsc',
  amount_desc: 'tx.sortAmountDesc',
  amount_asc: 'tx.sortAmountAsc',
};

interface TxFiltersPopoverProps {
  /** The archived-INCLUSIVE category list (the one cache, already translated). */
  categories: CategoryRead[];
  categoryId: string | null;
  country: string | null;
  /** null = the default order; the select still shows it as selected. */
  sort: TxSort | null;
  /**
   * Whether the screen is searching BY MEANING (rag Web A). The sort select is
   * then HIDDEN with the reason as text, never shown disabled with no
   * explanation: `GET /transactions/search` has no `sort` parameter at all
   * because its results are ranked by closeness, so there is nothing to disable
   * — the control simply does not apply to this list.
   *
   * `?sort=` stays in the URL meanwhile and applies again on the way back to the
   * word search: hiding a control is not the same as discarding the choice.
   */
  meaningMode: boolean;
  /** How many of these three controls are set — the button's badge. */
  activeCount: number;
  onCategoryChange: (next: string | null) => void;
  onCountryChange: (next: string | null) => void;
  onSortChange: (next: TxSort | null) => void;
  onReset: () => void;
}

/**
 * The compact "Filters" popover on /transactions (search-and-drilldown S3):
 * category, country and sort order, none of which earns permanent toolbar space.
 *
 * Every control writes a URL PARAMETER, not component state — the category one
 * writes the very `?category=` the /categories drill-down does (ONE mechanism,
 * not a second), so opening a drilled-down link shows the filter already set here
 * and the chip above the list keeps clearing it.
 *
 * Not a modal: it does not trap focus (Tab simply walks into it and out again),
 * but it does close on Escape and on a click outside, and Escape returns focus to
 * the button that opened it.
 */
export function TxFiltersPopover({
  categories,
  categoryId,
  country,
  sort,
  meaningMode,
  activeCount,
  onCategoryChange,
  onCountryChange,
  onSortChange,
  onReset,
}: TxFiltersPopoverProps) {
  const locale = useLocale();
  const t = useT();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // A real external effect: a document-level listener that must exist only while
  // the panel is open and must be removed with it.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // Collated in the CHOSEN language over the already-translated names, and split
  // by kind exactly like the transaction form's picker.
  const sorted = useMemo(() => sortForDisplay(categories, locale), [categories, locale]);
  const expenseOptions = sorted.filter((category) => category.kind === 'expense');
  const incomeOptions = sorted.filter((category) => category.kind === 'income');
  // A filtered id the category cache does not know (archived away in another tab,
  // a hand-typed `?category=`) still needs an option of its own: a <select> whose
  // value matches nothing silently displays the first option, i.e. claims a filter
  // that is not applied.
  const categoryMissing =
    categoryId !== null && !categories.some((category) => category.id === categoryId);

  const countries = useMemo(() => countryOptions(locale, country), [locale, country]);

  return (
    <div
      className={styles.root}
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return;
        setOpen(false);
        buttonRef.current?.focus();
      }}
    >
      <Button
        ref={buttonRef}
        className={activeCount > 0 ? styles.buttonActive : undefined}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((previous) => !previous)}
      >
        {t('tx.filters')}
        {activeCount > 0 ? (
          // The count is also spelled out for a screen reader: a bare "2" next to
          // "Filters" is not a sentence.
          <Badge tone="accent">
            <span aria-hidden="true">{activeCount}</span>
            <span className={styles.srOnly}>{t('tx.filtersActive', { count: activeCount })}</span>
          </Badge>
        ) : null}
      </Button>

      {open ? (
        <div className={styles.panel} id={panelId}>
          <label className={styles.field}>
            <span className={styles.label}>{t('tx.filterCategoryLabel')}</span>
            <Select
              value={categoryId ?? ''}
              onChange={(event) =>
                onCategoryChange(event.target.value === '' ? null : event.target.value)
              }
            >
              <option value="">{t('tx.allCategories')}</option>
              {/* An empty group would render as a bare heading with nothing under
                  it — while the categories query is still loading, that is every
                  group. */}
              {expenseOptions.length === 0 ? null : (
                <optgroup label={t('common.expense')}>
                  {expenseOptions.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                      {category.archived ? ` ${t('common.archivedParens')}` : ''}
                    </option>
                  ))}
                </optgroup>
              )}
              {incomeOptions.length === 0 ? null : (
                <optgroup label={t('common.income')}>
                  {incomeOptions.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                      {category.archived ? ` ${t('common.archivedParens')}` : ''}
                    </option>
                  ))}
                </optgroup>
              )}
              {categoryMissing ? (
                <option value={categoryId}>{t('common.unknownCategory')}</option>
              ) : null}
            </Select>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>{t('tx.filterCountryLabel')}</span>
            <Select
              value={country ?? ''}
              onChange={(event) =>
                onCountryChange(event.target.value === '' ? null : event.target.value)
              }
            >
              <option value="">{t('tx.allCountries')}</option>
              {countries.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.label}
                </option>
              ))}
            </Select>
          </label>

          {meaningMode ? (
            // The reason, as TEXT. A disabled <select> with no sentence next to
            // it is the shape of a bug; this says what happened to the control
            // and that the choice is not lost.
            <p className={styles.note}>{t('tx.sortNotInMeaning')}</p>
          ) : (
            <label className={styles.field}>
              <span className={styles.label}>{t('tx.sortLabel')}</span>
              <Select
                value={sort ?? DEFAULT_TX_SORT}
                // The default order travels as NO parameter (toTxSort maps it to
                // null), so picking it back returns to exactly the URL — and the
                // cache key — of an untouched list.
                onChange={(event) => onSortChange(toTxSort(event.target.value))}
              >
                {TX_SORTS.map((value) => (
                  <option key={value} value={value}>
                    {t(SORT_LABEL_KEYS[value])}
                  </option>
                ))}
              </Select>
            </label>
          )}

          {activeCount > 0 ? (
            <button type="button" className={styles.reset} onClick={onReset}>
              {t('tx.filtersReset')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
