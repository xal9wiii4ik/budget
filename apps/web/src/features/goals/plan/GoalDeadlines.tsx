import { formatApiDate, formatMoney, todayApiDateUtc } from '@budget/shared';
import { useMemo } from 'react';
import { Link } from 'react-router';

import { QueryStateNotice } from '../../../components/QueryStateNotice';
import {
  GOAL_DEADLINE_DAYS,
  useGoalDeadlines,
  type UpcomingDeadlineRead,
} from '../../../data/goalDeadlines';
import {
  sortByAnchor,
  type DepositDeadlineRow,
} from '../../deposits/depositDeadlines';
import { useLocale, useT } from '../../../i18n/context';
import { queryPhase } from '../../../lib/queryPhase';
import styles from './GoalDeadlines.module.css';

interface GoalDeadlinesProps {
  /**
   * Deposits whose term ends inside the same horizon (deposits W1). They are
   * handed IN rather than read here: the caller already holds the deposits list
   * for the transfer-row name join, and the window is a pure date filter
   * (features/deposits/depositDeadlines.ts) — there is no `/deposits/upcoming`
   * endpoint and, per the architecture, deliberately so.
   */
  deposits: DepositDeadlineRow[];
}

/** What one line of the merged list is. The anchor is the date it is sorted by. */
type WidgetRow =
  | { kind: 'goal'; anchor: string | null; key: string; row: UpcomingDeadlineRead }
  | { kind: 'deposit'; anchor: string; key: string; row: DepositDeadlineRow };

// The row cap. Same shape as the upcoming-charges widget beside it: the head of
// an already-sorted server list, plus a count of what did not fit.
const MAX_ROWS = 5;

/**
 * "What's due soon in your plans" on /transactions (goal-planner W2).
 *
 * A deliberate copy of `features/recurring/UpcomingCharges` — same four query
 * arms, same fixed-height placeholders, same compact failure notice, same
 * hidden-while-the-list-is-narrowed rule (the CALLER applies it): two widgets
 * stacked on somebody else's screen must not each invent their own manners.
 *
 * Strictly read-only and strictly server-shaped: the rows arrive sorted and
 * windowed (plan.md §2), so nothing here sorts, filters, groups or totals. A
 * total would be cross-currency money arithmetic, which is why each row carries
 * its own currency instead.
 *
 * The BREADCRUMB comes from the server (Q5). Building it from the tree would
 * mean fetching every goal's plan just to render five lines — and "Hotel" with
 * no "Trip → Lodging" above it is unreadable on a screen that is not the plan.
 */
export function GoalDeadlines({ deposits }: GoalDeadlinesProps) {
  const t = useT();
  const query = useGoalDeadlines(GOAL_DEADLINE_DAYS);
  const phase = queryPhase(query);
  const goalItems = query.data?.items;

  // One list out of two sources, ordered by the date each row is ABOUT. The goal
  // rows arrive sorted and windowed from the server and the deposit rows are
  // sorted by the pure filter that produced them; the merge only interleaves
  // them (a stable sort, so a same-day pair keeps goals first).
  const entries = useMemo<WidgetRow[]>(
    () =>
      sortByAnchor<WidgetRow>([
        ...(goalItems ?? []).map((row) => ({
          kind: 'goal' as const,
          // The reminder when the item has one, else the effective deadline —
          // the same anchor the server sorted and windowed by.
          anchor: row.reminder_date ?? row.effective_deadline,
          key: `goal:${row.item_id}`,
          row,
        })),
        ...deposits.map((row) => ({
          kind: 'deposit' as const,
          anchor: row.termEnd,
          key: `deposit:${row.depositId}`,
          row,
        })),
      ]),
    [goalItems, deposits],
  );

  // TEMPORARY(B2-deploy): `null` is "this API predates the endpoint" (404 — see
  // data/goalDeadlines.ts). The widget then has nothing of its own to show — but
  // a deposit term is not the goals endpoint's business, so it still renders when
  // there are deposit rows.
  if (phase === 'ready' && query.data === null && deposits.length === 0) return null;

  const rows = entries.slice(0, MAX_ROWS);
  const hiddenCount = Math.max(entries.length - MAX_ROWS, 0);
  // UTC, because the SERVER decided these dates in UTC: a local-midnight compare
  // badges the wrong row for hours in any offset zone. Two "YYYY-MM-DD" strings
  // compare as dates, so nothing is parsed.
  const today = todayApiDateUtc();

  return (
    <section className={styles.card} aria-labelledby="deadlines-title">
      <h2 className={styles.title} id="deadlines-title">
        {t('deadlines.title')}
      </h2>

      {phase === 'loading' ? (
        // Fixed-height placeholders: the list below must not jump when they land.
        <ul className={styles.list} aria-hidden="true">
          <li className={styles.skeleton} />
          <li className={styles.skeleton} />
        </ul>
      ) : null}

      {phase === 'error' || phase === 'unreachable' ? (
        <QueryStateNotice
          phase={phase}
          message={t('goalDeadlines.loadFailed')}
          onRetry={() => {
            void query.refetch();
          }}
          compact
        />
      ) : null}

      {phase === 'ready' && rows.length === 0 ? (
        <p className={styles.empty}>
          {t('deadlines.emptyTitle')} {t('deadlines.emptyBody')}{' '}
          <Link className={styles.link} to="/goals">
            {t('goalDeadlines.manage')}
          </Link>
        </p>
      ) : null}

      {/* Not gated on `phase === 'ready'`: a deposit row comes from the deposits
          cache, so a failed goals request costs its own rows and the notice
          above — not the whole widget. */}
      {rows.length > 0 ? (
        <>
          <ul className={styles.list}>
            {rows.map((entry) =>
              entry.kind === 'deposit' ? (
                <DepositDeadlineLine key={entry.key} row={entry.row} today={today} />
              ) : (
                <GoalDeadlineLine key={entry.key} row={entry.row} today={today} />
              ),
            )}
          </ul>
          <p className={styles.footer}>
            {hiddenCount > 0 ? (
              <span>{t('goalDeadlines.more', { count: hiddenCount })} </span>
            ) : null}
            <Link className={styles.link} to="/goals">
              {t('goalDeadlines.manage')}
            </Link>
            {' · '}
            <Link className={styles.link} to="/deposits">
              {t('deadlines.openDeposits')}
            </Link>
          </p>
        </>
      ) : null}
    </section>
  );
}

