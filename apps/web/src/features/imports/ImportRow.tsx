import { formatApiDate, formatMoney } from '@budget/shared';
import { memo, useState } from 'react';
import type { components } from '@budget/api-client';

import type {
  StatementRowDecision,
  StatementRowRead,
} from '../../data/imports';
import { useLocale, useT } from '../../i18n/context';
import { primaryAmount } from '../transactions/rowDisplay';
import styles from './ImportRowList.module.css';

type CategoryRead = components['schemas']['CategoryRead'];

interface ImportRowProps {
  row: StatementRowRead;
  /** id -> category, from the archived-inclusive cache (the C5 pattern). */
  categoriesById: Map<string, CategoryRead>;
  /** True while THIS row's own PATCH is in flight. */
  pending: boolean;
  /** The message of this row's failed PATCH, if it is this row that failed. */
  errorMessage: string | null;
  readOnly: boolean;
  onDecide: (rowId: string, decision: StatementRowDecision) => void;
  onPickCategory: (row: StatementRowRead) => void;
}

const MATCH_KEY = {
  exact: 'imports.badgeExact',
  similar: 'imports.badgeSimilar',
  new: 'imports.badgeNew',
} as const satisfies Record<StatementRowRead['match_status'], string>;

const SECTION_KEY = {
  contract: 'imports.badgeSectionContract',
  card: 'imports.badgeSectionCard',
} as const satisfies Record<StatementRowRead['section'], string>;

const SUGGESTION_KEY = {
  merchant: 'imports.suggestedByMerchant',
  bank_category: 'imports.suggestedByBankCategory',
} as const satisfies Record<NonNullable<StatementRowRead['suggestion_source']>, string>;

const DECISIONS: readonly { value: StatementRowDecision; key: 'imports.decisionImport' | 'imports.decisionSkip' | 'imports.decisionReplaceOwn' }[] = [
  { value: 'import', key: 'imports.decisionImport' },
  { value: 'skip', key: 'imports.decisionSkip' },
  { value: 'replace_own', key: 'imports.decisionReplaceOwn' },
];

/**
 * One parsed line of the statement, with the decision that will be taken on it.
 *
 * Money is rendered by the SHARED pair module (`primaryAmount`), because the row
 * carries it in the transaction's own shape (§10.1): a purchase made in another
 * currency leads with what was SPENT and shows what the account was CHARGED
 * underneath — the same two lines the transactions list shows, from the same
 * code. Nothing here adds, converts or rounds: the bank's own rate is already
 * baked into the charged figure, and `fee_minor` is a SEPARATE server figure
 * shown beside them, never folded into the amount.
 *
 * `replace_own` is offered only when the server found a record to replace: the
 * button would otherwise be a guaranteed 422 (DECISION_NEEDS_MATCH) dressed as
 * an option.
 *
 * Memoized: a statement can hold a thousand of these, and a decision click or a
 * page load must not re-render all of them. The cache update keeps untouched
 * rows' identity (data/imports.ts), which is what makes the memo effective.
 */
