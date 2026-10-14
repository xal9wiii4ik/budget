import { formatApiDate, formatMoney } from '@budget/shared';
import { memo, useState } from 'react';
import type { components } from '@budget/api-client';

import type {
  StatementRowDecision,
  StatementRowRead,
} from '../../data/imports';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { useLocale, useT } from '../../i18n/context';
import { primaryAmount } from '../transactions/rowDisplay';
import { translateBankText } from './bankPhrases';
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

// The badge TONE, beside the label it goes with: "already yours" is settled,
// "looks like one of yours" is the line to look at, "new" is merely information.
const MATCH_TONE = {
  exact: 'success',
  similar: 'warning',
  new: 'accent',
} as const satisfies Record<StatementRowRead['match_status'], 'success' | 'warning' | 'accent'>;

const SECTION_KEY = {
  contract: 'imports.badgeSectionContract',
  card: 'imports.badgeSectionCard',
} as const satisfies Record<StatementRowRead['section'], string>;

const SUGGESTION_KEY = {
  merchant: 'imports.suggestedByMerchant',
  bank_category: 'imports.suggestedByBankCategory',
  // ai-layer W1. The `satisfies` keeps this map exhaustive, which is what makes
  // the widened `llm` arm a compile-time obligation rather than a silent gap.
  llm: 'imports.suggestedByAi',
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
 * The bank's OWN words (the Operation column and the opening of the description)
 * go through `translateBankText` (credo-import) — a Georgian statement is
 * unreadable otherwise. Everything the bank wrote about the operation itself (the
 * merchant, the amounts, the dates) is copied through untouched, and a phrase the
 * dictionary does not know keeps its original text AND says so with a badge.
 *
 * When the parser isolated a `merchant`, THAT is the line's headline and the name
 * the buttons say, because it is literally the name the created transaction will
 * carry (the server falls back to the description when it is null). A row without
 * one — every Priorbank line — looks exactly as it did before.
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
  // Recomputed on every render rather than memoized: it is two `startsWith`
  // passes over a short string, and the language it depends on is `t` itself.
  const description = translateBankText(row.description, t);
  const bankCategory =
    row.bank_category === null ? null : translateBankText(row.bank_category, t);
  // One badge for the row, whichever of the two lines has the gap: the point is
  // "this build has no copy for what this line says", not which field it was in.
  const untranslated = description.untranslated || (bankCategory?.untranslated ?? false);
  // The name the operation will be CREATED under, when the parser could isolate
  // one (`merchant`; null on every Priorbank row, where nothing changes). It is
  // shown as the line's headline and is deliberately NOT run through
  // `translateBankText`: a shop name is the user's data, and passing it through
  // the phrase tables could only ever mislabel it as an untranslated gap the
  // dictionary can never close.
  const merchant = row.merchant === null || row.merchant.trim() === '' ? null : row.merchant;
  // Credo leaves some descriptions EMPTY, and "What to do with: " names nothing.
  // With a merchant the line IS that merchant — the same name the transaction
  // will carry, so the buttons say it instead of the long description. The bank's
  // operation type is the next best name; only a row with none of the three falls
  // back to the "no name" label.
  const rowLabel =
    [merchant ?? '', description.text, bankCategory?.text ?? ''].find(
      (value) => value.trim() !== '',
    ) ?? t('imports.candidateNoName');
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
  // The model's own sentence about THIS line, shown only while its guess is
  // still a guess: once the user has picked a category the reason is history
  // about a value nobody is being asked to check any more. It is server text
  // and is rendered VERBATIM — not through `translateBankText`, not through the
  // dictionary. The advisor-answer rule: a model's words are not our copy.
  const reasonText = row.ai_reason?.trim() ?? '';
  const aiReason = suggestionSource === 'llm' && reasonText !== '' ? reasonText : null;
  // The server's decision, not a threshold recomputed here. A badge rather than
  // a tooltip: how many of these a statement carries is the whole point.
  const needsReview = row.needs_review;

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
          <Badge tone={MATCH_TONE[row.match_status]}>{t(MATCH_KEY[row.match_status])}</Badge>
          <Badge>{t(SECTION_KEY[row.section])}</Badge>
          {row.possible_transfer ? <Badge tone="accent">{t('imports.badgeTransfer')}</Badge> : null}
          {/* Deliberately in the badge strip and not behind a hover: how often
              this appears is what decides whether the phrase dictionary has to
              move into the database (.tasks/credo-import/task.md). */}
          {untranslated ? (
            <Badge tone="danger" className={styles.badgeUntranslated}>
              {t('imports.badgeUntranslated')}
            </Badge>
          ) : null}
          {/* Also in the strip and never behind a hover (the `badgeUntranslated`
              precedent): this is the ASK on the row — the model was not sure,
              and the number of such rows is what the chip above counts. Shown on
              a read-only session too: it is the record of what happened. */}
          {needsReview ? (
            <Badge tone="warning" className={styles.badgeNeedsReview}>
              {t('imports.badgeNeedsReview')}
            </Badge>
          ) : null}
        </span>
      </div>

      <div className={styles.body}>
        <div className={styles.details}>
          {/* The headline of the row is what will be WRITTEN: this screen exists
              to be looked at before the write, so the future transaction's name
              leads. The description stays visible underneath — it carries the
              "spent" pair and the bank's date, which are facts, not a name. A row
              with no merchant (every Priorbank line) renders exactly as before. */}
          {merchant === null ? null : <span className={styles.merchant}>{merchant}</span>}
          <span
            className={
              merchant === null ? styles.description : `${styles.description} ${styles.demoted}`
            }
          >
            {description.text}
          </span>
          {bankCategory === null ? null : (
            <span className={styles.bankCategory}>{bankCategory.text}</span>
          )}
          {row.possible_transfer ? (
            <span className={styles.transferHint}>{t('imports.transferHint')}</span>
          ) : null}
        </div>

        <div className={styles.amountCell}>
          <span
            className={`${styles.amount} ${isExpense ? styles.expense : styles.income} tnum`}
          >
            {formatMoney(sign(amounts.primary.minor), amounts.primary.currency, { locale })}
          </span>
          {/* The charged line is the only one that reconciles with the account,
              so it is plain visible text, never a hover. */}
          {amounts.secondary ? (
            <span className={`${styles.charged} tnum`}>
              {formatMoney(sign(amounts.secondary.minor), amounts.secondary.currency, {
                locale,
              })}
            </span>
          ) : null}
          {/* `!== 0`, and the sign is the FILE's: a fee is negative, a money-back
              positive, and an empty cell is a real zero worth not showing. */}
          {row.fee_minor !== 0 ? (
            <span className={`${styles.fee} tnum`}>
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
          aria-label={t('imports.decisionAria', { description: rowLabel })}
        >
          {DECISIONS.map((option) => {
            if (option.value === 'replace_own' && row.matched_tx_id === null) return null;
            const active = row.decision === option.value;
            return (
              <Button
                key={option.value}
                size="sm"
                variant={active ? 'primary' : 'secondary'}
                aria-pressed={active}
                disabled={readOnly || pending}
                onClick={() => onDecide(row.id, option.value)}
              >
                {t(option.key)}
              </Button>
            );
          })}
        </div>

        <Button
          size="sm"
          className={styles.category}
          aria-label={t('imports.categoryAria', { description: rowLabel })}
          disabled={readOnly || pending}
          onClick={() => onPickCategory(row)}
        >
          {categoryLabel}
        </Button>
        {/* Where a suggestion came from, said out loud: a category the user has
            not confirmed is the server's guess, and the guess names its source. */}
        {suggestionSource === null ? null : (
          <span className={styles.suggestionSource}>{t(SUGGESTION_KEY[suggestionSource])}</span>
        )}
        {/* The model's reason, verbatim and on its own line (it is a sentence,
            not a label): why THIS category was suggested, which is the only
            thing that makes an AI guess checkable. The confidence NUMBER is
            deliberately not rendered — see plan-web.md. */}
        {aiReason === null ? null : <span className={styles.aiReason}>{aiReason}</span>}

        {row.candidates.length > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            className={styles.candidatesToggle}
            aria-expanded={showCandidates}
            onClick={() => setShowCandidates((open) => !open)}
          >
            {showCandidates
              ? t('imports.hideMine')
              : t('imports.showMine', { count: row.candidates.length })}
          </Button>
        ) : null}
      </div>

      {showCandidates && row.candidates.length > 0 ? (
        <ul className={styles.candidates}>
          {row.candidates.map((candidate) => (
            <li key={candidate.id} className={styles.candidate}>
              <span className={`${styles.candidateDate} tnum`}>
                {formatApiDate(candidate.occurred_at, { locale })}
              </span>
              <span className={styles.candidateName}>
                {candidate.merchant ?? candidate.note ?? t('imports.candidateNoName')}
              </span>
              <span className="tnum">
                {formatMoney(
                  candidate.kind === 'expense' ? -candidate.amount_minor : candidate.amount_minor,
                  candidate.currency,
                  { locale },
                )}
              </span>
              {candidate.id === row.matched_tx_id ? (
                <Badge tone="accent">{t('imports.candidateBest')}</Badge>
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