/** One plan item's line — unchanged from goal-planner W2, only extracted. */
function GoalDeadlineLine({ row, today }: { row: UpcomingDeadlineRead; today: string }) {
  const locale = useLocale();
  const t = useT();
  // The date this row is ABOUT — the same anchor the server sorted and windowed
  // by: the reminder when the item has one, else the effective deadline
  // (plan.md §2). Both nullable on the contract; a row with neither cannot be in
  // the window, and if one ever arrives it keeps its name and amount instead of
  // vanishing.
  const anchor = row.reminder_date ?? row.effective_deadline;
  const isToday = anchor === today;
  // The deadline is only worth naming when the row is dated by a REMINDER that
  // falls earlier — otherwise the left column already shows it and the suffix
  // would repeat itself.
  const dueDate =
    row.reminder_date !== null &&
    row.effective_deadline !== null &&
    row.effective_deadline !== row.reminder_date
      ? row.effective_deadline
      : null;

  return (
    <li className={isToday ? `${styles.row} ${styles.rowToday}` : styles.row}>
      <span className={styles.when}>
        {anchor === null ? null : formatApiDate(anchor, { locale })}
        {isToday ? (
          // A text badge, not colour alone.
          <span className={styles.todayBadge}>{t('goalDeadlines.today')}</span>
        ) : null}
      </span>
      <span className={styles.what}>
        {/* Goal → ancestors → item, straight from the server. A goal name and an
            item name are USER text: never translated. */}
        <Link className={styles.goal} to={`/goals/${row.goal_id}`}>
          {row.goal_name}
        </Link>
        {row.breadcrumb.map((name, index) => (
          // The path carries no ids, and two siblings may legitimately share a
          // name — a crumb's identity IS its position, and this list never
          // reorders.
          <span className={styles.crumb} key={`${index}:${name}`}>
            {' → '}
            {name}
          </span>
        ))}
        <span className={styles.item}>
          {' → '}
          {row.item_name}
        </span>
        {/* The date on the left is the REMINDER when the item has one, which is
            days before the thing is actually due — so the deadline is named too
            instead of leaving the row looking early. */}
        {dueDate !== null ? (
          <span className={styles.crumb}>
            {' · '}
            {t('goalDeadlines.dueBy', { date: formatApiDate(dueDate, { locale }) })}
          </span>
        ) : null}
      </span>
      {/* The item's OWN amount in the item's OWN currency (never the goal's,
          never the base — AM-5). An item whose children hold the money has no
          amount of its own and shows none. */}
      {row.amount_minor !== null ? (
        <span className={styles.amount}>
          {formatMoney(row.amount_minor, row.currency, { locale })}
        </span>
      ) : null}
    </li>
  );
}

/**
 * One deposit's line (deposits W1): the day its term ends, its name, and the
 * BODY the server reports — no interest, no sum of the two, no conversion.
 *
 * The deposit's name is USER text and is never translated; the link goes to the
 * deposits screen, where the thing this row is about can actually be acted on
 * (moved back to an account, or closed).
 */
function DepositDeadlineLine({ row, today }: { row: DepositDeadlineRow; today: string }) {
  const locale = useLocale();
  const t = useT();
  const isToday = row.termEnd === today;

  return (
    <li className={isToday ? `${styles.row} ${styles.rowToday}` : styles.row}>
      <span className={styles.when}>
        {formatApiDate(row.termEnd, { locale })}
        {isToday ? <span className={styles.todayBadge}>{t('goalDeadlines.today')}</span> : null}
      </span>
      <span className={styles.what}>
        <Link className={styles.goal} to="/deposits">
          {row.name}
        </Link>
        <span className={styles.crumb}>
          {' · '}
          {t('deadlines.depositTerm')}
        </span>
      </span>
      <span className={styles.amount}>
        {formatMoney(row.balanceMinor, row.currency, { locale })}
      </span>
    </li>
  );
}