export const ImportRow = memo(function ImportRow({
  row,
  categoriesById,
  pending,
  errorMessage,
  readOnly,
  onDecide,
  onPickCategory,
}: ImportRowProps) {
  const t = useT();
  const locale = useLocale();
  const [showCandidates, setShowCandidates] = useState(false);

  const amounts = primaryAmount(row, undefined);
  const isExpense = row.kind === 'expense';
  const sign = (minor: number) => (isExpense ? -minor : minor);
  // The server SEEDS `category_id` with its suggestion and leaves
  // `category_user_set` false (routers/statement_imports.py `_build_rows`), so
  // "has a category" and "the user chose it" are two different facts and the row
  // shows both: the name, and — while it is still only a guess — where the guess
  // came from. A category id the loaded index does not know is named as unknown
  // rather than silently rendered as "no category" (the rowDisplay precedent).
  const category = row.category_id === null ? undefined : categoriesById.get(row.category_id);
  const categoryLabel =
    category !== undefined
      ? category.name
      : row.category_id === null
        ? t('imports.categoryNone')
        : t('common.unknownCategory');
  const suggestionSource =
    !row.category_user_set && row.category_id !== null ? row.suggestion_source : null;

  return (
    <article
      className={`${styles.row} ${styles[`decision_${row.decision}`]}`}
      aria-busy={pending || undefined}
    >
      <div className={styles.head}>
        <span className={styles.date}>
          {formatApiDate(row.txn_date, { locale })}
          {/* NULL means "the file said 00:00:00", which is unknown, not midnight
              — so nothing is printed rather than a time nobody recorded. */}
          {row.txn_time === null ? '' : ` ${row.txn_time.slice(0, 5)}`}
        </span>
        <span className={styles.badges}>
          <span className={`${styles.badge} ${styles[`match_${row.match_status}`]}`}>
            {t(MATCH_KEY[row.match_status])}
          </span>
          <span className={styles.badge}>{t(SECTION_KEY[row.section])}</span>
          {row.possible_transfer ? (
            <span className={`${styles.badge} ${styles.badgeTransfer}`}>
              {t('imports.badgeTransfer')}
            </span>
          ) : null}
        </span>
      </div>

      <div className={styles.body}>
        <div className={styles.details}>
          <span className={styles.description}>{row.description}</span>
          {row.bank_category === null ? null : (
            <span className={styles.bankCategory}>{row.bank_category}</span>
          )}
          {row.possible_transfer ? (
            <span className={styles.transferHint}>{t('imports.transferHint')}</span>
          ) : null}
        </div>

        <div className={styles.amountCell}>
          <span className={`${styles.amount} ${isExpense ? styles.expense : styles.income}`}>
            {formatMoney(sign(amounts.primary.minor), amounts.primary.currency, { locale })}
          </span>
          {/* The charged line is the only one that reconciles with the account,
              so it is plain visible text, never a hover. */}
          {amounts.secondary ? (
            <span className={styles.charged}>
              {formatMoney(sign(amounts.secondary.minor), amounts.secondary.currency, {
                locale,
              })}
            </span>
          ) : null}
          {/* `!== 0`, and the sign is the FILE's: a fee is negative, a money-back
              positive, and an empty cell is a real zero worth not showing. */}
          {row.fee_minor !== 0 ? (
            <span className={styles.fee}>
              {t('imports.fee', {
                amount: formatMoney(row.fee_minor, row.currency, { locale }),
              })}
            </span>
          ) : null}
        </div>
      </div>

      <div className={styles.controls}>
        {/* The group and the category button name the LINE they belong to: a
            thousand buttons all called "Skip" tell a screen-reader user nothing
            about which operation they are on. */}
        <div
          className={styles.decisions}
          role="group"
          aria-label={t('imports.decisionAria', { description: row.description })}
        >
          {DECISIONS.map((option) => {
            if (option.value === 'replace_own' && row.matched_tx_id === null) return null;
            const active = row.decision === option.value;
            return (
              <button
                key={option.value}
                type="button"
                className={active ? `${styles.decision} ${styles.decisionActive}` : styles.decision}
                aria-pressed={active}
                disabled={readOnly || pending}
                onClick={() => onDecide(row.id, option.value)}
              >
                {t(option.key)}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          className={styles.category}
          aria-label={t('imports.categoryAria', { description: row.description })}
          disabled={readOnly || pending}
          onClick={() => onPickCategory(row)}
        >
          {categoryLabel}
        </button>
        {/* Where a suggestion came from, said out loud: a category the user has
            not confirmed is the server's guess, and the guess names its source. */}
        {suggestionSource === null ? null : (
          <span className={styles.suggestionSource}>{t(SUGGESTION_KEY[suggestionSource])}</span>
        )}

        {row.candidates.length > 0 ? (
          <button
            type="button"
            className={styles.candidatesToggle}
            aria-expanded={showCandidates}
            onClick={() => setShowCandidates((open) => !open)}
          >
            {showCandidates
              ? t('imports.hideMine')
              : t('imports.showMine', { count: row.candidates.length })}
          </button>
        ) : null}
      </div>

      {showCandidates && row.candidates.length > 0 ? (
        <ul className={styles.candidates}>
          {row.candidates.map((candidate) => (
            <li key={candidate.id} className={styles.candidate}>
              <span className={styles.candidateDate}>
                {formatApiDate(candidate.occurred_at, { locale })}
              </span>
              <span className={styles.candidateName}>
                {candidate.merchant ?? candidate.note ?? t('imports.candidateNoName')}
              </span>
              <span className={styles.candidateAmount}>
                {formatMoney(
                  candidate.kind === 'expense' ? -candidate.amount_minor : candidate.amount_minor,
                  candidate.currency,
                  { locale },
                )}
              </span>
              {candidate.id === row.matched_tx_id ? (
                <span className={styles.candidateBest}>{t('imports.candidateBest')}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {errorMessage === null ? null : (
        <p className={styles.rowError} role="alert">
          {errorMessage}
        </p>
      )}
    </article>
  );
});
